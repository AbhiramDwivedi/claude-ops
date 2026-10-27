# foundry architecture

foundry is three kinds of file. The protocol lives in prompts: the foreman's in `skills/run/SKILL.md`, and the six agent definitions in `agents/` (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`). The rules a prompt can't be trusted to keep live in one hooks module, `hooks/register.ts`, which `hooks/hooks.json` loads. `types/index.d.ts` declares the one value the module keeps in Claude Code's plugin state.

The prompts decide what agents should do. The hooks refuse the calls that break the chain of command, save reports to disk, and wake the foreman when something needs it.

Foundry 0.3.0 adds a design phase: an architect, principle packs, a plan file and waves. [ADR-0001](adr/0001-design-phase.md) decides it. The parts are `agents/architect.md`, the `skills/principles/` and `skills/init/` skills, and the plan gates in `hooks/register.ts`, which read `plan.json`. The plan file's contract is [`plan.schema.json`](plan.schema.json), with an example in [`plan.example.json`](plan.example.json).

Foundry 0.4.0 (proposed, foundry run 2) builds on kit and records what a run did. [ADR-0002](adr/0002-kit-manifest-and-config.md): foundry init reads kit's manifest, has kit declare `foundry:judge` and `foundry:cynic` read-only, and proposes the new `.claude/foundry.json` keys ([`foundry-config.schema.json`](foundry-config.schema.json)); crews take ports from worktrees' slots. [ADR-0003](adr/0003-event-log-and-retro.md): the hooks append `events.jsonl` ([`events.schema.json`](events.schema.json)), `decisions.md` gets a grammar, and `scripts/retro.py` with the `foundry:retro` skill counts both. Both apply the repo's extension rules, [repo ADR-0012](../../../docs/adr/0012-extension-framework.md). Until wave 1 of that run merges, the sections below marked 0.4.0 describe the design, not the code.

The container view below shows which part writes and which reads each stored file. Nodes marked 0.4.0 are designed, not built.

```mermaid
flowchart TB
  run["foundry:run<br/>[skill: skills/run/SKILL.md]<br/>Makes the main session the foreman"]
  init["foundry:init<br/>[skill: skills/init/SKILL.md]<br/>Checks the architecture doc"]
  arch["foundry:architect<br/>[agent: agents/architect.md]<br/>Writes the doc, ADRs and draft plan"]
  crew["Crew agents<br/>[agents: lead, judge, cynic, writer, devops]<br/>Do and check the work"]
  hooks["Hooks module<br/>[hooks/register.ts]<br/>Gates, report capture, wakes"]
  retro["retro, 0.4.0<br/>[scripts/retro.py, foundry:retro]<br/>Counts what a run did"]
  fjson[(".claude/foundry.json<br/>[project config]")]
  kitman[("kit's .claude/kit/manifest.json<br/>[kit's store, read from 0.4.0]")]
  plan[("plan.json, plan.md<br/>[foundry dir]")]
  dec[("decisions.md<br/>[foundry dir]")]
  events[("events.jsonl, 0.4.0<br/>[foundry dir]")]
  reports[("reports/, messages.jsonl<br/>[foundry dir]")]

  run -->|"Skill call when the doc is missing"| init
  init -->|"reads read-only declarations"| kitman
  init -->|"starts in init mode"| arch
  arch -->|"writes architecture, adr keys"| fjson
  fjson -->|"doc path, merge, target, caps; roles from 0.4.0"| run
  run -->|"starts in plan mode"| arch
  arch -->|"writes the draft"| plan
  run -->|"sets approvedAt, status"| plan
  run -->|"starts leads, by wave"| crew
  run -->|"writes decision lines"| dec
  crew -.->|"Agent, SendMessage, stops"| hooks
  hooks -->|"reads, gates lead starts"| plan
  hooks -->|"saves reports, logs lead messages"| reports
  hooks -->|"stamps HH:MM"| dec
  hooks -->|"appends spawn, stall, tag, report"| events
  retro -->|"reads"| events
  retro -->|"reads"| dec
```

*foundry's containers and the files between them.*
Traces to: `plugins/foundry/skills/run/SKILL.md`, `plugins/foundry/skills/init/SKILL.md`, `plugins/foundry/agents/architect.md`, `plugins/foundry/hooks/register.ts`, `plugins/foundry/docs/adr/0001-design-phase.md`, `plugins/foundry/docs/adr/0002-kit-manifest-and-config.md`, `plugins/foundry/docs/adr/0003-event-log-and-retro.md`, and the "On disk" section below.

## Roles and who talks to whom

The roles split into two diagrams: who the foreman talks to, and what happens inside one crew.

```mermaid
flowchart TD
  owner(["Owner<br/>[person]<br/>Approves, rules, pushes"])
  foreman["Foreman<br/>[main session]<br/>Plans, settles, merges"]
  cynic["Cynic<br/>[agent: foundry:cynic]<br/>Reviews items bound for the owner"]
  arch["Architect<br/>[agent: foundry:architect, 0.3.0]<br/>Drafts the plan"]
  integ["Integrator<br/>[agent, single mode]<br/>Merges every crew branch"]
  ijudge["Integration judge<br/>[agent, single mode]<br/>Rules on the integration branch"]
  leadA["Lead, crew A<br/>[agent: foundry:lead]"]
  leadB["Lead, crew B<br/>[agent: foundry:lead]"]
  disk[("foundry dir<br/>[store]")]

  owner <-->|"plan, rulings, push and PR"| foreman
  foreman -->|"items bound for the owner"| cynic
  cynic -->|"RECOMMEND lines"| foreman
  foreman -->|"start: plan mode, every run"| arch
  arch -.->|"draft plan.json, plan.md"| disk
  foreman -->|"start, answers, rebase requests"| leadA
  foreman -->|"start, answers, rebase requests"| leadB
  leadA -->|"QUESTION, BLOCKED, PROPOSAL, report"| foreman
  leadB -->|"QUESTION, BLOCKED, PROPOSAL, report"| foreman
  leadA <-->|"collisions only, logged"| leadB
  foreman -->|"start"| integ
  foreman -->|"start"| ijudge
```

