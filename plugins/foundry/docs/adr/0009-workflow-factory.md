# ADR-0009: a Workflow factory: crews run as Workflow scripts, gates move into a deterministic CLI and a Workflow-call hook

Status: proposed, 2026-10-29. Written by the mid-run design slice `speed-design` (wave 1) of foundry session dd6ebfbb, for the foundry release after 0.10.0. It becomes accepted when the foreman merges `speed-design` under the owner-approved scope. Not repo ADR-0009.

VERDICT: change. The interface that can't take the work is the crew-start seam: `on('tool.call', { tool: 'Agent' })` in `plugins/foundry/hooks/register.ts:1641`, the single handler that holds the main-session model rule, the in-crew model and effort gates, the repair-budget gate, the plan gates (approval, wave, `maxParallelCrews`) and the `spawn` line. A Workflow script's `agent()` is not an Agent tool call, so none of it runs (probe, below). Running crews from Workflow needs a new seam: a deterministic CLI (`bin/factory.ts`) that applies the exported verdict functions that don't depend on `crewOf`, a hook on the main session's `Workflow` call, and a post-run audit of the Workflow transcripts. The checks keyed on `crewOf(callerId)` (`agentVerdict`, `effortVerdict`, the repair-budget gate) can't run on this path, because a workflow agent has no `foundry:lead` ancestor; the script makes every member, judge and red-team `agent()` call itself, and each of those checks is replaced by a named script rule, CLI check or audit (Decision 4, "What replaces the lead's gates"). Most of these are "the CLI and the audit check", not "a hook refuses". The plan file, the events file and the judge-file merge gate keep their shapes.

## Context

The owner, in decisions.md (frozen scope, item 6): "i have used /workflows and they are much faster. in this case i kind of want the factory to use workflow to expedite. the factory in itself is kind of a goal target. but its just painfully slow right now. and we need to make it way much faster. also stop asking for same question of sequential to main". The owner's rulings bind this design: no API runs in any suite; a model and an effort on every agent and every Workflow `agent()` (Sonnet for code, Opus for judgment, never Fable, no Opus at high or xhigh); merge sequential to main, standing; and the gates hold.

Today a crew is a `foundry:lead` started with the Agent tool. The lead reads, splits, starts each member, waits for its report, merges, runs the checks and starts the judge (`agents/lead.md` sections 3 to 9). Every hand-off between those steps is a model turn of the lead, and every hand-off between crews and waves is a model turn of the foreman (`skills/run/SKILL.md` sections 6 to 9).

## Measurements

Measured by crew member `speed-design-measure` from the raw logs of five run segments; full detail in `<git common dir>/foundry/dd6ebfbb-e054-4fae-9182-67b695ddbcbe/reports/speed-design/speed-design-measure.md` and its scratch tables (`crews.txt`, `brk.txt`, `tr.txt`, `ask.txt`). Segments: A = run dir `dd6ebfbb-e054-4fae-9182-67b695ddbcbe`, events.jsonl L1-43; B1 and B2 = `70917104-1578-48f5-8ac2-f9e48814b8cc` L1-60 and L61-95; C3 and C4 = `40816bb1-1ec8-4755-8d97-0d12599e1e84` L9-103 and L104-258. events.jsonl times are UTC; decisions.md times are local (UTC-4), minute resolution. Architect and cynic spans come from the first and last record of each subagent transcript (`~/.claude/projects/C--sw-claude-mods/<session>/subagents/agent-*.jsonl`), because events.jsonl doesn't log main-session architects or cynics. Owner waits come from AskUserQuestion tool_use to tool_result in the main transcript. A 600.0 min machine sleep in C3 (events L16 to L17) is excluded.

Measured wall: 848.1 min (A 121.0, B1 85.3, B2 70.7, C3 206.9, C4 364.2).

| Step | Minutes | Share | Source |
| --- | --- | --- | --- |
| Planning, architect rounds (13 rounds over 5 segments; A 7.4 / 9.7 / 11.5, C4 10.1 / 15.0 / 13.6 / 5.2) | 131.6 min | 15.5% | subagent transcripts, first to last record; A agent ids a8056994118e44f82, ac931894a572dd9ac, a275b370b6db59455 |
| Planning, cynic calls (10 calls; A 2.1 / 5.3) | 36.4 min | 4.3% | subagent transcripts; A a86c26549b4b03223, a8c87507a87e788c0 |
| Planning, waiting on the owner (A: one question, 19:53:01Z to 20:08:22Z, 15.3 min) | 45.4 min | 5.4% | main transcript A L368 |
| Planning, foreman gap (nothing running, not waiting on the owner; C4 33.7) | 53.4 min | 6.3% | C4: cynic-1 end 13:49:56Z to architect-2 start 14:22:59Z, decisions 10:16 |
| Planning total, run start to approval | 266.8 min | 31.5% | decisions.md run header and approval line per segment; A 19:42:11Z to 20:38:01Z = 55.8 min |
| Crew build, first-pass members | 156.9 min | 18.5% | events.jsonl spawn to first report, per member |
| Judge and red team, first round | 109.4 min | 12.9% | events.jsonl |
| Repair and red-team loops (C4 71.1: worktrees-cleanup 6 red-team rounds, foundry-protocol 5) | 125.6 min | 14.8% | C4 events L147-L230; C3 L72-L94 |
| Lead turnaround (lead alive, no member running; 84 gaps, mean 1.7 min, max 6.8) | 97.5 min | 11.5% | events.jsonl, report to next spawn within a crew |
| Merge wait and crews done but waiting to be resumed | 24.5 min | 2.9% | decisions.md merge lines; C3 protocol and readonly-guard queued 59.6 and 59.2 min behind hooks-gates |
| Foreman idle or unattributed after approval | 42.2 min | 5.0% | C4 22.8, incl. the e2e lead that ended its turn and was never woken: last member report 17:55:37Z, stall tag L238 18:11:45Z, repair lead 18:21:38Z |
| Owner wait after approval, cynic pre-merge reviews | 25.0 min | 2.9% | C4 L10525 (14.5 min repair question); B1, B2 cynic reviews |

The top sinks, in the order this design attacks them:

1. Serial architect and cynic rounds: 168.0 min. C3 and C4 each ran 3 or 4 architect rounds; C4's architect-3 ran 13.6 min writing about 670 lines of Python done-checks and was stopped by the owner (decisions 10:57). In A, the reconcile architect waited 15.3 min for an owner answer to a cynic finding before it could start.
2. Repair and red-team loops: 125.6 min wall. Red-team rounds have no bound: `agents/lead.md:64` says "After the fixes, run a fresh red team", and cynic-7 named that line as the root of C4's loops.
3. Foreman gaps and idle: 100.8 min (planning gap 53.4, idle 42.2, plus resume-pending time).
4. Lead turnaround: 97.5 min over 84 gaps, all segments.
5. Owner waits: 60.9 min inside the measured window. The merge-mode and target question was asked in 5 of 5 runs and answered "sequential to main" each time (main transcript A L533, B1 L491, B2 L1544, C3 L6579, C4 L8953); its bundled waits total 7.5 min, an upper bound, since it always rode inside the approval prompt.

Spot-checked by this architect against the logs: `dd6ebfbb/events.jsonl` line 1 is eval-design's lead spawn at 2026-10-29T20:39:10.008Z and line 9 its final report at 21:08:10.935Z, which is the 29.0 min wave-0 crew; `dd6ebfbb/decisions.md` line 1 is the run header `## Run 2026-10-29T19:42:11Z` and line 24 the approval with `approvedAt 2026-10-29T20:38:01Z`, which is the 55.8 min planning total for A.

What a script removes outright is waiting, not work: lead turnaround (97.5 min), foreman gaps and idle (100.8 min) and the planning waits that sat between rounds. Together that is 198.3 min, 23% of the measured wall. Bounding architect rounds to two and red-team rounds to the repair budget cuts into the next 293.6 min (sinks 1 and 2). The member and judge work itself (266.3 min) is not made shorter; it is run without gaps.

## Probe