*Who the foreman talks to: the owner, the agents outside every crew, and the leads.*
Traces to: `plugins/foundry/skills/run/SKILL.md`, `plugins/foundry/agents/lead.md`, `plugins/foundry/agents/cynic.md`, `plugins/foundry/agents/architect.md`, `plugins/foundry/hooks/register.ts`.

```mermaid
flowchart TD
  foreman["Foreman<br/>[main session]"]
  lead["Lead<br/>[agent: foundry:lead]<br/>Splits, delegates, merges members"]
  mem["Members<br/>[agents: builders, test-writer, writer, devops]<br/>Each in its own worktree"]
  judge["Judge<br/>[agent: foundry:judge]<br/>Rules PASS or FAIL"]
  red["Red team<br/>[agent: foundry:judge, red-team mode]<br/>Tries to break the work"]
  other["Another crew's lead<br/>[agent: foundry:lead]"]
  disk[("reports/crew/<br/>[foundry dir]")]

  foreman -->|"start, answers"| lead
  lead -->|"tagged messages, report"| foreman
  lead -->|"tasks"| mem
  mem -->|"reports with proof"| lead
  lead -->|"when the plan says yes"| red
  lead -->|"fresh judge per ruling"| judge
  lead <-->|"collisions only"| other
  mem -.->|"reports, saved by the hooks"| disk
  judge -.->|"judge file, the merge gate"| disk
```

*Inside one crew: the lead's members, its judge and red team, and where their reports land.*
Traces to: `plugins/foundry/agents/lead.md`, `plugins/foundry/agents/judge.md`, `plugins/foundry/hooks/register.ts`.

Only the foreman talks to the owner. Only leads message the foreman, so a member's question reaches the foreman through its lead. Leads message each other only when their work collides: a file another crew owns, a shared interface that changes, or the merge order. The hooks enforce the message rules for everything inside a crew (see [Hooks](#hooks)). The cynic, the integrator, the integration judge and (0.3.0) the architect in `plan` mode are started by the foreman, so they sit outside every crew. The hooks don't police them and don't save their reports.

| Agent | Started by | Model and effort | Edits files |
| --- | --- | --- | --- |
| Foreman | You, with `/foundry:run` | The session's | Only `decisions.md`, `plan.md`, goal files, and the fast-forward in `sequential` mode; from 0.3.0, `plan.json` and `plan.md` once the architect has drafted them: it sets `approvedAt` and each crew's `status`, and for a mid-run design slice adds the crew, moves its dependants a wave later and sets `ownerApproval` |
| Architect, 0.3.0 | `init`: the `foundry:init` skill, run by you as `/foundry:init` or by the foreman when a run finds no architecture doc. `plan`: the foreman, at the start of every run. `design`: the design crew's lead | Opus, `high` | Only the architecture doc and the ADR directory, plus `.claude/foundry.json` in `init` mode, `plan.json`, `plan.md` and `<foundry dir>/scratch/` in `plan` mode, and a contract artifact at a path the design crew owns in `design` mode; never source or tests |
| Cynic, `cynic-<n>` | Foreman, fresh for each batch | Opus, `high` | No |
| Lead, `<slug>` | Foreman, in the background, in a worktree | Opus, `medium` | Merges and rebases the crew branch; writes code only for conflicts and small fixes the checks demand |
| Members, named after their lead | Lead | Set on every call; Sonnet for mechanical work, Opus for judgment | Yes, each in its own worktree |
| Judge, `<crew>-judge`, then `-2`, `-3` | Lead | Opus, one level above the strongest builder, `high` to `xhigh` | No |
| Red team, `<crew>-redteam` | Lead, when the plan says yes | Opus, `high` | Only inside its own worktree and temp dirs; never commits |
| Integrator | Foreman, `single` mode | `general-purpose`, Opus, `high` | Yes, the integration branch |
| Integration judge | Foreman, `single` mode | Opus, `xhigh` | No |

The architect (0.3.0) is `agents/architect.md`. It loads the principle packs the work touches from the `skills/principles/` skill and runs in three modes ([ADR-0001](adr/0001-design-phase.md), sections 2 and 3):

- `init`: started by the `foundry:init` skill. Writes the project's architecture doc (principles, module map, ADRs for decisions already in the code) and `.claude/foundry.json`.
- `plan`: started by the foreman at the start of every run, outside every crew, like the cynic. For a goal, gives each touched module an `extend` or `change` verdict and splits the work into crews and waves by the leaf test, as a draft `plan.json` plus a readable `plan.md`. The foreman owns both files after that.
- `design`: a member of a design crew, in wave 0 or a mid-run slice, started by that crew's lead. Writes the ADR and architecture-doc change for each `change` verdict, and names the seams the crew's test-writer must pin with contract tests.

Its tools are Read, Grep, Glob, Bash (read-only git and read-only inspection, plus the done-check commands it proves and a schema validator fetched by `npx -y`, both in `plan` mode), Skill, and Write and Edit for the files in the table above. Crews never edit the architecture doc or ADRs; a design change they need goes to the foreman as `PROPOSAL:`, which the foreman can take up as a mid-run design slice (lifecycle step 8).

A crew, as the hooks see it, is a `foundry:lead` with no parent (the main thread started it) and every agent whose parent chain reaches it. A `foundry:lead` started by some other agent is not a crew.

## The run lifecycle

The 0.3.0 additions are marked. The diagram shows steps 4 to 11 for one crew; the numbered steps below it are the full story.

```mermaid
sequenceDiagram
  actor Owner
  participant F as Foreman
  participant A as Architect
  participant C as Cynic
  participant L as Lead
  participant M as Members
  participant J as Judge
  Owner->>F: /foundry:run with a goal
  F->>A: start in plan mode
  A-->>F: draft plan.json and plan.md (verdicts, crews, waves)
  F->>C: review the verdicts
  C-->>F: RECOMMEND lines
  alt approval owner, the plan has a wave 0
    F->>Owner: plan table with the ADRs, merge mode, target
    Owner-->>F: approve
    F->>F: set approvedAt
  else approval auto
    F->>F: log the plan, overwrite approvedAt
  end
  loop each wave, at most maxParallelCrews crews at once
    F->>L: start with goals/slug.md (the hooks check plan.json)
    L->>M: member tasks
    M-->>L: reports with proof
    L->>J: start a fresh judge
    J-->>L: VERDICT and Proof checked SHA
    L-->>F: final report
    F->>C: pre-merge review of the report and plan
    F->>F: merge on PASS whose SHA is the branch head
  end
  F->>Owner: end-of-run report, then ask before push and PR
```

*One run, from goal to merge, for a single crew per wave.*
Traces to: `plugins/foundry/skills/run/SKILL.md`, `plugins/foundry/agents/architect.md`, `plugins/foundry/agents/lead.md`, `plugins/foundry/agents/judge.md`, `plugins/foundry/docs/adr/0001-design-phase.md` (sections 3, 6 and 9).

0. Init (0.3.0): When a run finds no architecture doc, the foreman runs the `foundry:init` skill, which starts the architect in `init` mode; the owner can also run `/foundry:init`. If the repo already has an architecture doc of its own, `init` extends it rather than replacing it; otherwise it writes `docs/architecture.md`, with ADRs in `docs/adr/`. It records the doc's path in `.claude/foundry.json`. From 0.4.0, init then reads kit's manifest, runs `kit:init` when it is missing and kit is installed, and proposes the new `foundry.json` keys ([ADR-0002](adr/0002-kit-manifest-and-config.md)).
1. Altitude: The foreman asks the owner once whether the goal is the end or a step toward a bigger outcome, and describes the bigger version.
2. Depth pass: The foreman answers four questions (what a top practitioner would add, the rawest material, the practitioner's tools, what besides a model verifies the result). The answers decide which crews exist.
3. Inventory: The foreman lists the agent types and skills the session can use. From 0.4.0 it starts from `roles` in `.claude/foundry.json`, where set.
4. Split: Crews own disjoint files, each with a done-check it can't game, its high-impact paths, a red team yes or no, and a resource slice (port range, database or temp directory). From 0.3.0, the foreman starts the architect in `plan` mode for this, at the start of every run. It gives one verdict per touched module, `extend` by default, splits the work into crews and waves by the leaf test, runs each crew's done-check once to prove it, and estimates agents per crew. A plan whose total is over `agentCap` is re-planned with fewer, larger crews or more waves before anyone sees it. The architect drafts `plan.json` and `plan.md`; the foreman owns both after that. A cynic reviews the verdicts on its own; if the two disagree, the architect gets one round to reconcile. The owner is asked only when they still disagree, or a change breaks a declared principle, adds an external service or recurring cost, or changes a stored data shape in a way that's hard to undo. `plan.json` has no fields for a crew's high-impact paths, red team or resource slice, which the 0.2.1 foreman sets in its plan table and each lead's brief (`skills/run/SKILL.md`); ADR-0001 doesn't say who sets them from 0.3.0. From 0.4.0 the slice names no invented port range: a crew uses its worktree slot's `PORT_BASE` when the repo has a `.claude/worktree-setup.*`, and the plan says `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)` when it hasn't ([ADR-0002](adr/0002-kit-manifest-and-config.md), section 4).
5. Approval and freeze: The foreman shows the plan table and asks for the merge mode and target branch. On approval it writes `plan.md`. From here the scope is frozen, and only the owner can change it. From 0.3.0, the pause depends on the plan. An extend-only run, with no wave 0, doesn't pause: the architect's draft sets `approval: "auto"`, and the foreman logs the plan, overwrites `approvedAt` with its own log time, and starts the crews without asking. Its merge mode and target come from `.claude/foundry.json` (`merge`, `target`); without them the merge mode is `sequential` and the target is the current branch, and the foreman logs which it used. The owner sees the plan in the end-of-run report. A run with a wave 0 gets `approval: "owner"` and `approvedAt: null` from the architect's draft: the foreman checks it, shows the plan table with the ADRs, asks for the merge mode and target as in 0.2.1, and sets `approvedAt` when the owner approves. Later waves start as earlier ones merge, with no further pause. `approvedAt` is null only while a run waits for the owner. In either case, questions still reach the owner through the cynic's escalation rules.
6. Leads start: The foreman writes `goals/<slug>.md` for each crew and starts all leads in one message. From 0.3.0, leads start by wave. Wave 0 holds the `change` work (ADRs, the architecture-doc change, the contract tests) and merges before any other wave starts; each wave merges before the next starts. Within a wave, at most `maxParallelCrews` crews run at once; the rest queue and start as running ones merge. The queue order is the order of the `crews` array within the wave. The foreman sets each crew's `status` in `plan.json` as it starts and merges.
7. Inside each crew: The lead runs its checks to prove its environment works, runs a full depth pass, splits the work into member tasks, and delegates. Members report with proof. The lead merges the members' branches with `git merge --no-ff`, runs the checks, then runs the red team (when there is one) and a fresh judge. Before the judge it compares its diff with the files it owns and asks the foreman for any extension. Every member commit carries `Foundry-Crew: <slug>` and `Foundry-Role: <role>` trailers. The judge reads the role with `git log --format='%H %(trailers:key=Foundry-Role,valueonly)'` and fails the crew if a `builder` commit touched the done-check tests. A file outside the crew's ownership is a `QUESTION:` for the foreman in the judge's findings, not a FAIL by itself. From 0.3.0, the judge also asks whether the diff conforms to the architecture doc's principles and module map, and to the run's ADRs. A violation that doesn't affect the done-check is a QUESTION. One that breaks a declared principle is a FAIL.
8. Messages: Leads send the foreman `QUESTION:`, `BLOCKED:` or `PROPOSAL:`. The foreman settles what it can and logs it. Items for the owner go through a cynic first. From 0.3.0, when the foreman takes up a design proposal, it runs a mid-run design slice. It adds a design crew (`verdict: "design"`) to the earliest wave that hasn't started yet, and moves only the crews that depend on the slice, and haven't started, one wave later; running crews and crews that don't depend on it keep their wave. The run-level `approval` and `approvedAt` don't change. The slice waits for the owner only when one of the owner triggers in step 4 applies: the foreman then sets the crew's `ownerApproval` to `"pending"`, and to `"approved"` when the owner answers. Otherwise the slice starts like any crew.
9. Pre-merge review: A cynic reads each crew's final report and the plan, and checks for drift and overlap between crews.
10. Judge-gated merge: The foreman reads the crew's highest-numbered judge file itself and merges only on `VERDICT: PASS` whose `## Proof checked` SHA matches the crew branch head. In `sequential` mode each lead rebases onto the target in turn, a fresh judge rules if the head moved, and the foreman fast-forwards. In `single` mode an integrator merges every crew branch into `foundry-<short goal>` and an integration judge rules on it.
11. End-of-run report: Crew summaries and what merged where, checks and verdicts, decisions and cynic overrules, deferred items, and the high-impact files that changed. The foreman then asks before every push and PR, unless the project grants it merge ownership. Production deploys always go to the owner.

## On disk

Everything for a session lives under one folder:

```
<git common dir>/foundry/<session id>/
  decisions.md               foreman: one line per decision, `- HH:MM | decision | reason | cynic | followed`
                             (0.4.0: a `## Run <start> | <goal>` heading per run; grammar below)
  events.jsonl               0.4.0, plugin: one line per spawn, stall, tag and final report
  events.<n>.jsonl           0.4.0, plugin: the event log rolled over, past 3 MiB
  plan.md                    foreman: the approved plan, written once the owner approves
                             (0.3.0: the architect drafts it with plan.json; the foreman owns it after that)
  plan.json                  0.3.0: the architect drafts it; the foreman owns it after that; hooks only read it
  goals/<slug>.md            foreman: each crew's goal, done-check, owned files, high-impact paths
  reports/<crew>/<agent>.md  plugin: each crew agent's last report, judges' included
  reports/<crew>/<agent>.interim.md  plugin: a lead's interim stop
  messages.jsonl             plugin: lead-to-lead messages
  messages.<n>.jsonl         plugin: the log rolled over, past 3 MiB
```

The plugin writes only `reports/`, the message logs and (0.4.0) the event logs. The foreman writes `decisions.md`, `plan.md` and `goals/`, as `skills/run/SKILL.md` tells it to; the plugin only stamps the time on new `decisions.md` lines (see Decision times).

The folder is `git rev-parse --path-format=absolute --git-common-dir` run in the session's working directory, plus `foundry/<session id>`. Every worktree of a repo shares one git common dir, so all crews write to the same place. Outside git the base is `$HOME/.claude` (or `%USERPROFILE%\.claude`). The path is worked out once per session and cached; a `/clear` works it out again. Session ids, crew names and agent names pass through `safeName` in `register.ts`: each run of characters other than letters, digits, `.`, `_` and `-`, and each run of two or more dots, becomes `-`; runs of `-` collapse to one; leading and trailing `-` and `.` are dropped; the result is cut to 100 characters, and an empty result becomes `agent`.

A report file is named after the agent's spawn name, else its id, under its crew's folder. A judge's report is `reports/<crew>/<crew>-judge.md`, then `<crew>-judge-2.md` and so on; those are the merge-gate files. A red team is named `<crew>-redteam` so its report never lands on one. A successor lead `<slug>-2` is a crew of its own as far as the hooks go, with its own folder.

Each line of `messages.jsonl` is `{ "ts", "from", "to", "summary" }`, where `from` and `to` are crew names and `summary` is the `SendMessage` summary. Only messages between two leads of different crews are logged. When the log is 3 MiB or more, the next append first copies it to `messages.<n>.jsonl` at the first free `n` and starts a new log.

### `events.jsonl` (0.4.0)

Each line is one JSON object under [`events.schema.json`](events.schema.json): `{ "v": 1, "ts", "event", "crew", "agent" }` plus the event's own fields. `spawn` (a crew agent's or a lead's `Agent` call that went through) adds `agentId`, `type`, `model`, `effort` and `by`; `stall` (a stall or idle-lead wake) adds `kind` and `minutes`; `tag` (a lead's tagged message to `main`) adds `tag`; `report` (a final report saved) adds `marker`, the report's leading marker or null. No line holds message, prompt or report text. Appends are serialized like the message log's and roll at 3 MiB the same way; a failed append is logged and changes nothing else ([ADR-0003](adr/0003-event-log-and-retro.md), section 1).

### `decisions.md` grammar (0.4.0)

```
# <optional title>
## Run <RFC 3339 start> | <goal>
- HH:MM | <decision> | <reason> | <cynic> | <outcome>
- HH:MM | cynic-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>
  <two-space continuation>
```

`<outcome>` is `followed`, `followed (deferred)` or `overruled: <reason>`. One `## Run` heading per run lets `scripts/retro.py` split a session dir that holds several runs; without headings it reports the split as `"not recorded"`. retro also reads the older shapes (date-stamped lines, free-form lines, a literal `HH:MM`) and says `"not recorded"` for what they lack ([ADR-0003](adr/0003-event-log-and-retro.md), sections 2 and 3).

### `plan.json`

`plan.json` (0.3.0) is the seam between the architect, the foreman and the hooks: the goal, the architecture doc's path, `approval`, `approvedAt`, `agentCap`, `maxParallelCrews`, and one entry per crew with its wave, verdict, modules, owned paths, done-check, whether that check was proved, estimated agents, an optional `ownerApproval` and status. [`plan.schema.json`](plan.schema.json) is the contract; [ADR-0001](adr/0001-design-phase.md), section 8, is the source. The rules it adds:

- `approval` (`auto` or `owner`) is set once, at plan time. It's `owner` exactly when the plan has a wave-0 crew; mid-run slices never change it.
- `approvedAt` is null only while a run waits for the owner, so an `auto` run always has it. Otherwise it is an RFC 3339 date-time with a time-zone offset, such as `2026-10-26T14:03:00+01:00` or `2026-10-26T13:03:00Z`.
- `verdict`: `design` is a crew that writes ADRs and contract tests; `change` is a build crew whose module's design changed, so it runs after the design crew; `extend` is a build crew working inside the existing design.
- `ownerApproval` (`pending` or `approved`) is set only on mid-run design slices that wait for the owner.
- Within a wave, the order of the `crews` array is the queue order.
- The agent total is the sum of `estAgents`, so it isn't stored.
- `version` goes up whenever a field is added; the schema allows no other properties.

Validating a plan against the schema checks these constraints of its own:

- Every top-level field and every crew field is required, except `ownerApproval`; `version` is `1`; no other properties are allowed, at either level.
- `approval: "owner"` needs at least one crew in wave 0, and `approval: "auto"` needs `approvedAt` to be a string.
- `approvedAt` is null or a JSON Schema `date-time`: RFC 3339 with an offset. The format is checked only by a validator that asserts formats, such as `ajv` with `ajv-formats`.
- Wave 0 holds only `design` crews: a crew with `wave: 0` must have `verdict: "design"`. A design crew may still sit in a later wave.
- `ownerApproval` may appear only on a `design` crew.
- `slug` matches `^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 100 characters: lowercase words joined by single hyphens, never ending in `-<digits>`, since a successor lead is named `<slug>-<n>` and the hooks gate it as its base slug.
- `crews`, and each crew's `modules` and `owns`, hold at least one item; `modules` and `owns` items are unique non-empty strings.
- `wave` is an integer of 0 or more; `agentCap`, `maxParallelCrews` and `estAgents` are integers of 1 or more; `goal`, `architecture` and `doneCheck` are non-empty strings.

One file lives in the project repo, not the foundry folder:

```
<repo>/.claude/foundry.json  0.3.0: the project's foundry config
```

`init` writes `architecture` and `adr`; from 0.4.0 it also proposes `roles`, `deploy`, `writingSkill` and `promptOverrides`, and writes those the owner approves. The owner can add any key by hand; each but the first two has a default. The contract is [`foundry-config.schema.json`](foundry-config.schema.json) ([ADR-0002](adr/0002-kit-manifest-and-config.md)); a key it doesn't declare is reported and ignored:

| Key | Written by | Default | Used for |
| --- | --- | --- | --- |
| `architecture` | `init` | `docs/architecture.md`, unless the repo has an architecture doc of its own | The architecture doc's path |
| `adr` | `init` | `docs/adr` | The ADR directory |
| `agentCap` | the owner | 40 | The most agents a plan may estimate |
| `maxParallelCrews` | the owner | 4 | The most crews running at once |
| `merge` | the owner | `sequential` | Merge mode of auto-started runs |
| `target` | the owner | the current branch | Target branch of auto-started runs |
| `roles`, 0.4.0 | `init` on approval, or the owner | the inventory, as 0.3.0 | Agent type per job: `build`, `test`, `review`, `search`, `docs`, `deploy` |
| `deploy`, 0.4.0 | `init` on approval, or the owner | none | `{target, command, production}` for devops; `production: true` always goes to the owner |
| `writingSkill`, 0.4.0 | `init` on approval, or the owner | none | The skill the writer loads, when listed |
| `promptOverrides`, 0.4.0 | the owner | none | Per role (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`), a file under `.claude/foundry/prompts/` the role reads in addition to its prompt; never prompt text |