Source: `<git common dir>/foundry/dd6ebfbb-e054-4fae-9182-67b695ddbcbe/probe-workflow.md`, Workflow run `wf_25508836-f05`, five `agent()` calls run by the foreman (subagents can't call Workflow). This architect read the run's files at `~/.claude/projects/C--sw-claude-mods/dd6ebfbb-e054-4fae-9182-67b695ddbcbe/subagents/workflows/wf_25508836-f05/`.

What Workflow can do for foundry:

- **`agent()` can be any foundry type, with an exact model and effort.** `agentType: "foundry:cynic"` with `model: "opus", effort: "low"` ran as foundry:cynic on claude-opus-5-5 at low; `foundry:lead` with sonnet, low ran as foundry:lead on claude-sonnet-5-5 at low. So a script can run architect, cynic, judge, red team, writer, builder and test-writer.
- **Worktree isolation works as the Agent tool's does.** `isolation: "worktree"` gave `.claude/worktrees/wf_25508836-f05-4` on branch `worktree-wf_25508836-f05-4` at the session's HEAD (fa0fa9f), sharing the git common dir. Without it an agent runs in the session cwd, which for this foreman is the foundry dir inside `.git`: no work tree.
- **The run leaves a machine-readable record.** `journal.jsonl` holds one `{"type":"started","key","agentId","label","phase"}` and one `{"type":"result","key","agentId","result"}` line per agent. Each `agent-<id>.meta.json` holds `agentType` and, only when the script set one, `model` (`agent-a3789c47e8d483cda.meta.json` has `"model":"opus"`; the no-model cynic's `agent-afbe368ff16694927.meta.json` has none). Each `agent-<id>.jsonl` transcript records the model the agent actually ran on (`"model":"claude-opus-5-5"`) and its effort (`"effort":"low"`). A CLI can audit a finished run from these files without any model.
- **`agent()` returns the agent's final text, or a schema-validated object** (workflow-authoring skill). The lead-at-cap result in `journal.jsonl` is its full `CHECKPOINT:` report text.

What breaks:

- **No spawn gate fires.** All of them live in `on('tool.call', { tool: 'Agent' })` (`register.ts:1641-1715`). The no-model cynic ran on the session model (Opus at medium; on a Fable session it would have been Fable). A lead started at the 4-crew cap. events.jsonl got no spawn line.
- **Report capture keys by raw agent id.** `classic.SubagentStop` (`register.ts:1816`) fired and wrote `reports/a5b5d3f425eea653f/`, because `crewOf` treats any `foundry:lead` as a crew lead named by its id. A non-lead workflow agent has no lead ancestor, so `crewOf` returns nothing and no report is saved at all.
- **Injected git status is not a fact.** The lead-at-cap agent reported another crew's branch from the session's git snapshot.
- **A workflow agent has no Agent and no Workflow tool** (probe 2, run `wf_455979bb-efb`: the default workflow subagent, `general-purpose` and `kit:builder`, whose definition says "All tools", each listed its own tools; all three have SendMessage and none has Agent or Workflow). So a workflow member can't start a nested helper that inherits the session model, and a `foundry:lead` run by `agent()` could not delegate to members. That `foundry:lead` has no Agent tool is inferred from `kit:builder`, not run. The gap that remains is the script's own `agent()` calls, which no hook sees.
- **A script has no file system, no shell and no clock** (`Date.now()` and argless `new Date()` throw). Every deterministic step it needs (plan checks, done-check runs, merges, patch ids, status edits, decision stamping) has to run as a command, and the script can only reach a command through an agent that has Bash.

Not verified by the probe, and handled below without relying on them: whether `tool.call` fires for the main session's own `Workflow` call (the hook in Decision 6 is the first place that would show it; the CLI and the audit hold the gates if it doesn't); whether `scriptPath` accepts a file inside the plugin (Decision 6 has a fallback); whether the Workflow call blocks the foreman's turn until the script returns (Decision 1, "start, stale runs", covers a run that dies either way); and what `agent()` returns when the agent ends with SubagentHandback rather than final text.

Not verified, outside those four: that a `foundry:lead` started by `agent()` has no Agent tool (inferred from `kit:builder`, probe 2); whether a SendMessage from a workflow agent reaches the foreman or a lead (probe 2 did not test it); whether Workflow accepts a script file that the CLI placed in the session's `workflows/scripts/` dir (the probe's script ran from there, but the harness wrote it); that agent transcripts are appended every turn while the agent runs (the stale rule's liveness check, "start, stale runs", relies on it).

What moves where:

| Step | Today | Here |
| --- | --- | --- |
| Plan checks (approval vs wave 0, disjoint `owns`, slug pattern, proved done-checks) | foreman reads the draft (`SKILL.md` section 4) | `factory.ts plan-check` |
| Plan files from the architect's report | hook plan-file route, Agent-tool architects only | `factory.ts plan-write`, same rules, from the Workflow journal |
| Wave, cap and approval gates, `status: running`, spawn line | hook on Agent; foreman edits `plan.json` | `factory.ts start`, using the exported `planVerdict` |
| Done-check runs, red and green | lead's Bash | `factory.ts check`, called from the script through a Sonnet runner |
| Merging member branches into the crew branch | lead's Bash | `factory.ts integrate` |
| Reports, spawn and report events, model audit | hook on SubagentStop and Agent | `factory.ts finish` (record step), from the journal and transcripts |
| Merge gate (newest judge file, PASS, no UNSCOPED, Head or Patch), merge, `status: merged` | foreman's Bash and Edit (`SKILL.md` section 9) | `factory.ts finish` (merge step), using the exported `judgeRuling`, `latestJudge`, `patchIdOf`, `PATCH_COMMAND`, and `mergeHeadVerdict`, a fail-closed wrapper around the exported `headVerdict` (Decision 1, "finish, merge step") |
| Decision lines | foreman's Edit, stamped by the hook | the CLI writes stamped lines itself with the exported `stampDecisions` and `localTime` |

## Decision

foundry gets a second crew engine. When the foreman's session has the Workflow tool, every crew that has no `devops` member and no owner-called `high` or `xhigh` effort runs as a Workflow script; all others, and every crew in a run without Workflow, run on the lead path as today. So does every crew of a `single`-mode run. The split is made per crew by `start` from the goal file's `## Engine` section (Decision 1, "start, engine split"). Lead-path crews are started and merged by the foreman as today, and `wave.js` and `finish` never see them. Planning runs as a Workflow script whenever Workflow is there. The parts:

```mermaid
flowchart TB
  fore["Foreman<br/>[main session: skills/run/SKILL.md]"]
  cli["factory CLI<br/>[script: bin/factory.ts, node]"]
  planwf["plan workflow<br/>[Workflow script: workflows/plan.js]"]
  wavewf["wave workflow<br/>[Workflow script: workflows/wave.js]"]
  roles[("roles table<br/>[workflows/roles.json]")]
  hook["Workflow gate<br/>[hook: hooks/register.ts]"]
  agents["Workflow agents<br/>[architect, cynic, planner, members, red team, judge, runner]"]
  wfrec[("journal.jsonl, agent-*.meta.json, agent-*.jsonl<br/>[Workflow transcript dir]")]
  fdir[("plan.json, decisions.md, events.jsonl, reports/<br/>[foundry dir]")]
  git[("crew branches, target<br/>[git]")]

  fore -->|"start, plan-args, settings: prints args JSON"| cli
  cli -->|"reads"| roles
  fore -->|"Workflow call with scriptPath and args"| hook
  hook -->|"lets through"| planwf
  hook -->|"lets through"| wavewf
  planwf -->|"agent() with role's model and effort"| agents
  wavewf -->|"agent() with role's model and effort"| agents
  agents -->|"runner runs check, integrate"| cli
  agents -.->|"recorded by the harness"| wfrec
  fore -->|"plan-write, finish"| cli
  cli -->|"reads results, models, efforts"| wfrec
  cli -->|"plan files, status, decision lines, spawn and report events, judge files"| fdir
  cli -->|"worktree add, merge, ff-only to target"| git
  hook -->|"reads plan, crew status"| fdir
```

*The Workflow engine's parts and what passes between them. Traces to: `plugins/foundry/hooks/register.ts:1641-1715` (the Agent gates it mirrors), `:327-349` (`planVerdict`), `:499-565` (`judgeRuling`, `patchIdOf`, `headVerdict`), `:848-904` (the plan-file route), and the probe run's `journal.jsonl` and `agent-*.meta.json`.*

```mermaid
sequenceDiagram
  participant F as Foreman
  participant C as factory.ts
  participant H as Workflow gate hook
  participant W as wave.js
  participant A as Workflow agents
  F->>C: start --wave next
  C->>C: planVerdict per crew, status running, worktree, spawn line
  C-->>F: args JSON
  F->>H: Workflow(scriptPath wave.js, args)
  H->>H: crews running and planVerdict clean, roles valid
  H-->>W: let through
  W->>A: runner: factory.ts check --expect red
  W->>A: planner: tasks
  W->>A: tester, then builders (worktree each)
  W->>A: runner: integrate, check --expect green
  W->>A: red team (if yes), judge
  W-->>F: per crew: passed or stopped
  F->>C: finish --transcript dir
  C->>C: record reports and events, audit models, merge gate, ff target, status merged
  C-->>F: merged, needs-rework, refused
```

*One wave, from start to merge. Traces to: `skills/run/SKILL.md` sections 6 and 9 (today's steps), `agents/lead.md` sections 1, 3, 6, 7, 9 and 12 (the chain wave.js runs), the probe's `journal.jsonl`.*

### 1. The factory CLI, `plugins/foundry/bin/factory.ts`

One file, run as `node <plugin>/bin/factory.ts <command> [flags]`, where `<plugin>` is the absolute plugin dir (`args.foundry.plugin` inside a script). No command depends on the caller's cwd when `--dir` and `--repo` are given, and the scripts and the foreman always give both, as absolute paths. This matters because a Workflow agent with no isolation runs in the session cwd, which for the foreman is the foundry dir inside `.git` (probe) (Node 22 strips the types, as the `tests/*.check.ts` files already rely on). It imports only Node built-ins and the exported functions of `../hooks/register.ts`, the hooks module's entry file, as `tests/contract-evals.check.ts:16` already does. Every command prints exactly one JSON object on one line to stdout and exits 0 when it did what was asked, 1 when a gate or an expectation refused, and 2 on a usage or I/O error (with `{"error": "<message>"}`). Every command is idempotent: run twice, it leaves the same state and prints the same result (core 7). The one exception is `check`, which adds a new record file each time it runs and never changes an old one.

The CLI is the only writer of a crew's `status` on the Workflow path. Statuses keep `plan.schema.json`'s four values: `planned`, `running`, `merged` and `dropped`. `start` moves a crew from `planned` to `running`, and `finish` moves it from `running` to `merged`. Neither command ever changes a crew that is `merged` or `dropped`, and neither restarts a `running` one except through `start --slug` (below). It never runs `git push`, never opens a PR, and never touches any remote.

Common flags: `--dir <foundry dir>` (absolute), `--repo <repo root>` (absolute; default the cwd's `git rev-parse --show-toplevel`).

| Command | Does | Prints |
| --- | --- | --- |
| `settings --repo R` | Reads `merge` and `target` from `R/.claude/foundry.json`. Missing `merge` is `sequential`; missing `target` is `git -C R branch --show-current`. | `{"merge":"sequential","target":"main","source":".claude/foundry.json"}`; `source` is `default` when neither key is set, `mixed` when one is. Keys in exactly this order. |
| `plan-args --dir D --repo R --brief-file B [--fix E] [--scripts-dir S]` | Builds the plan workflow's `args`: `{"foundry":{"kind":"plan","dir","repo","plugin","schema","architecture","maxParallelCrews","repairBudget","roles","scriptPath"},"brief":"<text of B>"}`. `plugin` is the absolute plugin dir, `schema` its `docs/plan.schema.json`, `roles` from `workflows/roles.json`. `scriptPath` is the file the foreman passes to `Workflow`: `<plugin>/workflows/plan.js`, or, with `--scripts-dir S` (an absolute dir), a byte-for-byte copy the CLI wrote to `S/foundry-plan.js` (Decision 6, "scriptPath fallback"). | the args object |
| `plan-write --dir D --transcript T --label L` | Takes the `result` of the agent labelled `L` from `T/journal.jsonl` (the last such line). Applies the plan-file route's rules exactly (`register.ts:879-904`): both fenced blocks present (`fencedBlock`, exported), `parsePlan` accepts the JSON, an existing approved plan is never overwritten; writes `plan.json` with `approvedAt: null` and `plan.md`. | `{"written":true}` or `{"written":false,"reason":"<the route's reason text>"}` (exit 1) |
| `plan-check --dir D` | Checks `D/plan.json`: `version` 2, `approval` is `owner` exactly when a wave-0 crew exists, each slug matches `^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$` and is not the reserved `foundry`, every crew `status` is `planned` on an unapproved plan, no two crews of one wave own a common path (two globs overlap when equal, or when the literal part of one before its first `*`, `?` or `[` is a prefix of the other's), and lists each crew with `doneCheckProved: false`. | `{"ok":true,"unproved":[...]}` or `{"ok":false,"errors":["<slug>: <rule>", ...]}` (exit 1) |
| `approve --dir D --by owner\|auto` | Sets `approvedAt` to now (`toISOString`, `Z` offset) and appends the stamped decision line `- HH:MM \| plan approved (<by>): merge <mode>, target <branch> from <source>; approvedAt <ts>; scope frozen \| ... \| none \| followed`. Refuses when `approvedAt` is already set. | `{"approvedAt":"..."}` |
| `start --dir D --repo R --wave <n\|next> [--type role=agentType ...] [--no-workflow] [--scripts-dir S]` | Picks the wave. `next` means the lowest wave that has any crew whose status is `planned` or `running`; `n` must be that same wave, otherwise `start` refuses. A `running` workflow crew that is stale (below) keeps that wave open, and `start` lists it under `stale` so the foreman restarts it with `--resume stale`; `start` never restarts it by itself. It considers only that wave's `planned` crews, in queue order. The free slots are `maxParallelCrews` minus the number of `running` crews in the plan, each counted once whatever its engine. `start` fills them in queue order and splits by engine ("start, engine split" below). For a workflow crew it: refuses the crew on `planVerdict`, with the hook's text; sets its `status` to `running`; creates the crew worktree `R/.claude/worktrees/foundry-<slug>` on branch `foundry-<slug>` from the target's head, or reuses it when the worktree is already there; appends `{"event":"spawn","crew":slug,"agent":slug,"agentId":null,"type":"workflow-crew","model":null,"effort":null,"by":"factory"}` and a decision line. It reads the goal file `D/goals/<slug>.md`'s `## Approved scope`, `## High-impact paths`, `## Red team` and `## Engine` sections. A `running` crew is never in a plain `--wave` result. | `{"foundry":{"kind":"wave","dir","repo","plugin","target","repairBudget","roles","scriptPath","crews":[<crew entry>]},"leads":[{"slug","reason"}],"refused":[{"slug","reason"}],"stale":[{"slug","since"}]}`. `scriptPath` is as in `plan-args`, for `wave.js`. A crew entry is `{"slug","wave","goalFile","goal","owns","doneCheck","highImpact","redTeam","scope","worktree","branch","base","architecture","adrs","resume","tasks","done","answers","spent","labelFrom"}`. `base` is defined once, below ("start, base"). On a fresh start, `resume` is `null`, `tasks` and `done` and `answers` are `[]`, `spent` is `0`, and `labelFrom` is `{}`. |
| `start --dir D --repo R --slug S --resume answers --transcript T --answers F` | Restarts one stopped workflow crew, which must be `running` and have a `by: "factory"` spawn line. `T` is the stopped wave.js run, and `F` is a JSON file `[{"at": "<task name or step>", "text": "<the answer>"}]` that the foreman writes from the owner's or its own ruling. From `T/journal.jsonl` it takes the crew planner's last accepted `tasks`, the `<slug>-planner*` result with the highest number. A task is in `done` when its member's result has `marker: "DONE"` and that member's `branch` is an ancestor of the crew branch (`git merge-base --is-ancestor`), so git decides, not a model's report. | The same object, with one crew entry: `resume: "answers"`, its `tasks`, `done` and `answers`, plus `spent` and `labelFrom` as below. |
| `start --dir D --repo R --slug S --resume merge-ready` | Restarts one workflow crew that `finish` sent back as `rework` with `why` `conflict` or `rejudge`, or that stopped at the scope or judge step. | One crew entry with `resume: "merge-ready"`; its `base` is the target head last merged into the crew branch ("start, base"). |
| `start --dir D --repo R --slug S --resume stale` | Restarts one workflow crew left `running` by a wave.js run that died ("start, stale runs"). It refuses a crew that is not stale: rule 1 or 2 failing gives `why: "not stale"`, and rule 3 failing gives `why: "run may be live"`. | One crew entry with `resume: "stale"`, its `tasks` and `done` rebuilt as for `--resume answers`, plus `spent` and `labelFrom`. |
| `sync --dir D --slug S` | In the crew worktree, runs `git merge <target>`, never a rebase. On a conflict it leaves the merge in progress. | `{"merged":true,"head":"<sha>"}` or `{"merged":false,"conflicts":["<path>", ...]}` (exit 1) |
| `check --dir D --slug S --cwd W --expect red\|green` | Runs the plan's `doneCheck` for `S` (from `plan.json`, never from the caller) with `bash -c` in `W`; records `D/checks/<S>-<n>.json` with the command, exit code, `git -C W rev-parse HEAD` and the last 40 lines of output. | `{"ok":<expectation met>,"exit":N,"head":"<sha>","tail":"..."}`; exit 1 when not met |
| `integrate --dir D --slug S --branch B` | In the crew worktree: `git merge --no-ff B`. On conflict, leaves the merge in progress. | `{"merged":true,"head":"<sha>"}` or `{"merged":false,"conflicts":["<path>", ...]}` (exit 1) |
| `owns-check --dir D --slug S` | `git diff --name-only <base>...HEAD` in the crew worktree against the crew's `owns` globs (`path.matchesGlob`). | `{"ok":true}` or `{"ok":false,"outside":[...]}` (exit 1) |
| `finish --dir D --repo R --transcript T [--result R]` | `R` is a JSON file holding the value `Workflow(wave.js)` returned, which the foreman saves. With `--result`: the record step, then the merge step, below. Without it (the Workflow call errored, or the session died, so there is no return value): the record step and the audit for run `T` only, nothing merged. For each crew that has a label in `T`, `finish` appends one `{"v":1,"ts":"...","event":"incomplete","crew":"<slug>","run":"<run id>"}` line to `events.jsonl` and lists the slug under `incomplete`. | `{"merged":[...],"rework":[{"slug","why"}],"blocked":[{"slug","why"}],"refused":[{"slug","why"}],"audit":[{"label","why"}],"incomplete":["<slug>", ...]}`; `incomplete` is `[]` with `--result` |

**start, engine split.** Each goal file carries a `## Engine` section, written by the foreman in `SKILL.md` section 6. Its first word is `workflow` or `lead`, followed by the reason when it is `lead`. The foreman writes `lead` when the crew has a `devops` member, or when the owner raised any of its members to `high` or `xhigh`; it writes `workflow` otherwise. `start` overrides the section to `lead` for every crew when `settings` gives `merge: single`, or when the foreman passes `--no-workflow` because its session has no Workflow tool. A goal file with no `## Engine` section is `lead`, so the default is today's behaviour. Then, in queue order within the cap:

- a `lead` crew goes to `leads` with its reason. `start` doesn't mark it `running`, doesn't make a worktree and writes no spawn line. The foreman starts its `foundry:lead` with the Agent tool and edits its `status` to `running`, both exactly as today, so the Agent hook's `planVerdict` still gates it. That status is how a later `start` knows the lead has started: only `planned` crews are ever returned. A lead crew that `start` returned but the foreman hasn't started yet is still `planned`, so running `start` again returns it again, which keeps `start` idempotent. The foreman merges a lead crew under `SKILL.md` section 9 as today, never through `finish`. Each returned lead crew takes one of this call's slots, and each `running` lead crew counts against the cap like any other, so `start` never puts more than `maxParallelCrews` crews in flight in all;
- a `workflow` crew goes to `foundry.crews`, as the row above says. Only these reach `wave.js`. Because `workflowRoleVerdict` refuses a `devops` role and `roles.json` has none, a deploy crew can't run as a script, even by mistake.

**start, budget and label numbering across runs.** A crew can run in several wave.js runs: a fresh start, then resumes. So `start` reads what earlier runs left in `D/reports/<slug>/` and passes two fields in every crew entry:

- `spent` is the crew's repair spend so far. It counts the crew's judge FAILs (`judgeFails`, exported) plus its red-team reports after the first one (`<slug>-redteam-2.md` and up).
- `labelFrom` maps each role to the next free number: `{"judge": 3}` when `<slug>-judge.md` and `<slug>-judge-2.md` exist.

wave.js counts from both. So a resumed run never reuses a label, `finish` never overwrites a report, and the budget is never reset by a resume. `finish` adds an `audit` entry, and writes nothing, when a report file it is about to write already exists with different text.

**start, base.** `<base>` is never a stored SHA that can go stale. Every command that needs it computes it in the crew worktree as `git merge-base <target> HEAD`, where `<target>` is the `settings` target. That is the target head last merged into the crew branch: the target's head at `start` until the first `sync` (step R1) or `finish` step 2 merges the target in, then the head of the latest such merge. It is the rule of `agents/lead.md:211` ("the target head last merged in"). `owns-check` diffs `<base>...HEAD` with that value, so after a `sync` it lists only the crew's own files and not other crews' merged files. The crew entry's `base` and the `base` that wave.js passes to the judge are this value at the time the entry is built, and the `base` in a `passed` result is the value at the judge step. A restart recomputes it, never reuses an old entry's.

**start, stale runs.** A `running` workflow crew whose wave.js run died (a session crash, a Workflow tool error, the foreman's turn ending mid-run) has no stopped result and would hold its wave open for ever. It is stale when all of these hold, each read from a file:

1. `plan.json` says `status: "running"` and `events.jsonl` has a `by: "factory"` spawn line for the crew;
2. no run holds one of the crew's labels, or the newest Workflow run that does is either not recorded (no `spawn` line with `by: "workflow:<run id>"`) or recorded with an `incomplete` line for that run id (`finish` without `--result`). The runs are the `T/../*/` dirs, and a label belongs to the crew by the parse in "Labels". When no run holds a label, because the run died before its first agent, this rule holds trivially. A run recorded without an `incomplete` line returned, and its restart is `--resume answers` or `--resume merge-ready`, never `--resume stale`;
3. liveness: the `ts` of the crew's `by: "factory"` spawn line and the newest mtime over that run's `journal.jsonl` and every `agent-*.jsonl` in it are all more than `STALE_MS` old, a constant in `factory.ts`: 15 minutes (900000 ms). A running agent appends to its own transcript every turn, and the longest single tool call it can make is the Bash tool's 10-minute maximum timeout, so 15 minutes with no write to any transcript means no agent of that run is live. The 15 minutes is a bound derived from that tool timeout, not a measurement. `journal.jsonl` alone is not enough: it changes only when an agent starts or returns, so a live run whose current agent works for more than 15 minutes would look stale.

`start --resume stale` on a crew where rule 3 does not hold refuses with `why: "run may be live"`. That refusal keeps a second wave.js run off a live crew. A crew recorded without `incomplete` is not stale: it stopped or went to `rework` or `blocked`, or it returned and awaits `finish --result`. A dead run's partial agents are recorded by `finish` without `--result`, which marks the run `incomplete` and merges nothing, so recording them does not block the restart. The foreman's procedure: when `Workflow(wave.js)` returns, it saves the value and runs `finish --transcript T --result R`. When the call errors, or after a session restart for a run that never returned, it runs `finish --transcript T` with no `--result`; then, once `start` lists the crew under `stale`, it runs `start --slug <s> --resume stale`, `Workflow(wave.js)`, and `finish --result`. `start --resume stale` restarts a stale crew in its existing worktree and on its existing branch, never from a clean base, so committed work stays: when the crew branch has no commit beyond `<base>`, `tasks` and `done` are empty and the chain runs from step 1; otherwise `tasks` is the `<slug>-planner*` result with the highest number in the dead run's `journal.jsonl`, and `done` is decided by git exactly as for `--resume answers` (the member's branch is an ancestor of the crew branch). Member branches the dead run never merged are left alone and are not merged. `spent` and `labelFrom` come from the reports on disk, so the budget is not reset and no label is reused. A stale restart passes every gate a fresh start passes: the Workflow gate re-applies `planVerdict` to the crew, and wave.js applies the same role rules, red-first rule and repair budget (Decision 4, "Restarts").

**Labels.** A Workflow agent's label is `<slug>-<role>` or `<slug>-<role>-<n>`, where `<n>` is 2 or more. Labels from the plan script use the reserved slug `foundry`, which `plan-check` refuses as a crew slug: `foundry-architect`, `foundry-architect-2`, `foundry-cynic`, `foundry-cynic-2`. A role key matches `^[a-z]+$`: no hyphen and no digit. `workflowRoleVerdict` refuses any other key. That makes the parse unique by construction:

1. Strip a trailing `-<n>` when the label has one. A slug never ends in `-<digits>`, and a role has no digit, so a trailing digit run can only be `<n>`.
2. The last `-` segment is the role.
3. Everything before that is the slug.

A crew label maps to exactly one `(slug, role, n)`, and two different crews can never make the same label. Crews `x` and `x-test` with roles `tester` and `writer` give `x-tester`, `x-writer`, `x-test-tester` and `x-test-writer`, all distinct. `x-test-writer` parses only as slug `x-test`, role `writer`. This is why the roles are named `planner` and `tester`, not `crew-planner` and `test-writer`. The hyphenated names could collide: under them, crew `x`'s `test-writer` and crew `x-test`'s `writer` both give `x-test-writer`. The agent type keeps its file name, `foundry:crew-planner`. A tester's commits still carry `Foundry-Role: test-writer`, the value `agents/lead.md:77` lists and `agents/judge.md:48` checks.

**finish, record step.** Each `started` line's label in `T/journal.jsonl` is parsed as above. The label belongs to a crew only when its slug exactly equals a crew that has a `by: "factory"` spawn line and status `running`, and its role is a key of `roles.json`. A label that fails to parse, or whose slug names no such crew, is filed nowhere and gets an `audit` entry. For each crew label: writes the agent's `result` text to `D/reports/<slug>/<label>.md` (a schema result is written as its `report` field), sets that file's mtime to the last timestamp in `T/agent-<id>.jsonl` (when the agent finished, so `latestJudge`'s newest-file rule orders judges truthfully), and appends a `spawn` line (`agentId`, `type` from the meta file's `agentType`, `model` and `effort` as the transcript records them, `by: "workflow:<run id>"`, the run id being `T`'s folder name) and a `report` line (`marker` from `markerOf`). It also audits each agent of the run, crew or not, and adds an `audit` entry when: the meta file has no `model`; the transcript's model family (`family`, exported) is not `opus` or `sonnet`; the effort is `max`, or `high` or `xhigh` on any role; a `-judge` or `-redteam` label ran as a type other than `foundry:judge`; or a `-judge` transcript has a `Write` or `Edit` tool use.

**finish, session audit.** The run's own transcript dir is not enough: a main-session Workflow call from any other script can start `foundry:*` agents that `finish` would never see. So `finish` also scans every Workflow run of this session, `T/../*/`, whose first transcript record is at or after the run start, the timestamp of the newest `## Run <ts>` header in `D/decisions.md` (not `approvedAt`, so `plan.js` runs and any ad hoc `foundry:*` run during planning are covered; with no such header, every run counts). A run is foundry's when every one of its labels parses (Labels, above) to the slug `foundry` or to a factory-started crew. A run is in scope when it is foundry's, or when any of its agents has an `agentType` starting with `foundry:`. Runs out of scope are not audited at all: an owner's own `/workflows` run with no foundry agent never blocks a merge. For each run in scope, `finish` adds an `audit` entry, labelled `<run id>/<label>`, for each agent that meets either condition:

- its `agentType` starts with `foundry:` and its run is not foundry's;
- its meta file has no `model`, or its transcript's model family is not `opus` or `sonnet`.

So a `foundry:*` agent anywhere in the session is still covered.

While any session-audit entry stands, `finish` merges nothing at all. Every crew of the wave is listed under `refused` with `why: "session audit"`, the entries go in a stamped decision line, and the foreman takes them to the owner. Rerunning `finish` after the owner rules gives the same result until the offending run is gone or the owner says to merge anyway, which the foreman records as a decision line that `finish` reads (`audit waived: <run id>`).

**finish, merge step**, crews in plan order, the gate of `SKILL.md` section 9 in code. Only `merge: sequential` is supported. When `settings` gives `single`, `start` puts every crew on the lead path (below) and `finish` refuses, with `{"error":"single merge mode runs on the lead path"}` and exit 2. `finish` only ever touches crews that have a `by: "factory"` spawn line; lead-path crews are merged by the foreman under `SKILL.md` section 9 exactly as today. For each such `running` crew that has a label in `T`, in plan order, whose newest judge file this run (`latestJudge`, since `approvedAt`) is a `judgeRuling` PASS with no UNSCOPED line:

1. Refuse when any `audit` entry names one of its agents, when events.jsonl has no `by: "factory"` spawn line for it, when `owns-check` fails, when `judgeFails` for it is more than `repairBudget` (a PASS after a spent budget doesn't count), or when the crew's lowest-numbered `D/checks/<slug>-<n>.json` is missing or has `exit` 0. That file is the red record: `check` wrote it, so the red-first rule rests on a file the CLI wrote and not on the runner's relay.
2. In the crew worktree, `git merge <target>` (never rebase), the same merge as `sync`. On a conflict, `finish` aborts the merge, so the crew worktree is clean again, and lists the crew under `rework` with `why: "conflict"`. The merge is redone later, in the wave.js step R1 of a `merge-ready` restart, where the resolver resolves it.
3. Compute `PATCH_COMMAND` with `<base>` the target head just merged in (`git merge-base <target> HEAD` after step 2, "start, base"), always, before comparing anything. Then, when HEAD equals the judge's `Head:` the PASS stands; otherwise when the patch equals the judge's `Patch:` and `check --expect green` passes on the merged head, the PASS stands. The rule is `mergeHeadVerdict(plan, judge, head, patch)`, defined in `factory.ts` and failing closed. The exported `headVerdict(plan, judge, head, patch)` (`register.ts:558-565`) is fail-open by design for the stop gate: it passes when `head` or `patch` is undefined, and it passes a plan below v2. `mergeHeadVerdict` takes the same `plan` argument and first refuses when `judge.head`, `judge.patch`, `head` or `patch` is undefined (an empty or failed `git diff`, so `patchIdOf` returns undefined), whatever the plan version. So the below-v2 pass of `headVerdict` never applies on this path. The patch is always computed and must be defined, even when HEAD equals the judge's `Head:`. Only then does it call `headVerdict` on the defined values. Such a crew goes under `refused` with `why: "patch id unavailable"` and is not merged. Any other mismatch is `rework` with `why: "rejudge"`.
4. Fast-forward the target. First, `git -C R worktree list --porcelain` finds the worktree, if any, that has `<target>` checked out.
   - The target is checked out and that tree is clean (`git -C <it> status --porcelain --untracked-files=no` is empty): `git -C <it> merge --ff-only foundry-<slug>`. "Dirty" means tracked changes only, so a stray untracked file in the owner's checkout doesn't block a merge; if the `--ff-only` merge fails for any reason, including an untracked file in its way, the crew is `rework` with `why: "target moved"` as below. TODO: the build's test should run a merge that an untracked file blocks, to confirm git's failure and the `why` text.
   - The target is checked out and that tree is dirty (tracked changes): nothing is touched. The crew goes under a new `blocked` list, `[{"slug","why":"target checked out dirty: <path>"}]`, and the foreman tells the owner. A crew under `blocked` stays `running`, and the next `finish` tries it again.
   - The target is checked out nowhere: `git -C R update-ref refs/heads/<target> <crew head> <old target head>`, a compare-and-swap that fails when the target moved.
   - Only a failed `--ff-only` or a failed compare-and-swap is `rework` with `why: "target moved"`.

   `git fetch . <src>:<target>` is never used, because git refuses it when the target is checked out anywhere.
5. Set `status` to `merged`, append the decision line, remove the crew's member worktrees whose branches are ancestors of the crew branch (`git merge-base --is-ancestor`), and remove the crew worktree.

Crews of a later wave are never touched by `finish`.

### 2. The roles table, `plugins/foundry/workflows/roles.json`

The one source of every Workflow agent's type, model, effort and isolation. `start` and `plan-args` copy it into `args.foundry.roles`; `--type role=agentType` replaces `agentType` only, for the roles marked `typeFromProject`, with the project agent the foreman picked in `SKILL.md` section 3 (default `general-purpose`).

| Role | agentType | model | effort | isolation | Notes |
| --- | --- | --- | --- | --- | --- |
| `architect` | `foundry:architect` | `opus` | `medium` | `worktree` | plan mode |
| `cynic` | `foundry:cynic` | `opus` | `medium` | none | |
| `planner` | `foundry:crew-planner` | `opus` | `medium` | none | read-only; reads the crew worktree by absolute path |
| `tester` | project, `typeFromProject` | `sonnet` | `medium` | `worktree` | |
| `builder` | project, `typeFromProject` | `sonnet` | `medium`, or `low` when the task says so | `worktree` | |
| `resolver` | project builder type | `sonnet` | `medium` | none | works in the crew worktree by absolute path; merge conflicts only; its commits carry `Foundry-Role: resolver` |
| `writer` | `foundry:writer` | `opus` | `medium` | `worktree` | |
| `rca` | `general-purpose` | `opus` | `medium` | none | writes no code |
| `redteam` | `foundry:judge` | `opus` | `medium` | `worktree` | brief opens `Red team:` |
| `judge` | `foundry:judge` | `opus` | `medium` | none | |
| `runner` | `general-purpose` | `sonnet` | `low` | none | runs one command the script writes out in full, `node <args.foundry.plugin>/bin/factory.ts <command> --dir <D> --repo <R> ...` with every path absolute, and returns its stdout and exit code; it never changes directory and never composes a command itself |

No `lead`, no `devops`, no `integrator`. A `foundry:lead` in a script would trip the lead stop gate and the raw-id report capture (probe), and it would have no Agent tool to delegate with (probe 2, inferred), so the table never holds one. `workflowRoleVerdict(roles)` (Decision 6) refuses a table with any model but `opus` or `sonnet`, any effort but `low` or `medium`, a missing model or effort, a `lead` or `devops` role, or a role key that doesn't match `^[a-z]+$` (Decision 1, "Labels").

### 3. The plan workflow, `plugins/foundry/workflows/plan.js`

Run by the foreman in place of `SKILL.md` section 4's architect and cynic calls, with `Workflow({ scriptPath: <args.foundry.scriptPath>, args: <plan-args output> })`, where `scriptPath` is `<plugin>/workflows/plan.js` unless the fallback of Decision 6 applies. Every `agent()` call in both scripts goes through one function, `spawn(role, label, prompt, opts)`, which takes `agentType`, `model`, `effort` and `isolation` from `args.foundry.roles[role]` and throws before calling `agent()` when the role is missing or fails the same rules as `workflowRoleVerdict`. No other `agent(` call exists in the file.

1. `foundry-architect`: `spawn('architect', ...)` with the brief from `args.brief`, its first line exactly `Mode: plan`, and the schema `{report: string, planJson: string, planMd: string}` (so the result doesn't depend on SubagentHandback inside a workflow, which the probe didn't test). The brief tells it the two blocks go in `planJson` and `planMd` as well as fenced in `report`.
2. `foundry-cynic`: the verdict review of `SKILL.md` section 4 ("Have a cynic review the verdicts"), with the architect's `planJson`, `planMd` and the architecture doc's path. The script reads every `REVIEW:` and `Owner:` line from its text.
3. When any `REVIEW: disagree`: one reconcile round, `foundry-architect-2` with the same brief plus the cynic's lines, then `foundry-cynic-2` told the reconcile round has happened. Never a third architect. No owner question stops the script: owner items are collected and returned.
4. Returns `{architectLabel, reviews: [...lines], owner: [...Owner lines that name a trigger], stillDisagree: bool}`.

Then the foreman runs `plan-write` with the returned label and `plan-check`. When `plan-check` fails, the foreman runs plan.js once more, as a new run. Its args come from `plan-args --fix <errors file>`, which adds the errors to `args.brief` and sets `args.foundry.fix: true`. A fix run starts one architect only, labelled `foundry-architect-3`, then one cynic, `foundry-cynic-3`, with no reconcile round. So planning never runs more than three architects in all, and it never relies on the Workflow cache. When `plan-check` fails a second time, the foreman sends the errors to the owner. `UNCOVERED:` lines in the architect's report make the script return `{uncovered: [...]}` before any cynic; the extend pass of `SKILL.md` section 4 runs as today.

### 4. The wave workflow, `plugins/foundry/workflows/wave.js`

Run by the foreman with `Workflow({ scriptPath: <args.foundry.scriptPath>, args: <start output> })`, where `scriptPath` is `<plugin>/workflows/wave.js` unless the fallback of Decision 6 applies. It runs every crew in `args.foundry.crews` at once (each crew is an independent chain, `pipeline()` style, no barrier between crews) and returns when every crew has passed or stopped. Labels follow Decision 1's "Labels" rule. The first agent of a role is `<slug>-<role>`. A further agent of the same role, such as a second builder or a fresh judge, is `<slug>-<role>-<n>`. Numbering starts at `labelFrom[role]` when that is set, and otherwise goes plain, then 2. A member's task name goes in its prompt and its result, never in its label. So `finish` files reports under today's names (`<slug>-judge-2.md`), parses every label back to one crew, and never overwrites a report from an earlier run. Each crew's chain, which is `agents/lead.md` sections 1 and 3 to 9 as code:

1. **Red first.** `runner`: `factory.ts check --expect red`. Not met: stop `BLOCKED:` with the output.
2. **Split.** `planner` (agent type `foundry:crew-planner`) with the goal file path, the crew worktree, owns, high-impact paths, approved scope, architecture doc and ADRs, and a schema: `{tasks: [{name, role: "tester"|"builder"|"writer", effort: "low"|"medium", files: [...], reads: [...], brief, after: [...names]}], stop: null | {tag: "QUESTION"|"BLOCKED"|"PROPOSAL", text}}`. The script checks, as plain code: every file matches the crew's `owns`; two tasks share a file only when one is in the other's `after` chain; every builder is `after` every tester; names are unique. One failed check sends the errors to a fresh `<slug>-planner-2`; a second failure stops `BLOCKED:`.
3. **Members.** Each task starts when the tasks in its `after` list are integrated. Its brief carries the job, `Approved scope:` (the goal file's section, verbatim), its files and reads, its check, the instruction to run `git merge <crew branch>` first, and these, verbatim: the "be brave" rule, the proof rule of `agents/lead.md` section 5, the fetch rule of `agents/lead.md:75`, the `Foundry-Crew: <slug>` and `Foundry-Role: <role>` trailer rule (role `tester` writes `Foundry-Role: test-writer`, the others their role key, so a resolver writes `Foundry-Role: resolver`), the line "you have no Agent tool; do the work yourself" (probe 2), and "commit on your branch and report the branch and commit". Its schema: `{task, marker: "DONE"|"CHECKPOINT"|"QUESTION"|"BLOCKED"|"PROPOSAL", branch, commit, proof, text}`, where `task` echoes the task name. The script overwrites `task` with the name it assigned, so a model can't change it. `DONE`: `runner` runs `integrate`, one integration at a time per crew; a conflict goes to `resolver`, then `integrate` again. `CHECKPOINT`: one fresh member from its text, then `BLOCKED:`. `QUESTION`, `BLOCKED`, `PROPOSAL`: the crew stops with that tag and text.
4. **Green.** `runner`: `check --expect green`. A failure runs the escalation ladder of `agents/lead.md` section 7 in code: two fix attempts by one fresh builder, then `rca`, then one fresh builder with its analysis, then `BLOCKED:` with the failing output.
5. **Red team**, when `redTeam` is true: `redteam` with the head SHA, crew branch, goal file, ADRs, high-impact paths. Each break goes to a fresh builder, then integrate, green, and a fresh red team. Every round after the crew's first red team adds 1 to the crew's spend, which starts from `spent` (Owner decisions, item 1). When the spend is more than `repairBudget`, the crew stops `BLOCKED: repair budget spent`, with the open breaks.
6. **Scope.** `runner`: `owns-check`. Files outside: stop `QUESTION:` asking the foreman for the extension.
7. **Judge.** `judge`, never a builder, with the goal file path, the crew worktree as checkout, the head SHA, the crew branch, the base, the diff command (`<base>...HEAD`, with `<base>` from "start, base"), the high-impact paths, architecture doc and ADRs, every member's `proof`, the red team's last report, and `Approved scope:` as its own field, plus the line that a `Foundry-Role: resolver` commit touching a done-check test file is a FAIL like a `builder` one (`agents/judge.md:48` names only `builder`; the brief carries the extension, so `judge.md` is unchanged); it states the SHA and patch id under `## Proof checked`. Its result's first line decides (`VERDICT: PASS` or `VERDICT: FAIL`, the `judgeRuling` rule, reimplemented in the script and pinned to the export by a test). No verdict line: one fresh judge, then `BLOCKED:`. FAIL adds 1 to the spend. When the spend, which starts from `spent` and counts this run's FAILs and extra red-team rounds, is more than `args.foundry.repairBudget`, stop with `BLOCKED: repair budget spent: <slug>, spend <n>, repairBudget <b>` and the findings; else a fresh builder with the findings, integrate, green, a fresh judge.
8. Returns `{slug, state: "passed", head, base, judge: "<label>"}` or `{slug, state: "stopped", tag, text, at}`. `at` is the task name when a member stopped. Otherwise it is one of `red`, `split`, `green`, `redteam`, `scope`, `judge`, `R1`.

**What replaces the lead's gates.** No `foundry:lead` runs in a Workflow crew, and none could delegate: a workflow agent has no Agent tool (probe 2). wave.js plays the lead's orchestration role and makes every member, judge and red-team `agent()` call itself, so a member never starts a nested helper. On the lead path three gates key on `crewOf(callerId)`, which finds a `foundry:lead` ancestor: `agentVerdict` and `effortVerdict` (`register.ts:264-279`), which refuse a member's Agent call without a model or an allowed effort, and the repair-budget gate, which refuses judge-named spawns after the budget. A workflow agent has no such ancestor, so none of the three can fire. The Workflow path enforces each as follows, and the enforcement is the script's, the CLI's and the audit's, not a hook's refusal:

- **Model and effort per `agent()`.** Every `agent()` call takes its `agentType`, `model`, `effort` and `isolation` from `roles.json` through `spawn()`, which throws before calling `agent()` when the role has no model or an effort outside `low` and `medium`. Before the run, `workflowRoleVerdict` checks the table: in `start` and `plan-args` (the CLI) and in the Workflow gate, if the hook fires. It carries the rule of `agentVerdict` and `effortVerdict` (model present, effort named, never `max`) and is stricter (only `opus` or `sonnet`, only `low` or `medium`); the CLI and hook don't call the two exports themselves, because both return undefined without a `crewOf` ancestor. After the run, `finish` reads each agent's real model and effort from its transcript and its meta file and refuses to merge on a miss (record step, audit). A script that skipped `spawn()` is caught only by this audit, after the tokens are spent.
- **Repair budget.** wave.js counts the spend from `spent` and stops the crew before it issues the next judge, red-team or fix-builder `agent()` call once the spend is more than `repairBudget` (steps 5 and 7). `finish` checks `judgeFails` against `repairBudget` before it merges (merge step, item 1). So the script holds the spend down, and `finish` refuses the merge if the script didn't.
- **Judge-named spawns.** The label and type rules (`-judge` and `-redteam` must run as `foundry:judge`, Decision 1, record step) are audit checks too.

**Restarts.** A crew entry's `resume` field picks the chain:

- `null`: steps 1 to 8 as above.
- `"stale"`: for a crew left `running` by a dead run ("start, stale runs"). It skips step 1 when `tasks` is not empty, since the crew already has commits. When `tasks` is empty, it runs from step 1, since the branch has no work. With `tasks`, it validates them as step 2 does, runs step 3 for the tasks not in `done`, and then runs steps 4 to 8 including the red team.
- `"answers"`: for a stop at `split` or at a task. It skips step 1, since the crew already has work and its check may be green. When the stop was at `split`, it re-runs step 2 with the `answers` added to the planner's brief. Otherwise it keeps `tasks` as given, re-runs the same validation as step 2, and runs step 3 for the tasks not in `done` only, each task's brief getting the `answers` entries whose `at` is that task's name. Then steps 4 to 8. A stop at `red` is never restarted: the foreman takes it to the owner as a done-check problem.
- `"merge-ready"`: for `finish`'s `rework` (`conflict` or `rejudge`) and for stops at `scope` or `judge`. Step R1: `runner` runs `sync`. On a conflict, `resolver` resolves it in the crew worktree and commits, and `runner` runs `sync` again, which must report `merged: true`; a second conflict stops `BLOCKED:` at `R1`. Then steps 4, 6, 7 and 8, with no red team, since its findings were fixed before. A stop at `scope` restarts only after the foreman has the owner's extension and has edited the crew's `owns` in `plan.json`; that is the one plan edit allowed mid-run, and it is logged like every frozen-scope ruling.

A restart is always a new wave.js run with one crew, never `resumeFromRunId`. The probe didn't check how the Workflow cache keys agents when `args` change, so nothing here relies on the cache. `spent` and `labelFrom` carry over what earlier runs did.

The script never merges into the target, never pushes, never deploys, and asks the owner nothing.

### 5. The crew planner, `plugins/foundry/agents/crew-planner.md`

A new read-only agent (`model: opus`, `effort: medium` in its front matter) whose only job is `agents/lead.md` sections 2 and 3 for one crew: the depth pass, then the split by the leaf test, returned in the schema above. It names the exact files, functions and line ranges each member reads, like the lead does. It carries the fetch rule word for word (ADR-0005 section 2), never names a sample domain (`tests/gates.check.ts:190-205` scans every `agents/*.md`), writes nothing, and starts no agent.

### 6. The Workflow gate, `plugins/foundry/hooks/register.ts`

Three additions, nothing else in the file changes:

- `export` on the existing `fencedBlock` (`register.ts:848`), for `plan-write`.
- Two pure exported functions. `workflowRoleVerdict(roles: unknown): { deny: string } | undefined`, the rules of Decision 2. `workflowCallVerdict(plan: Plan | undefined, input: { script?: unknown; scriptPath?: unknown; scriptText?: unknown; args?: unknown; pluginDir: string; pluginScriptTexts: readonly string[] }): { deny: string } | undefined`. Here `scriptText` is the inline `script`, or the text of the `scriptPath` file that the handler read (undefined when it can't be read), `pluginDir` is the absolute plugin dir the handler computes from its own module path, and `pluginScriptTexts` is the text of `<pluginDir>/workflows/plan.js` and `wave.js` as the handler read them. Call a script "foundry's" when the resolved `scriptPath`, with `\` turned into `/`, equals `<pluginDir>/workflows/plan.js` or `<pluginDir>/workflows/wave.js`, or when `scriptText` equals one of `pluginScriptTexts` byte for byte. The second test is the scriptPath fallback (below): a copy of the plugin's script is foundry's under any name or path, an inline script with that exact text is too, and a copy with any edit is not. The checks, in this order:
  - no plan, or a plan below version 2: undefined;
  - the script is not foundry's, and its text contains `foundry:`, or the `scriptPath` file can't be read: refused, "foundry agents run in a Workflow only from the plugin's plan.js and wave.js". This covers inline scripts and any other file, so no script outside the plugin can start a `foundry:*` agent with an inherited model while a run is on;
  - the script is not foundry's, and its text has no `foundry:`: undefined, since this is not a foundry workflow. Its agents are still covered by `finish`'s session audit for model family;
  - the script is foundry's and `args.foundry` is absent or not an object: refused;
  - `workflowRoleVerdict(args.foundry.roles)` refuses: that refusal;
  - `kind: "plan"` on a plan whose `approvedAt` is set: refused;
  - `kind: "wave"`: for each crew slug, refused unless its plan `status` is `running` and `planVerdict(plan, slug)` is undefined.
  Every refusal starts with `[foundry] Refused:`, like the others.
- One handler, `on('tool.call', { tool: 'Workflow' }, ...)`, placed right after the Agent handler (after `register.ts:1715`), for main-session calls only (`e.agentId === undefined`): reads the plan within `PLAN_READ_MS`, returns the verdict's deny or calls `next(e)`, logs each refusal with `logRule`, and fails open through `.catch(failOpen)` like every other handler.

**scriptPath fallback.** Whether `Workflow` accepts a `scriptPath` inside the plugin dir is not verified (Probe). If the first live call is refused for that reason, the foreman reruns `plan-args` or `start` with `--scripts-dir <the session's workflows/scripts dir>`, the dir the probe's script ran from (`~/.claude/projects/<project>/<session>/workflows/scripts/`). The CLI copies `plan.js` or `wave.js` there byte for byte as `foundry-plan.js` or `foundry-wave.js` and sets `args.foundry.scriptPath` to the copy. The gate still recognises it, by content: the copy's text equals the plugin file's, so `workflowCallVerdict` treats it as foundry's and applies every check below it (args, roles table, plan status, `planVerdict`). Whether Workflow accepts a file the CLI put in that dir, and not only one the harness wrote, is not verified; if it doesn't, the last fallback is the inline `script` parameter with the same text, which the same equality test accepts. If neither works, the Workflow engine can't run in that session and `start --no-workflow` puts every crew on the lead path (Decision 1, "start, engine split").

If the first live run shows `tool.call` doesn't fire for `Workflow`, nothing refuses a script before it runs. The model rule then holds after the run, not before it. `finish`'s session audit sees every Workflow run of the session that is in scope (Decision 1, "finish, session audit"). It flags a `foundry:*` agent in a run that isn't foundry's, and any agent of an in-scope run that has no explicit model or a model family other than opus or sonnet. While any such entry stands, `finish` refuses every merge, and the refusal goes to the owner in a decision line. So an agent on the wrong model can still run and spend tokens, but its work can't reach the target. The other gates still hold where they bite: `start` refuses, and the scripts' `spawn()` throws. The live run that checks whether the hook fires is the first item of "Not verified yet" for the arch-docs crew, and the `run-procedure` crew's SKILL.md text tells the foreman to log which of the two cases it saw.

### 7. The foreman's procedure, `plugins/foundry/skills/run/SKILL.md`

Edits limited to these places, so ADR-0008's and ADR-0010's builds can hook in at their named steps:

- **Section 4**, architect and cynic: when Workflow is available, replace the Agent calls, the marker-file `find` check and the send-back rounds with: write the brief to `<foundry dir>/plan-brief.md`, run `plan-args`, `Workflow(plan.js)`, `plan-write`, `plan-check`; resume once on a failed `plan-check`. The send-back reasons stay, now applied by `plan-check` and the cynic. The lead-path text stays for sessions without Workflow.
- **Section 5**, merge mode and target: delete "Ask the owner two more things" and its two bullets. In both kinds of run the foreman runs `factory.ts settings`, shows the result in the plan table as information, and logs it; it never asks the owner for merge mode or target. The owner's standing ruling is recorded where it stands across runs: the build adds `"merge": "sequential"` and `"target": "main"` to this repo's `.claude/foundry.json`, keys `foundry-config.schema.json:35-43` already defines. A run that needs `single` mode gets it only from that config key or an owner instruction in the run's own words, never from a question. A `single` run puts every crew on the lead path. `docs/foundry-config.schema.json`'s descriptions of `merge` and `target`, which today say "of auto-started runs", become "of every run; the foreman never asks". The README's config table changes the same way. Approval itself stays: the owner still approves a plan with a wave 0, and `approve --by owner` runs only after the owner's yes.
- **Section 6**, start: goal files gain a fixed `## Approved scope` section (the decision lines that bear on the crew, verbatim) a `## Red team` section whose first word is `yes` or `no`, and a `## Engine` section whose first word is `workflow` or `lead`, set by the rule in Decision 1 ("start, engine split"). `start` returns the crews under `leads`, which the foreman starts as leads and merges by this section's and section 9's lead-path text. For Workflow crews, replace the Agent lead call and the hand edits of `status` with `start`, `Workflow(wave.js)`, then `finish`; a stopped crew's tag is handled as in section 7. Once the foreman has the answer, it writes the answers file and runs `start --slug <s> --resume answers --transcript <the stopped run> --answers <file>`, then `Workflow(wave.js)` with that output, then `finish`. When `Workflow(wave.js)` returns, the foreman saves the value to a file `R` and runs `finish --transcript T --result R`. When the call errors, or after a session restart for a run that never returned, it runs `finish --transcript T` with no `--result` (recording the partial agents and the `incomplete` lines). Once `start` lists the crew under `stale`, it runs `start --slug <s> --resume stale`, then `Workflow(wave.js)` with that output, then `finish --result`; if `start --resume stale` refuses with `run may be live`, it waits and tries again. It logs the restart as a decision line. Repeat `start --wave next` until the last wave has merged: each call starts only `planned` crews, up to the free slots, and reports any stale crew that is holding the wave open.
- **Section 9**, merge: for Workflow crews the gate is `finish`; `rework: conflict` and `rework: rejudge` go back through `start --slug <s> --resume merge-ready` and a new `wave.js` run. That run's step R1 redoes `git merge <target>` through `sync`, and the resolver resolves any conflict, before green, scope and judge. A `blocked` crew (target checked out dirty) waits for the owner, and the foreman runs `finish` again after the owner's answer. The section's existing gate text stays as the lead path's rule, so `tests/gates.check.ts:68-83` keep passing.

### 8. What doesn't change

`docs/plan.schema.json` (no field is added: the engine follows from the crew's members, and `status` keeps its four values), `docs/events.schema.json` (`by: "factory"` and `by: "workflow:<run id>"` are strings it already allows), `agents/lead.md` (the lead path keeps it as is), `agents/judge.md` and `agents/architect.md` (their reports are read the same way), and the merge gate's rules. `agents/lead.md:77` lists the `Foundry-Role` values `test-writer`, `builder`, `writer`, `devops`, `redteam` and `architect`; the Workflow path adds `resolver` for the resolver of Decision 2. No build crew below owns `agents/lead.md` or `agents/judge.md`, so the new value is defined in the member and judge briefs that `wave.js` writes (Decision 4, steps 3 and 7), not in those files. TODO: if the owner wants `resolver` in the lead path's list too, `prompt-rules` (the crew that edits `agents/lead.md`) must carry it.

## Gates kept

| Gate | How it survives | What breaks if it didn't |
| --- | --- | --- |
| Judge never the builder | The judge is its own `spawn('judge')` with type `foundry:judge`; the crew-planner's schema can't assign `judge`; `finish` audits that `-judge` and `-redteam` labels ran as `foundry:judge` and that no judge transcript has a Write or Edit. Builders still may not edit the done-check tests, which the judge checks from the `Foundry-Role` trailers as today. | A builder could pass its own work. |
| Done-checks proved red | `wave.js` step 1 runs `check --expect red` before any member; the command comes from `plan.json`, not from the caller. `finish` refuses a merge when the crew's first `checks/<slug>-<n>.json` is missing or not red, so the check does not rest on the runner's relay. Plan time is unchanged: the architect proves each `doneCheck` and `plan-check` lists every `doneCheckProved: false`. | A crew could start on a check already green, and its PASS would prove nothing. |
| PASS bound to head and patch id | Judge files are written from the journal by `finish` with their real finish time, and the merge step runs `judgeRuling`, `latestJudge` and `mergeHeadVerdict` (the exported `headVerdict` behind a fail-closed guard, so an undefined head or patch id refuses the merge) with `PATCH_COMMAND`, the same exported code the lead stop gate uses; a Patch match counts only with `check --expect green` re-run on the merged head. | A PASS on one head could merge another. |
| Disjoint file ownership | `plan-check` refuses overlapping `owns` within a wave; `wave.js` refuses member tasks outside `owns` or sharing files without order; `finish` runs `owns-check` before every merge. | Two crews could edit one file in parallel and the later merge would silently win. |
| Explicit models, never Fable, no Opus at high or xhigh | Not the hook's `agentVerdict` and `effortVerdict`: those key on `crewOf(callerId)` and can't fire for a workflow agent (probe 2: no Agent tool, no nested spawns; probe: no gate sees the script's own `agent()`). Instead: one `roles.json`; `spawn()` throws on a role without model or effort (the script's own rule); `workflowRoleVerdict` refuses a bad roles table in `start`, `plan-args` and, if the hook fires, the Workflow gate; `finish` audits the model and effort each agent actually ran on from its transcript and refuses to merge a crew with any failure (the CLI and audit check, after the run). The hook refuses any main-session Workflow script that is not foundry's and names a `foundry:` type. `finish`'s session audit covers every Workflow run since the run start that is foundry's or has a `foundry:*` agent, and blocks all merges on a `foundry:*` agent outside foundry's runs, or on any agent of those runs that has no explicit model, even when the hook never fired. An unrelated run, with no foundry agent and no foundry labels, is ignored. The main session's own Agent calls keep `mainCallVerdict`. | A missed `model` inherits the session model (probe: Opus at medium; on a Fable session, Fable). What this design cannot do is stop such an agent before it runs: it blocks its work from the target. |
| Wave, cap and approval gates | `start` applies `planVerdict` before it marks a crew `running`; the Workflow gate re-applies it for every crew in `args`; `finish` merges only crews with a `by: "factory"` spawn line, so a crew that `start` didn't start can't merge through it. Lead-path crews keep the Agent hook's `planVerdict`, and `start` counts them against the cap. | A wave could start on unmerged code, or past `maxParallelCrews` (probe: a fifth lead at a cap of 4). |
| Repair budget | The lead path's budget gate keys on `crewOf` and can't fire here. `wave.js` stops with `BLOCKED: repair budget spent`, before it issues the next judge, red-team or fix `agent()` call, when the spend passes `repairBudget` (the script's rule); `finish` refuses a PASS that came after a spent budget (`judgeFails`). Effort is never raised to get past it. | Loops like C4's six red-team rounds (75.4 min wall) run without end. |
| Owner rules on frozen scope | `PROPOSAL:` and out-of-`owns` files stop the crew and go to the foreman, who takes them through the cynic and the owner as `SKILL.md` section 7 says. Scripts quote approved scope verbatim from the goal file. | A script could build past the scope the owner froze. |
| Production deploys | No `devops` role exists in `roles.json`, and `workflowRoleVerdict` refuses one; a crew with devops runs on the lead path, where `agents/lead.md:67` sends a production deploy to the owner first. | A script could deploy to production unasked. |
| Pushes and PRs | No `factory.ts` command touches a remote; `finish` only fast-forwards the local target. Pushes and PRs stay the foreman's, under `SKILL.md` section 10 and the owner's merge-ownership grant. | Work could leave the machine without the owner's say. |

Faster here means fewer waits between checked steps, not fewer checks. It does not mean every lead-path check runs unchanged. The checks keyed on `crewOf(callerId)` (`agentVerdict`, `effortVerdict`, the repair-budget gate) can't run for a workflow agent, and wave.js makes the member, judge and red-team calls itself, so the Workflow path swaps them for script rules, CLI checks and a transcript audit (Decision 4, "What replaces the lead's gates"); the rest of the table holds as written. Three checks run there in code that ran in prose before (the merge gate, the model audit, the owns check).

## Consequences

- Lead turnaround (97.5 min measured) and the foreman's per-step gaps after approval go away for Workflow crews: the script starts the next agent as the last returns. The member and judge work is the same work.
- Planning runs at most two architect rounds and two cynic calls with no foreman gap between them, and owner items from the cynic wait for the single approval prompt instead of blocking the reconcile round (A's 15.3 min).
- The merge-mode and target question is gone from every run.
- `/foundry` sees a Workflow crew's agents only after `finish` records them; while a wave runs, its progress is in `/workflows`. Stall and idle-lead prompts don't apply to Workflow crews: a stopped crew is a returned result, not a silent lead.
- Within a wave, a Workflow crew that passes early waits for the wave's script to return before it merges, and crews queued beyond `maxParallelCrews` start in the next `start --wave next`. Measured merge waits were 24.5 min in total; this design doesn't make them shorter for queued crews.
- Leads can't message each other mid-run on the Workflow path; a collision shows up at `integrate` or `finish` as `rework`.
- A model can still be wrong inside a script's runner: it relays a command's JSON. The merge doesn't rest on that relay: `finish` re-reads the judge files, recomputes the patch id with a fail-closed rule, re-runs the green check itself, and reads the CLI's own `checks/<slug>-<n>.json` for the red record.
- Two engines must stay in step. The CLI and the hook import the same verdict functions, and the script tests pin the script's copies (`judgeRuling`'s first-line rule, the role rules) against the exports.

## Seams to pin

The test-writers of the build crews pin these with `node --test` contract tests; no test calls a model, the Workflow tool or the owner.

- `factory.ts` commands, flags, one-line JSON output and exit codes (Decision 1), including these cases:
  - the engine split;
  - `start`'s status rules: `--wave next` picks the lowest wave with a `planned` or `running` crew; only `planned` crews start; `merged`, `dropped` and `running` crews are never re-marked; a returned lead stays `planned` until the foreman marks it; the cap counts each `running` crew once, whatever its engine;
  - `--resume answers`, `--resume merge-ready` and `--resume stale` entries; `stale` only for a `running` crew with a `by: "factory"` spawn line, a newest run that is unrecorded or recorded with an `incomplete` line, and a spawn line, journal and every agent transcript older than `STALE_MS`, and `start --wave next` listing it under `stale`; a restarted crew keeps its worktree and branch;
  - the stale rule's cases: a dead run with partial agents, after `finish` without `--result`, restarts; a live run with a recent agent-transcript write (journal old) refuses `--resume stale` with `why: "run may be live"`; a run recorded without an `incomplete` line is not stale; `finish` without `--result` merges nothing and lists the crews under `incomplete`;
  - `<base>`: `git merge-base <target> HEAD` equals the start head before a `sync`, and the merged target head after one, so `owns-check` lists none of another crew's merged files;
  - the fail-closed merge rule `mergeHeadVerdict(plan, judge, head, patch)`: a PASS with an undefined `head` or `patch` (empty diff, `patchIdOf` undefined) is refused, where the exported `headVerdict` passes it; a below-v2 plan with an undefined patch is refused too, including when HEAD equals the judge's `Head:`; plus a crew with no red `checks/<slug>-<n>.json` refused;
  - `--scripts-dir` copying `plan.js` and `wave.js` byte for byte and setting `scriptPath`;
  - `--resume answers` and `--resume merge-ready` entries, with `spent` and `labelFrom` carried from existing reports;
  - the label parse, with crews `x` and `x-test` and roles `tester` and `writer`: four distinct labels, and `x-test-writer` maps only to (`x-test`, `writer`);
  - `workflowRoleVerdict` refusing a role key with a hyphen or a digit;
  - the session audit: covering runs since the newest `## Run` header, plan.js runs included; blocking every merge on a `foundry:*` agent outside foundry's runs, and ignoring a run with no foundry agent and no foundry labels;
  - the target fast-forward: the target checked out and clean (an untracked file does not make it dirty), checked out and dirty with a tracked change (`blocked`), and checked out nowhere (compare-and-swap);
  - `single` mode's refusal.

  Pinned in `tests/factory.check.ts`, against temporary git repos and foundry dirs the test builds, and Workflow transcript fixtures in `tests/fixtures/workflow-run/` copied in shape from the probe's `journal.jsonl` and `agent-*.meta.json` (no model output beyond short strings).
- `workflowRoleVerdict`, `workflowCallVerdict` (including a byte-identical copy of `wave.js` at another path counting as foundry's, and an edited copy not) and the `fencedBlock` export: `tests/workflow-gate.check.ts`, importing `../hooks/register.ts`.
- `plan.js` and `wave.js` control flow: `tests/workflows.check.ts` loads each script's text, replaces its leading `export const meta` with `const meta`, and runs the body as an async function with stubbed `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` and `budget`. Each stubbed `agent()` returns a scripted result by label. The tests assert the call order and options: every call has `model` and `effort` from `args.foundry.roles`; no call is a `foundry:lead`; red check before any member; builders after testers; judge after green and red team; at most two architects; budget stop text counting from `spent`; labels numbered from `labelFrom`; `resume: "answers"` skipping the red check and the done tasks; `resume: "merge-ready"` starting with `sync`; stops returned, never answered. So the scripts have no `import` and use only those globals.
- `.claude/foundry.json` resolves to `{"merge":"sequential","target":"main","source":".claude/foundry.json"}` through `settings`: `tests/run-procedure.check.ts`.

## Owner decisions

1. **Red-team rounds share the repair budget.** Today a crew with a red team re-runs it after every fix with no limit (`agents/lead.md:64`); in C4 that was six rounds and 75.4 min on one crew. Proposed: on the Workflow path, every red-team round after the first counts against the run's `repairBudget` (default 2), the same budget as judge FAILs; when it runs out, the crew stops and you get the open breaks, as you do for a spent judge budget today. Recommended: yes. Saying no keeps red teams unbounded on the Workflow path too.
2. **The Workflow path is the default.** Proposed: whenever the session has the Workflow tool, crews run as Workflow scripts, except crews with a deploy member or with an effort you raised, which stay on today's lead path. The cost you see: while a wave runs you watch it in `/workflows`, and `/foundry` fills in each crew when the wave ends. Recommended: yes. Saying no makes it opt-in per run.

## Files touched

New:

- plugins/foundry/bin/factory.ts
- plugins/foundry/workflows/roles.json
- plugins/foundry/workflows/plan.js
- plugins/foundry/workflows/wave.js
- plugins/foundry/agents/crew-planner.md
- plugins/foundry/tests/factory.check.ts
- plugins/foundry/tests/fixtures/workflow-run/ (journal.jsonl, agent-*.meta.json, agent-*.jsonl fixtures)
- plugins/foundry/tests/workflow-gate.check.ts
- plugins/foundry/tests/workflows.check.ts
- plugins/foundry/tests/run-procedure.check.ts

Edited:

- plugins/foundry/hooks/register.ts (the `export` on `fencedBlock` at :848; `workflowRoleVerdict` and `workflowCallVerdict` next to `mainCallVerdict` at :567; one `on('tool.call', { tool: 'Workflow' })` handler after :1715)
- plugins/foundry/skills/run/SKILL.md (sections 4, 5, 6 and 9 as Decision 7 names)
- .claude/foundry.json (adds `"merge": "sequential"`, `"target": "main"`)
- plugins/foundry/docs/foundry-config.schema.json (the `merge` and `target` descriptions at :35-43 only: "of every run; the foreman never asks"; no key, type or enum changes)
- plugins/foundry/README.md (the Workflow engine, one section; the `merge` and `target` rows of the config table at :125-126)
- plugins/foundry/.claude-plugin/plugin.json (version bump)

Architecture-doc changes, made by the foreman's `arch-docs` design crew, not by any build crew below and not by this ADR (crews never edit the architecture doc, foundry ADR-0001 line 144). That crew runs once ADR-0008, ADR-0009 and ADR-0010 have all merged and applies all three in one pass. The sections ADR-0009 needs changed:

- plugins/foundry/docs/architecture.md, "Roles and who talks to whom": the crew-planner role, and Workflow crews that have no lead.
- plugins/foundry/docs/architecture.md, "The run lifecycle": the Workflow path of Decision 7 (plan.js, start, wave.js, finish), the lead path as the fallback, and merge mode and target read from config, never asked; with the two diagrams above.
- plugins/foundry/docs/architecture.md, "On disk": `checks/<slug>-<n>.json`, the `by: "factory"` and `by: "workflow:<run id>"` spawn lines, and report files written by `finish`.
- plugins/foundry/docs/architecture.md, "Hooks": a "Workflow calls" subsection next to "Agent calls" for the Workflow gate of Decision 6, and the `fencedBlock` export under its seams.
- plugins/foundry/docs/architecture.md, "Failing open" and "Not verified yet": the gate's fail-open, and the four unverified Workflow facts in Probe.
- docs/architecture.md, "Module map", the foundry table under `### foundry`: rows for `bin/factory.ts`, `workflows/` and `agents/crew-planner.md`, and the `.claude/foundry.json` row now carrying `merge` and `target` for this repo.

Existing tests that pin behaviour this design removes: none. A grep of `plugins/foundry/tests/` for `Merge mode`, `merge mode`, `Target branch`, `two more things`, `plan-mark`, `architect-plan`, `-newer` and `run_in_background` finds no match. Tests that pin text this design keeps, and that must stay green in the crew that edits the file: `tests/gates.check.ts:68-83` (section 9's merge rule: `Head: `, `Patch: `, `git patch-id --stable`, "newest judge file ... approvedAt", `UNSCOPED`, the re-run tie) in `run-procedure`; `tests/gates.check.ts:190-205` (no sample domain in any `agents/*.md`) in `factory-scripts`.

## Build crews

- workflow-gate | owns: plugins/foundry/hooks/register.ts, plugins/foundry/tests/workflow-gate.check.ts | doneCheck: node --test plugins/foundry/tests/workflow-gate.check.ts && node -e "import('./plugins/foundry/hooks/register.ts').then(m=>process.exit(typeof m.workflowCallVerdict==='function'&&typeof m.workflowRoleVerdict==='function'&&typeof m.fencedBlock==='function'?0:1))" | after: none
- factory-cli | owns: plugins/foundry/bin/factory.ts, plugins/foundry/workflows/roles.json, plugins/foundry/tests/factory.check.ts, plugins/foundry/tests/fixtures/workflow-run/** | doneCheck: node --test plugins/foundry/tests/factory.check.ts && node plugins/foundry/bin/factory.ts settings --repo . | grep -q '"merge":"sequential"' | after: workflow-gate
- factory-scripts | owns: plugins/foundry/workflows/plan.js, plugins/foundry/workflows/wave.js, plugins/foundry/agents/crew-planner.md, plugins/foundry/tests/workflows.check.ts | doneCheck: node --test plugins/foundry/tests/workflows.check.ts && test -f plugins/foundry/agents/crew-planner.md | after: prompt-rules, workflow-gate
- run-procedure | owns: plugins/foundry/skills/run/SKILL.md, .claude/foundry.json, plugins/foundry/docs/foundry-config.schema.json, plugins/foundry/README.md, plugins/foundry/.claude-plugin/plugin.json, plugins/foundry/tests/run-procedure.check.ts | doneCheck: node --test plugins/foundry/tests/run-procedure.check.ts && node plugins/foundry/bin/factory.ts settings --repo . | grep -q '"target":"main","source":".claude/foundry.json"' | after: prompt-rules, workflow-gate, factory-cli, factory-scripts

Crew notes:

- `workflow-gate` edits only the three places Decision 6 names in `register.ts`, a file ADR-0008's and ADR-0010's builds may also edit; the foreman sequences them. It keeps `claude plugin test plugins/foundry` green (435 pass on fa0fa9f).
- `factory-scripts` waits for `prompt-rules` because its member briefs and `crew-planner.md` copy the fetch rule and `agents/lead.md` sections 5 and 7, which `prompt-rules` may reword. Its test pins the scripts' role rules and first-line verdict rule against `workflowRoleVerdict` and `judgeRuling` from `register.ts`.
- `factory-cli` and `factory-scripts` can run in parallel: the scripts' tests stub the runner, and the CLI's JSON is pinned in Decision 1.
- `run-procedure` is the only crew that edits files `prompt-rules` edits (`skills/run/SKILL.md`, `plugins/foundry/README.md`, `.claude-plugin/plugin.json`); its version bump follows whatever `prompt-rules` set.
- How each done-check was proved: run from this crew's worktree at main (fa0fa9f), each exits 1 because its test file doesn't exist (`Could not find 'plugins/foundry/tests/<file>'`), and for `run-procedure` also because `bin/factory.ts` doesn't exist. Each passed, exit 0, on a hand-made sample under the session scratchpad (`samples/<crew>/`, never committed): a copy of the repo paths with a minimal test file and a minimal implementation of exactly what the second half of the command checks. The commands and outputs are in this crew's report.