From 0.4.0 init also reads `<repo>/.claude/kit/manifest.json`, kit's record of what it set up (contract `plugins/kit/docs/manifest.schema.json`, repo ADR-0013). It runs `kit:init` through the Skill tool when that skill is listed and the manifest is missing or lacks foundry's read-only declarations, and otherwise carries on as 0.3.0 and says so ([ADR-0002](adr/0002-kit-manifest-and-config.md), section 1). The sequence, as designed:

```mermaid
sequenceDiagram
  actor Owner
  participant I as foundry:init
  participant A as Architect
  participant MF as .claude/kit/manifest.json
  participant K as kit:init
  participant KM as kit_manifest.py
  participant FJ as .claude/foundry.json
  Owner->>I: /foundry:init
  I->>A: init mode, only when there is no architecture doc
  I->>MF: read
  alt valid, declares foundry:judge and foundry:cynic read-only
    I->>I: use it
  else missing or lacks the declarations, and kit:init is listed
    I->>K: Skill kit:init, args declare read-only: foundry:judge, foundry:cynic
    K->>Owner: show the declaration (full init first when no manifest)
    Owner-->>K: approve
    K->>KM: declare --by foundry, or write with the declaration in the facts
    KM->>MF: agents readOnly true, declaredBy foundry
  else kit:init not listed
    I->>Owner: kit is not installed, foundry init carries on without a kit manifest
  else not JSON, fails the schema or another version
    I->>Owner: kit manifest unreadable, carrying on without it
  end
  I->>Owner: propose roles, deploy, writingSkill, promptOverrides
  Owner-->>I: approve some
  I->>FJ: write the approved keys
```

*foundry init extending kit init, 0.4.0: the four manifest cases and what each writes.*
Traces to: `plugins/foundry/docs/adr/0002-kit-manifest-and-config.md` (sections 1 and 2), `docs/adr/0013-kit-manifest.md`, `plugins/kit/docs/manifest.schema.json`, `plugins/foundry/skills/init/SKILL.md` (0.3.0 doc check).

Two kinds of state don't go to the foundry folder:

- `foundry.limitReset` in Claude Code's plugin state, `{ resetsAt, fired }`: the five-hour reset a wake is armed for and whether it has gone out. It survives a hot reload of the hooks module.
- The module's memory: every agent seen this session with its spawn name, parent and model, each agent's start and last activity time, each agent's status at the last heartbeat, the stalled set, each lead's tag, idle period and final-report time, the stop-gate counters, and when the main session was last active. A reload or `/clear` starts it over, except the main session's last activity, which `/clear` keeps.

## Hooks

All of these are in `hooks/register.ts`.

| Event | What it does |
| --- | --- |
| `classic.SessionStart`, main session only | Adds `[foundry] dir: <path>` to the context, so the foreman never derives the folder itself. |
| `session.start` | Registers `/foundry`, starts the one-minute heartbeat, and re-arms a pending limit-reset wake from plugin state. |
| `session.end` with reason `clear` | Clears the module's memory. |
| `agent.spawn` | Records each agent's spawn name, type, parent, model and start time, and counts the spawn as activity. |
| `tool.call` on `Agent`, 0.4.0 | After a crew agent's or a lead's call goes through, appends a `spawn` line to `events.jsonl`. |
| `tool.call` on `SendMessage` | Enforces who a crew agent may message, logs lead-to-lead messages, and tracks each lead's tag for `/foundry`. From 0.4.0, appends a `tag` line to `events.jsonl` for each tag set. |
| `tool.call` on `Agent` | Refuses crew agents' calls without `model` or `effort`, or with `effort: "max"`. Adds the report-path note to calls that start a lead or a crew member. |
| `tool.call` on `Agent`, 0.3.0 | Refuses starting a lead that `plan.json` holds back: the run-level and crew-level approval gates, the wave gate and the parallel cap (see [Plan gates](#plan-gates-030)). |
| `tool.call` on `Write`, `Edit` | Stamps the clock's time on new lines of this session's `decisions.md`; from 0.4.0, on every literal `HH:MM` too. |
| `tool.call`, any tool | Records activity, the main session's too. On `SubagentHandback`, refuses an empty hand-back from a crew agent and captures the report. |
| `turn.step` | Records activity for each model request, the main session's too. |
| `classic.SubagentStop` | Runs the lead stop gate and saves the stopping agent's report. From 0.4.0, each final report saved (here or from `SubagentHandback`) appends a `report` line to `events.jsonl`. |
| `session.measure`, `classic.StopFailure` | Arm the limit-reset wake. |
| `command.run` for `foundry` | Prints the crew status. |

### Message rules

A member may message its own lead and the other members of its crew. A lead may message `main`, its own members and the other leads. An address resolves to the agent with that id; else to the live agents with that name, a trailing ` [ref]` dropped; else to the newest agent seen with that name. Refusals, word for word, with `<...>` filled in:

- A member to `main`: `[foundry] Refused: crew members message only their own lead and the other members of their crew. Put your question in a message to your lead, <lead>, which asks "main" for you.`
- A member to anyone else outside its crew, or to an unknown address: `[foundry] Refused: crew members message only their own lead and the other members of their crew. To reach anyone else, tell your lead, <lead>.`
- A lead to another crew's member: `[foundry] Refused: a lead reaches another crew only through its lead. Send it to that crew's lead, <lead>, instead.`
- A lead to an unknown address, or to an agent outside every crew: `[foundry] Refused: a lead reaches another crew only through its lead. Message "main", your own members, or another crew's lead.`
- A name that resolves to live agents in different crews: `[foundry] Refused: more than one live agent is named "<address>", in different crews. Address it by its agent id.`

A lead's message to `main` that starts with `QUESTION:`, `BLOCKED:` or `PROPOSAL:` sets its tag in `/foundry`; an untagged one clears it. Any message from the foreman to a lead clears that lead's tag.

### Agent calls

From inside a crew, every Agent call needs `model`, and `effort` set to `low`, `medium`, `high` or `xhigh`:

- No model: ``[foundry] Refused: inside a crew, every Agent call sets `model`: "opus" for judgment-heavy work (design, debugging, review, tricky code), "sonnet" for mechanical or well-specified work. Call Agent again with model set.``
- No effort, or an unknown one: ``[foundry] Refused: inside a crew, every Agent call sets `effort` to one of "low", "medium", "high" or "xhigh": "low" for lookups and mechanical edits, "medium" for well-specified work, "high" or "xhigh" for hard design, debugging or review. Call Agent again with effort set.``
- `effort: "max"`: `[foundry] Refused: effort "max" is not allowed inside a crew; "xhigh" is the top. Call Agent again with effort set to "low", "medium", "high" or "xhigh".`

The model check runs first. The foreman's own Agent calls aren't checked, though the skill tells it to set both.

A call that starts a lead from the main thread, or any agent from inside a crew, gets this note in its result: `[foundry] If <name>'s report does not reach you, read <path> once it stops.`

### Plan gates (0.3.0)

The gates apply to an Agent call from the main thread that starts a `foundry:lead` with a non-empty `name` ([ADR-0001](adr/0001-design-phase.md), section 9). A lead started by another agent, or with no name, is never gated. On every such call the hook reads `<foundry dir>/plan.json` fresh, so the foreman's edits count at once, and it never writes the file. A leading UTF-8 BOM is stripped before parsing.

The lead's name picks the plan entry it is gated as. A name that is a plan slug is that crew. Otherwise, a name `<base>-<n>`, with `n` an integer of 2 or more and `<base>` a plan slug, is a successor and is gated as `<base>`, so restarting a crew under a fresh name can't slip past its gates. Only one suffix is stripped, and a name that is itself a slug is never stripped. Any other name, including `<slug>-1`, isn't gated.

The gates run in this order, and the first match refuses the call with `[foundry] Refused: <reason>`:

1. Approval gate, run level: while `approval` is `owner` and `approvedAt` is null, every lead in the plan is refused. Reason: `this run changes the design; get the owner's approval first`.
2. Approval gate, crew level: a crew whose `ownerApproval` is `pending` is refused on its own. Reason: `<slug> waits for the owner's approval`.
3. Wave gate: refused while any other crew in an earlier wave isn't `merged` or `dropped` (a crew with no status counts as not merged). Reason: `wave <n> isn't merged yet: <slugs>`, naming the lowest such wave and its crews in `crews` order. A crew without a numeric wave skips this gate, and crews without one are ignored.
4. Parallel cap: refused while the count of other crews with status `running` is at or above the cap. The cap is `maxParallelCrews` when it is an integer of 1 or more, otherwise 4. Reason: `<running> crews running, the cap is <cap>; start <slug> when one merges`.

In each reason, `<slug>` is the plan slug, so a successor's refusal names its base. Entries with the target's slug are left out of the wave and cap checks, so a crew can't hold itself back, and a restart or a successor whose base already says `running` doesn't count against the cap.

With no foundry dir, no plan file, a file that is empty, not JSON, not an object or without a `crews` array, or a name the plan doesn't hold, no gate applies, so 0.2.1 runs keep working. Any error while reading or checking the plan is logged and lets the call through, like every other foundry hook. The gates trust the foreman's `status` field: a crew marked `merged` too early gets past the wave gate. The judge-gated merge is still the real control.

The idle-lead prompt also reads the plan, to name a successor the gates map back to the same crew: a plan slug `C` gets `C-2`, a successor `B-<n>` gets `B-<n+1>`, counting past any name that is itself a plan slug (plan `[auth, auth-2]` gives `auth-3`). It waits at most 2 seconds for that read, on the engine clock. A read that hasn't settled by then, or one that fails, gives the 0.2.1 name (`auth` to `auth-2`, `gateway-3` to `gateway-4`), and the prompt still goes out.

### Report capture

When a crew agent stops, the hook writes its last assistant message to its report file. When the agent sent its report through `SubagentHandback`, the hook writes that message instead, and the stop that follows leaves the file alone. A lead's hand-back is written only if it would pass the stop gate; otherwise the stop decides what's written.

A crew agent's hand-back under 40 characters once trimmed (`HANDBACK_MIN`), or one that is only `placeholder`, `todo` or `tbd`, is refused. A hand-back that starts `QUESTION:`, `BLOCKED:`, `PROPOSAL:` or `CHECKPOINT:` is exempt from the length, but is refused when nothing, or only a stand-in, follows the tag: `[foundry] Refused: that hand-back is too short to be a report. Hand back your real report: what you did, the branch, and proof.` If the crew can't be read, the hand-back goes through.

### The lead stop gate

A lead's stop is checked against its hand-back, else its last message. It goes through when the text starts with `CHECKPOINT:`, `BLOCKED:`, `QUESTION:` or `PROPOSAL:`, or has a `## Proof` heading, or while the lead's tagged message to `main` is unanswered (its tag in `/foundry`; any message from the foreman clears it). Otherwise the stop is sent back with:

`[foundry] Not done yet: finish with your report, in the sections Summary, Branch, Changes, Proof, Checks run and Open questions (each a "## " heading), or, if you cannot finish, start your final message with CHECKPOINT:, BLOCKED:, QUESTION: or PROPOSAL:.`

The gate sends a stop back at most twice in a row (`LEAD_STOP_BLOCKS`), then lets the next one through, so a lead can't loop forever. A stop while the lead still has work out is interim and always goes through: a descendant is live, or a background task belonging to a descendant is running or pending. A stop excused by an unanswered tag is interim too. An interim stop's text is saved to `<agent>.interim.md` and doesn't change the report file, its tag or the lead's idle period. A stop the gate sends back is saved nowhere. The gate applies to `foundry:lead` agents only.

### Heartbeat and stalls

Every 60 seconds the module checks each crew agent listed as `running`. An agent counts as active at its spawn, each tool call and each model request. One with nothing on record starts counting from the first check. One that is `running` now but wasn't at the last check, or wasn't listed then, counts as active now and leaves the stalled set: a resumed agent isn't reported on its old activity. An agent idle for 15 minutes or more is reported once, until it is active again, with a toast, `[foundry] stalled: <agent> (crew <crew>), no activity for <n>m`, and a prompt to the main session:

`[foundry] stalled: <agent> in crew <crew>, no activity for <n>m. Check /foundry and message the <crew> lead. Read its transcript tail before you stop it; a resumed agent may be compacting.`

From 0.4.0 each stall wake, and each idle-lead wake below, appends a `stall` line to `events.jsonl` (`kind` `agent` or `idle-lead`).

### Idle leads

The same check looks at each listed lead that a check saw go from `running` to stopped, is now `idle` (never `waiting`, `killed`, `failed` or `completed`) and has no member at work. A lead first seen stopped, as after a reload, is never a candidate until it runs and stops again. A candidate is excused while it waits on the foreman (a `QUESTION:`, `BLOCKED:` or `PROPOSAL:` tag) or after a final report (a `## Proof` section, `CHECKPOINT:` or `BLOCKED:`) in its current stint. A stint begins at the check that sees the lead running again; activity alone doesn't start one, so a sign-off after a final hand-back doesn't undo it. The report and tag in its report file count as well when written in the stint, so a reloaded module doesn't prompt for a lead that already reported. Otherwise its idle period starts at the first check, and after 15 minutes the main session gets one prompt per period:

`[foundry] idle lead: <lead> in crew <crew>, no report for <n>m and no member at work. Read its last message and resume it with SendMessage, or start <crew>-2 from its report.`

The period ends when the lead runs again or a report of its own is captured. The successor named is the crew's next one: `auth` gives `auth-2`, `auth-2` gives `auth-3`.

### Limit-reset wake

Two events arm it, and only while a lead is live: a `session.measure` showing the five-hour window at 100 percent, or a `StopFailure` with error `rate_limit` (the hook then reads the session's usage, and arms only if that shows the five-hour window at 100 percent too). The module sets a timer for two minutes after `resetsAt` and records the reset in plugin state. When the timer fires, it claims the reset in plugin state and sends:

`[foundry] limit reset: the five-hour usage window reset at <resetsAt>. Check /foundry and message each lead whose crew isn't done to resume.`

The wake goes out once per `resetsAt`. A hot reload cancels the timer with the old module, and `session.start` arms it again from plugin state. If the main session made a tool call or model request after `resetsAt`, the reset is claimed and no prompt goes out: the foreman is already at work.

### Decision times

A `Write` or `Edit` of `<foundry dir>/decisions.md` for this session has each new line that starts `- HH:MM |` rewritten with the clock's local time. A line keeps its time when that `HH:MM` is already on a decision line of the text the call replaces: the file on disk for a `Write`, `old_string` for an `Edit`. So a reworded line keeps its time, and only new lines are stamped. 0.3.0's pattern, `^- (\d{1,2}:\d{2}) \|`, misses the literal `HH:MM` the run skill tells the foreman to type, so those lines kept no time; from 0.4.0 the pattern is `^- (\d{1,2}:\d{2}|HH:MM) \|`, and a literal `HH:MM` is always stamped, since it marks no time ([ADR-0003](adr/0003-event-log-and-retro.md), section 2). An `Edit` changes only `new_string`. A log written through Bash isn't seen. Line endings are kept. Any other file, and another session's log, is left alone.

### `/foundry`

Prints `Crews (<n>):` and one line per lead: name, status (`ended` once the agent list drops it), live members by model family, then one of `waiting on you: <question>`, `blocked: <text>`, `proposal: <text>`, `waiting on members`, `no report yet` or `last report <time> ago`, then `last active <time> ago`. Under each lead it lists stalled agents, the verdict in the highest-numbered judge file and the report folder, then one line per member: `<name> <status> <n>m (<family>), last activity <time> ago` (or `no activity seen`), timed from its spawn or first sighting. The last lines name the message log, when there is one, and `Foundry dir: <path>`. With no crews it prints `No foundry crews in this session. Start them with /foundry:run.` If reading the crews fails: `foundry could not read the crews; see the debug log.`

From 0.3.0, `/foundry` first shows the plan, read through the same guard as the gates: `Plan (<n> crews, approval <approval>):`, with `, waiting for the owner` added while `approval` is `owner` and `approvedAt` is null, then one line per crew sorted by wave, ties in `crews` order: `- wave <wave>: <slug>, <verdict>, <status>`, with `, waits for the owner's approval` when `ownerApproval` is `pending`. A missing field prints as `?`. Then come the lines above. With no plan, or one it can't read, the output is the 0.2.1 output.

### Failing open

Each hook step runs inside a guard. If foundry's code throws, the guard logs `foundry: <step> failed, letting the call through: <error>` or `foundry: a hook failed and was skipped: <error>` to the debug log, and the call goes on as if the plugin weren't installed. A step that fails refuses nothing.

## Failure modes and recovery

**A stalled agent.** The heartbeat prompts the foreman. The foreman messages the stalled agent's lead, or the lead itself, and asks for its state. `/foundry` keeps showing the agent as stalled until it does something. Before stopping it, the foreman or lead reads its transcript tail: a resumed agent may be compacting.

**An idle lead.** A lead seen to go idle without a final report in its stint, while no member works, gets one `[foundry] idle lead:` prompt after 15 minutes. The foreman resumes it with a message, or starts its successor from its report.

**The usage limit.** When the five-hour window runs out while crews work, the limit-reset wake prompts the foreman after the reset. The foreman messages each lead that hasn't sent its final report: "Usage limit reset. Resume from where you stopped."

**A lead stops with work left.** Its report starts with `CHECKPOINT:`. The foreman starts a fresh lead, `<slug>-2` (then `-3`), from that report. The successor's brief names the original goal file, the predecessor's branch and commit, and the crew's original base commit; the successor resets its worktree to the predecessor's branch first. Its members, judges and report folder carry its own name. The other leads are told the new name. A member that stops with `CHECKPOINT:` is handled the same way inside the crew: a fresh member from its handoff note, never a resume.

**A lead tries to stop without a report.** The stop gate sends it back, at most twice in a row. After that the stop goes through, and the foreman sees a report that isn't in the fixed format.

**A lost hand-back.** Hand-backs from nested agents have been lost on some machines. The report is on disk anyway: the lead reads `reports/<crew>/<member>.md`, and the foreman reads `reports/<lead>/<lead>.md`, at the path in the `[foundry]` note from the Agent call.

**A judge FAIL.** The lead sends the findings to a builder. Each later judge is a fresh agent under the next unused name, never a resume, and any fix after a FAIL or a red-team break needs a fresh judge. When two fix attempts at one level end with the same check failing, the lead climbs the ladder: Sonnet, then Opus at `medium`, `high`, `xhigh`, each step a fresh agent whose first deliverable is a root-cause analysis with evidence. When `xhigh` fails twice, the lead sends `BLOCKED:` with the failing check, its output and the theories ruled out, and the foreman takes it to the owner. In `single` mode an integration-judge FAIL goes back to the integrator, and a fresh `integration-judge-2` rules next.

**A verdict on the wrong commit.** The foreman merges only when the judge file's `## Proof checked` SHA equals `git rev-parse <crew branch>`. After a rebase that moved the head, the old PASS doesn't count.

**A reload mid-session.** The module's memory starts over. An agent that ended before the reload resolves to no crew, so a message to it from a crew agent is refused. A pending limit-reset wake survives in plugin state.

## Not verified yet

- The 0.3.0 plan gates, `/foundry` plan lines and idle-prompt successor name are covered by `tests/v03.test.ts`, run against the mock engine, not observed in a live run. [`plan.example.json`](plan.example.json) validates against [`plan.schema.json`](plan.schema.json).

- No prompt in 0.2.0, neither the skill nor any of the five agents, has run as a live agent in a 0.2 run. The hooks are covered by `tests/crew.test.ts`, `tests/hooks.test.ts` and `tests/v02.test.ts`, which run `register.ts` against the mock engine from `claude-code/testing`.
- A lead's status after it ends a turn while its members still run is unobserved. `/foundry` shows `waiting on members` for a lead that isn't `running` and has live descendants, and the stall check skips any agent that isn't `running`; both rest on that status.
- Capturing a report from `SubagentHandback` is covered by tests, not observed live.
- The limit-reset wake rests on three things a probe confirmed: `$.clock` timers run from `session.start`, a hot reload cancels them (so the wake is re-armed from plugin state), and `$.prompt.submit` wakes an idle session. Nobody has yet seen the wake fire after a real usage-limit stop.
- Where an organization manages Claude Code, `SubagentStop` hooks run only in plugins it lists. There, reports come only from the hand-back tool. The lead stop gate is a `SubagentStop` hook too, so it shouldn't run there either; that is inferred from the code, not seen.
- `/goal` is session-only: a Stop hook on the main session judges it, so a lead can't use it. Foundry uses the goal file and the lead stop gate instead (backlog item 20).
- The gate's two-block bound relies on the engine setting `stop_hook_active` on the stop after a block. That comes from the hook type docs and hasn't been seen live. Claude Code also lets a stop through itself after 8 consecutive blocks.

*Drafted with AI assistance and reviewed by the author.*
