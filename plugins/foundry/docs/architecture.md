# foundry architecture

foundry is three kinds of file. The protocol lives in prompts: the foreman's in `skills/run/SKILL.md`, and the six agent definitions in `agents/` (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`). The rules a prompt can't be trusted to keep live in one hooks module, `hooks/register.ts`, which `hooks/hooks.json` loads. `types/index.d.ts` declares the one value the module keeps in Claude Code's plugin state.

The prompts decide what agents should do. The hooks refuse the calls that break the chain of command, save reports to disk, and wake the foreman when something needs it.

Foundry 0.3.0 adds a design phase: an architect, principle packs, a plan file and waves. [ADR-0001](adr/0001-design-phase.md) decides it. The parts are `agents/architect.md`, the `skills/principles/` and `skills/init/` skills, and the plan gates in `hooks/register.ts`, which read `plan.json`. The plan file's contract is [`plan.schema.json`](plan.schema.json), with an example in [`plan.example.json`](plan.example.json).

Foundry 0.4.0 (designed in foundry run 2, ADRs accepted 2026-10-27) builds on kit and records what a run did. [ADR-0002](adr/0002-kit-manifest-and-config.md): foundry init reads kit's manifest, has kit declare `foundry:judge` and `foundry:cynic` read-only, and proposes the new `.claude/foundry.json` keys ([`foundry-config.schema.json`](foundry-config.schema.json)); crews take ports from worktrees' slots. [ADR-0003](adr/0003-event-log-and-retro.md): the hooks append `events.jsonl` ([`events.schema.json`](events.schema.json)), `decisions.md` gets a grammar, and `scripts/retro.py` with the `foundry:retro` skill counts both. Both apply the repo's extension rules, [repo ADR-0012](../../../docs/adr/0012-extension-framework.md). Run 2's wave 1 merged; the sections marked 0.4.0 describe the code.

Foundry 0.5.0 (designed in foundry run 3, [ADR-0004](adr/0004-scope-repair-and-head-gates.md), accepted 2026-10-28 with the owner's approval of the run-3 plan) makes the quality gates evidence-based for scope, repair and cost. Plan v2 carries a `repairBudget`. The lead's report gains Examined and Not examined sections, and the judge FAILs an absence claim that states no scope. The judge writes fixed head and patch lines, so a hook can tell which head a PASS belongs to, and a PASS survives a merge of the target (a rebase, before 0.6.0) that leaves the patch id unchanged. The hooks refuse the judge spawn that would exceed the budget, and record the spent budget in `events.jsonl`. They also refuse main-session `foundry:*` calls that set no model or effort. Every new rule applies only to plans with `version >= 2` and fails open on v1. The effort ladder itself is a repo-level principle, in the amendment to repo [ADR-0011](../../../docs/adr/0011-agents-pin-their-model.md). Run 3 merged as 0.5.0 and 0.5.1; the sections marked 0.5.0 describe the code.

Foundry 0.8.0 ([ADR-0005](adr/0005-growth-model.md), accepted 2026-10-29) grows the project's architecture doc instead of the plugin. The plugin keeps the seven generic packs and ships no domain content. An architect that finds a domain no pack or doc section covers reports it, and an init-mode extend pass writes a domain section into the project's doc, committed on its own. The architect and the writer gain `WebFetch` and `WebSearch`. Every web fetch in the session passes one hook function, `fetchVerdict`, which allows every call today and logs a `fetch` line to `events.jsonl`, so a guardrail added later changes that function alone. The sections marked 0.8.0 are the design; wave 1 of the 0.8.0 run builds them.

Foundry 0.9.0 ([ADR-0006](adr/0006-leftover-causes.md), proposed 2026-10-29 by the `leftover-design` crew) says why each leftover worktree stayed. retro gains one top-level key, `leftoverDetails`, with `leftovers` and every other key unchanged. The red team resets its own branch to the crew head instead of detaching, and leaves its worktree clean. The retro skill gains a root-cause step that writes one `CAUSE:` line per anomaly. Details are in "retro's leftover details (0.9.0)" below.

The container view below shows which part writes and which reads each stored file. Nodes marked 0.4.0 name the version that added them, and are built.

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
  hooks -->|"saves reports, logs lead messages, 0.5.0: reads this run's judge files"| reports
  hooks -->|"stamps HH:MM"| dec
  hooks -->|"appends spawn, stall, tag, report, 0.5.0: spent budget"| events
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
  foreman -->|"start, answers, make-ready requests (merge the target in)"| leadA
  foreman -->|"start, answers, make-ready requests (merge the target in)"| leadB
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
| Architect, 0.3.0 | `init`: the `foundry:init` skill, run by you as `/foundry:init` or by the foreman when a run finds no architecture doc. `plan`: the foreman, at the start of every run. `design`: the design crew's lead | Opus, `medium` (0.4.3) | Only the architecture doc and the ADR directory, plus `.claude/foundry.json` in `init` mode, `plan.json`, `plan.md` and `<foundry dir>/scratch/` in `plan` mode, and a contract artifact at a path the design crew owns in `design` mode; never source or tests |
| Cynic, `cynic-<n>` | Foreman, fresh for each batch | Opus, `medium` (0.4.3) | No |
| Lead, `<slug>` | Foreman, in the background, in a worktree | Opus, `medium` | Merges members and the target into the crew branch, never rebases (0.6.0); writes code only for conflicts and small fixes the checks demand |
| Members, named after their lead | Lead | Set on every call; Sonnet for mechanical work, Opus for judgment | Yes, each in its own worktree |
| Judge, `<crew>-judge`, then `-2`, `-3` | Lead | Opus, `medium` (0.4.3); `high` or `xhigh` only on the owner's call (repo ADR-0011 amendment). From 0.5.0, on a v2 plan, at most `repairBudget` judges after FAILs ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 5) | No |
| Red team, `<crew>-redteam` | Lead, when the plan says yes | Opus, `medium` (repo ADR-0011 amendment) | Only inside its own worktree and temp dirs; never commits |
| Integrator | Foreman, `single` mode | `general-purpose`, Opus, `high` | Yes, the integration branch |
| Integration judge | Foreman, `single` mode | Opus, `xhigh` in 0.4.3 (`skills/run/SKILL.md:315`); `medium` from 0.5.0, like every judge (repo ADR-0011 amendment) | No |
| Crew planner, `<slug>-planner`, then `-2` (designed in ADR-0009, not built yet) | `wave.js`, on the Workflow path only | Opus, `medium`, in its front matter and in `workflows/roles.json` | No; read-only, starts no agent |

**Workflow crews have no lead (designed in [ADR-0009](adr/0009-workflow-factory.md), Decisions 2, 4 and 5; not built yet).** On the Workflow path a crew is a chain inside the `wave.js` script, not a `foundry:lead`. The script plays the lead's orchestration role and makes every member, judge and red-team `agent()` call itself, because a workflow agent has no Agent tool and can't delegate (ADR-0009, Probe, probe 2; that `foundry:lead` in particular has none is inferred from `kit:builder`, not run). Every agent's type, model, effort and isolation come from one table, `plugins/foundry/workflows/roles.json`, through the script's one `spawn()` function: `architect`, `cynic`, `planner` (`foundry:crew-planner`) and `writer` on Opus at `medium`; `tester` and `builder` (the project's agent type, default `general-purpose`) and `resolver` on Sonnet at `medium`, a builder at `low` when its task says so; `rca`, `redteam` and `judge` on Opus at `medium` (the last two as `foundry:judge`); and `runner` (`general-purpose`, Sonnet, `low`), which runs one `factory.ts` command the script wrote out in full and relays its output. The table has no `lead`, `devops` or `integrator` role, and `workflowRoleVerdict` refuses one (ADR-0009, Decision 2). The crew planner (`agents/crew-planner.md`, Decision 5) does the lead's depth pass and split, `agents/lead.md` sections 2 and 3, for one crew and returns the tasks in a schema; it writes nothing. A tester's commits still carry `Foundry-Role: test-writer`, and a resolver's carry `Foundry-Role: resolver`, a value defined in the member and judge briefs `wave.js` writes, not in `agents/lead.md` (Decision 8). Crews with a `devops` member, crews whose members the owner raised to `high` or `xhigh`, every crew of a `single`-mode run, and every crew in a session without the Workflow tool keep the lead path, and the table above, unchanged (Decision 1, "start, engine split"). Whether the Workflow path is the default is an open owner decision (ADR-0009, Owner decisions, item 2; the ADR recommends yes).

The architect (0.3.0) is `agents/architect.md`. It loads the principle packs the work touches from the `skills/principles/` skill and runs in three modes ([ADR-0001](adr/0001-design-phase.md), sections 2 and 3):

- `init`: started by the `foundry:init` skill. Writes the project's architecture doc (principles, module map, ADRs for decisions already in the code) and `.claude/foundry.json`. From 0.8.0 the foreman also starts it in `init` mode with an extend brief, to add domain sections to an existing doc (the extend pass, below).
- `plan`: started by the foreman at the start of every run, outside every crew, like the cynic. For a goal, gives each touched module an `extend` or `change` verdict and splits the work into crews and waves by the leaf test, as a draft `plan.json` plus a readable `plan.md`. The foreman owns both files after that.
- `design`: a member of a design crew, in wave 0 or a mid-run slice, started by that crew's lead. Writes the ADR and architecture-doc change for each `change` verdict, and names the seams the crew's test-writer must pin with contract tests.

Its tools are Read, Grep, Glob, Bash (read-only git and read-only inspection, plus the done-check commands it proves and a schema validator fetched by `npx -y`, both in `plan` mode), Skill, and Write and Edit for the files in the table above. From 0.8.0 it also has `WebFetch` and `WebSearch`, and so does the writer ([ADR-0005](adr/0005-growth-model.md), section 3). Leads and members already have every tool, and devops keeps `WebFetch`. The judge and the cynic get no web tools: a judge that needs an outside fact to rule has found a gap in the doc and reports it as a finding. Every agent prompt, and the foreman's, carries ADR-0005's fetch rule word for word, and the lead puts it in every member brief (section 2). Crews never edit the architecture doc or ADRs; a design change they need goes to the foreman as `PROPOSAL:`, which the foreman can take up as a mid-run design slice (lifecycle step 8).

**The extend pass (0.8.0).** Foundry extends a project's doc only on evidence from the work ([ADR-0005](adr/0005-growth-model.md), section 4):

- At init, a goal given with `/foundry:init` is passed to the architect, which covers the domains the goal names as well as the code, so a greenfield repo gets a doc.
- At plan time, a domain is uncovered when the goal touches a platform, product type or tool that neither a loaded pack nor a section of the doc covers. The plan-mode architect stays read-only: it hands back one `UNCOVERED: <domain> | <why the goal touches it>` line per domain and no plan blocks, so the plan-file route writes nothing. The foreman then starts the architect in `init` mode with an extend brief naming those domains.
- At run end, when a lead's report has a `## Learned` section, the foreman starts the same pass with those items. The lead stop gate doesn't require the section.

An extend pass adds one domain section under the doc's Principles, plus ADRs (section 5). Rules go in the section, at most 15, each in pack form with a test and tagged `from knowledge` or `checked: <url>`. Each fork gets an ADR with its alternatives and the line `Decided by: default`. Each bootstrap exception gets an ADR naming the rule it bends. Owner actions go in the section's `Owner actions` list, where `- [ ] ` marks an open action and `- [x] ` a done one; a crew whose work depends on an open one raises `BLOCKED:` at start. Before committing, the foreman starts the cynic on the new section with a narrow brief: rules whose test can't be run or checked against a diff, rules that are really forks, forks with no alternative named. The foreman then commits the pass on its own, on the run's target, as `docs(arch): extend <domain>` or `docs(arch): adopt learned items`, never mixed into crew work (section 8). Extend passes write without owner approval (section 6); `Decided by: default` marks what a later review step will read.

```mermaid
sequenceDiagram
  participant P as Architect, plan mode
  participant F as Foreman
  participant A as Architect, init mode
  participant C as Cynic
  participant T as Target branch
  F->>P: goal, plan brief
  P-->>F: UNCOVERED: domain | why, no plan blocks
  F->>A: extend brief naming the domains
  A->>A: domain section, fork and exception ADRs (fetch only for a fact it isn't sure of)
  A-->>F: INIT report
  F->>C: narrow brief on the new section
  C-->>F: RECOMMEND lines
  F->>T: commit docs(arch): extend domain
  F->>P: fresh plan architect, same goal
  P-->>F: plan.json and plan.md blocks
```

*The plan-time extend flow, 0.8.0, as designed; it runs once, on the first run that touches the domain.*
Traces to: `plugins/foundry/docs/adr/0005-growth-model.md` (sections 4, 5 and 8, and its literals table), `plugins/foundry/hooks/register.ts:861-864` (`routePlanFiles` writes nothing for a hand-back with no fenced blocks).

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
4. Split: Crews own disjoint files, each with a done-check it can't game, its high-impact paths, a red team yes or no, and a resource slice (port range, database or temp directory). From 0.3.0, the foreman starts the architect in `plan` mode for this, at the start of every run. It gives one verdict per touched module, `extend` by default, splits the work into crews and waves by the leaf test, runs each crew's done-check once to prove it, and estimates agents per crew. The architect drafts `plan.json` and `plan.md`; the foreman owns both after that. A cynic reviews the verdicts on its own; if the two disagree, the architect gets one round to reconcile. The owner is asked only when they still disagree, or a change breaks a declared principle, adds an external service or recurring cost, or changes a stored data shape in a way that's hard to undo. `plan.json` has no fields for a crew's high-impact paths, red team or resource slice, which the 0.2.1 foreman sets in its plan table and each lead's brief (`skills/run/SKILL.md`); ADR-0001 doesn't say who sets them from 0.3.0. From 0.4.0 the slice names no invented port range: a crew uses its worktree slot's `PORT_BASE` when the repo has a `.claude/worktree-setup.*`, and the plan says `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)` when it hasn't ([ADR-0002](adr/0002-kit-manifest-and-config.md), section 4).
5. Approval and freeze: The foreman shows the plan table and asks for the merge mode and target branch. On approval it writes `plan.md`. From here the scope is frozen, and only the owner can change it. From 0.3.0, the pause depends on the plan. An extend-only run, with no wave 0, doesn't pause: the architect's draft sets `approval: "auto"`, and the foreman logs the plan, overwrites `approvedAt` with its own log time, and starts the crews without asking. Its merge mode and target come from `.claude/foundry.json` (`merge`, `target`); without them the merge mode is `sequential` and the target is the current branch, and the foreman logs which it used. The owner sees the plan in the end-of-run report. A run with a wave 0 gets `approval: "owner"` and `approvedAt: null` from the architect's draft: the foreman checks it, shows the plan table with the ADRs, asks for the merge mode and target as in 0.2.1, and sets `approvedAt` when the owner approves. Later waves start as earlier ones merge, with no further pause. `approvedAt` is null only while a run waits for the owner. In either case, questions still reach the owner through the cynic's escalation rules.
6. Leads start: The foreman writes `goals/<slug>.md` for each crew and starts all leads in one message. From 0.3.0, leads start by wave. Wave 0 holds the `change` work (ADRs, the architecture-doc change, the contract tests) and merges before any other wave starts; each wave merges before the next starts. Within a wave, at most `maxParallelCrews` crews run at once; the rest queue and start as running ones merge. The queue order is the order of the `crews` array within the wave. The foreman sets each crew's `status` in `plan.json` as it starts and merges.
7. Inside each crew: The lead runs its checks to prove its environment works, runs a full depth pass, splits the work into member tasks, and delegates. Members report with proof. The lead merges the members' branches with `git merge --no-ff`, runs the checks, then runs the red team (when there is one) and a fresh judge. Before the judge it compares its diff with the files it owns and asks the foreman for any extension. Every member commit carries `Foundry-Crew: <slug>` and `Foundry-Role: <role>` trailers. The judge reads the role with `git log --format='%H %(trailers:key=Foundry-Role,valueonly)'` and fails the crew if a `builder` commit touched the done-check tests. A file outside the crew's ownership is a `QUESTION:` for the foreman in the judge's findings, not a FAIL by itself. From 0.3.0, the judge also asks whether the diff conforms to the architecture doc's principles and module map, and to the run's ADRs. A violation that doesn't affect the done-check is a QUESTION. One that breaks a declared principle is a FAIL.
8. Messages: Leads send the foreman `QUESTION:`, `BLOCKED:` or `PROPOSAL:`. The foreman settles what it can and logs it. Items for the owner go through a cynic first. From 0.3.0, when the foreman takes up a design proposal, it runs a mid-run design slice. It adds a design crew (`verdict: "design"`) to the earliest wave whose crews it doesn't depend on, first in that wave's queue and ahead of the crews that need it; a running crew isn't moved (`skills/run/SKILL.md:278`). A new wave after the last would deadlock when a running crew needs the slice, since a later-wave lead is refused while a running crew's wave is unmerged. The foreman then moves only the crews that depend on the slice, and haven't started, one wave later; running crews and crews that don't depend on it keep their wave. The run-level `approval` and `approvedAt` don't change. The slice waits for the owner only when one of the owner triggers in step 4 applies: the foreman then sets the crew's `ownerApproval` to `"pending"`, and to `"approved"` when the owner answers. Otherwise the slice starts like any crew.
9. Pre-merge review: A cynic reads each crew's final report and the plan, and checks for drift and overlap between crews.
10. Judge-gated merge: The foreman reads the crew's newest judge file modified at or after `approvedAt` itself, under the folder of the crew's newest lead (`<slug>` or its latest successor `<slug>-<n>`), and merges only on a `VERDICT: PASS` with no `- UNSCOPED: ` finding whose `## Proof checked` `Head: ` matches the crew branch head, or whose `Patch: ` matches the branch's patch id with the lead's checks re-run green on the merged head (`skills/run/SKILL.md:310-313`). In `sequential` mode each lead in turn merges the target into its crew branch (`git merge <target>`, a real merge; from 0.6.0, ADR-0015 item 11; before that it rebased), a fresh judge rules if the head moved and the patch id changed, and the foreman fast-forwards with `git merge --ff-only`. In `single` mode an integrator merges every crew branch into `foundry-<short goal>` and an integration judge rules on it.
11. End-of-run report: Crew summaries and what merged where, checks and verdicts, decisions and cynic overrules, the items the end-of-run sweep kept (a cynic drops the rest), and the high-impact files that changed. The foreman then asks before every push and PR, unless the project grants it merge ownership. Production deploys always go to the owner.

### The Workflow path (designed in ADR-0009, not built yet)

[ADR-0009](adr/0009-workflow-factory.md) gives foundry a second crew engine. None of its files exist at `b81ad50`: `bin/factory.ts`, `workflows/roles.json`, `workflows/plan.js`, `workflows/wave.js` and `agents/crew-planner.md` are built by the `workflow-gate`, `factory-cli`, `factory-scripts` and `run-procedure` crews (ADR-0009, Build crews), and until they merge every run takes steps 4 to 11 above. The steps 0 to 11 above stay as the lead path, the fallback. When the foreman's session has the Workflow tool, planning runs as a Workflow script, and every crew whose goal file's `## Engine` section says `workflow` runs as one too (Decision 1, "start, engine split"):

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

*The Workflow engine's parts and what passes between them, as designed.* Traces to: `plugins/foundry/docs/adr/0009-workflow-factory.md:86-115` (the diagram, copied), which traces to `plugins/foundry/hooks/register.ts:1641-1715` (the Agent gates it mirrors), `:327-349` (`planVerdict`), `:499-565` (`judgeRuling`, `patchIdOf`, `headVerdict`) and `:848-904` (the plan-file route), line numbers the ADR took at `fa0fa9f` and unchanged at `b81ad50` (`git diff fa0fa9f b81ad50 -- plugins/foundry/hooks/register.ts` is empty), and to the probe run's `journal.jsonl` and `agent-*.meta.json`.

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

*One wave on the Workflow path, from start to merge, as designed.* Traces to: `plugins/foundry/docs/adr/0009-workflow-factory.md:117-141`, which traces to `skills/run/SKILL.md` sections 6 and 9, `agents/lead.md` sections 1, 3, 6, 7, 9 and 12, and the probe's `journal.jsonl`.

The run on this path, step by step (ADR-0009, Decision 7, "The foreman's procedure"):

- **Plan (step 4).** The foreman writes the brief to `<foundry dir>/plan-brief.md` and runs `factory.ts plan-args`, then `Workflow(plan.js)`, then `factory.ts plan-write` and `plan-check`. `plan.js` runs `foundry-architect` and `foundry-cynic`, and one reconcile round (`foundry-architect-2`, `foundry-cynic-2`) when the cynic disagrees, never a third architect in that run; owner items are collected and returned, never asked from the script. A failed `plan-check` gets one fix run (`foundry-architect-3`, `foundry-cynic-3`, no reconcile), and a second failure goes to the owner (Decision 3).
- **Approval (step 5).** Merge mode and target are read from `.claude/foundry.json` by `factory.ts settings` (missing `merge` is `sequential`, missing `target` is the current branch), shown in the plan table as information and logged; the foreman never asks for them, in either kind of run. The build adds `"merge": "sequential"` and `"target": "main"` to this repo's `.claude/foundry.json`. Approval itself stays: a plan with a wave 0 still waits for the owner, and `factory.ts approve --by owner` runs only after the owner's yes (Decision 7, section 5; Decision 1, `approve`). The question is deleted from `skills/run/SKILL.md` section 5 itself, so step 5 above stops asking it once `run-procedure` merges.
- **Start (step 6).** `factory.ts start --wave next` applies `planVerdict`, marks each workflow crew `running`, makes its worktree `.claude/worktrees/foundry-<slug>` on branch `foundry-<slug>`, appends a `by: "factory"` spawn line, and prints the `wave.js` args. Lead crews come back under `leads`, and the foreman starts and merges them as on the lead path; `start` counts both kinds against `maxParallelCrews` (Decision 1, `start`).
- **Inside each crew (step 7).** `wave.js` runs each crew's chain, `agents/lead.md` sections 1 and 3 to 9 as code: red first (`check --expect red`), split (the crew planner), members (testers before builders, each `integrate`d by the runner), green with the escalation ladder in code, red team when the goal file says yes, `owns-check`, then a fresh judge (Decision 4). A stopped crew returns its tag and text; the foreman handles it as in step 8 and restarts it with `start --slug <s> --resume answers` (Decision 4, "Restarts").
- **Merge (steps 9 and 10).** `factory.ts finish` records each agent's report under `reports/<slug>/<label>.md`, audits every agent's real model and effort, then merges in plan order: the newest judge file this run must be a PASS with no UNSCOPED line, the red record `checks/<slug>-<n>.json` must exist, `judgeFails` must not exceed `repairBudget`, and the head or patch must match under `mergeHeadVerdict`, a fail-closed wrapper around `headVerdict`. It fast-forwards the target locally and never pushes (Decision 1, "finish, merge step"). Only `merge: sequential` is supported on this path; a `single` run is all lead path.

The red-team bound is an open owner decision: whether every red-team round after a crew's first counts against `repairBudget` on the Workflow path (ADR-0009, Owner decisions, item 1; the ADR recommends yes, and `wave.js` step 5 is written that way). While a wave runs, `/foundry` doesn't see its agents; they show in `/workflows`, and `/foundry` fills each crew in when `finish` records it (ADR-0009, Consequences).

## The owner interview (designed in ADR-0008, not built yet)

[ADR-0008](adr/0008-owner-interview.md) adds a module that asks the owner about requirements before the plan, and a requirements ledger that carries them from run to run. None of it is built at `b81ad50`: `skills/interview/` and `interview/` don't exist yet, and the `interview-ledger`, `interview-skill` and `interview-wiring` crews build them (ADR-0008, Build crews).

| Part | Path | What it does |
| --- | --- | --- |
| `foundry:interview` skill | `plugins/foundry/skills/interview/SKILL.md` | Followed by the foreman in the main thread; the only part of foundry that calls `AskUserQuestion` (Decision 1) |
| Branches | `plugins/foundry/skills/interview/branches.md` | The questions, one `## <id>` section per branch with `Pack`, `Visit`, `Fact`, `Ask`, `Recommend`, `Writes` and `Opens` lines; core branches such as `hosting`, `integrations`, `auth` and `secrets`, and at least two per non-core pack (Decision 5) |
| Ledger code | `plugins/foundry/interview/ledger.ts` | Pure functions over the branches, the state file and `requirements.md` (Seams 1 to 4) |
| CLI | `plugins/foundry/interview/cli.ts` | `next`, `remaining`, `check` and `trace`, run as `node <plugin>/interview/cli.ts <command> ...` (Seam 5) |
| Fact-finder | an `Agent` call, `roles.search` or `general-purpose`, Sonnet at `low` | The one new agent: reads the repo and reports `FACT:`, `UNKNOWN:` and `SPEC:` lines, never a decision (Decisions 4 and 10) |

```mermaid
flowchart LR
  owner["Owner<br/>[person]"]
  fore["Foreman<br/>[main thread: skills/run + skills/interview]"]
  facts["Fact-finder<br/>[subagent: general-purpose or roles.search, sonnet, low]"]
  cli["interview/cli.ts<br/>[CLI: Node, no deps]"]
  req["docs/requirements.md<br/>[file in the project repo]"]
  state["interview.json<br/>[file in the foundry dir]"]
  arch["foundry:architect<br/>[subagent: plan and init modes]"]
  goals["goals/slug.md<br/>[files in the foundry dir]"]
  owner -- "answers via AskUserQuestion" --> fore
  fore -- "goal, branch Fact lines" --> facts
  facts -- "FACT / UNKNOWN / SPEC lines" --> fore
  fore -- "next, remaining, check, trace" --> cli
  cli -- "reads" --> state
  fore -- "writes, commits" --> req
  fore -- "R-ids of this run" --> arch
  fore -- "quotes R-n lines" --> goals
```

*The interview's parts, as ADR-0008 designs them.* Traces to: `plugins/foundry/docs/adr/0008-owner-interview.md:30-50` (the diagram, copied), which traces to `skills/run/SKILL.md:8` (only the foreman talks to the owner) and `:119-127` (the architect brief); the rest is new. The `docs/requirements.md` node shows the ADR's recommended location, which is an open owner decision (below).

```mermaid
sequenceDiagram
  participant O as Owner
  participant F as Foreman
  participant X as Fact-finder
  participant C as cli.ts
  participant A as Architect (plan)
  F->>O: altitude question (section 1)
  F->>X: goal + branch Fact lines
  X-->>F: FACT / UNKNOWN / SPEC
  loop until NEXT: none or stop
    F->>C: next ... 3
    C-->>F: NEXT: lines
    F->>O: AskUserQuestion, recommended first
    O-->>F: answers
  end
  F->>C: check requirements.md
  F->>F: commit docs(req)
  F->>A: brief + R-ids
  A-->>F: plan.md with Requirements column
  F->>C: trace ... goals
```

*One run from goal to the first lead, with the interview in place, as designed.* Traces to: `plugins/foundry/docs/adr/0008-owner-interview.md:175-198`, which traces to `skills/run/SKILL.md:77-127` and `:206-208`; the interview steps are new.

How it runs (ADR-0008, Decisions 2 to 9):

- **Hook point.** A new `### Interview the owner` at the end of `skills/run/SKILL.md` section 1, after the owner picks the goal and before the depth pass: the foreman runs the skill with args `<goal> | <foundry dir>/interview.json | <requirements path>` (Decision 2).
- **Size.** The foreman sizes the goal `small`, `standard` or `large` and logs it. A small goal gets no fact-finder and no questions, only one functional requirement written from the goal (`Source: goal`). Greenfield, a new product, service or module, an external service, a stored data shape, or three or more non-core packs make it `large`. Nothing but the interview reads the size; whether process size follows it is left to ADR-0009 (Decision 3).
- **Facts first, then questions.** For `standard` and `large`, the fact-finder runs before any question. A fact settles a branch as context for the architect and never becomes a requirement; only decisions do (Decision 4). `cli.ts next` returns up to three candidate branches, stopping after the first that can open others, so the next question depends on the last answer; the foreman asks them in one `AskUserQuestion` call with the recommended answer first and `Stop the interview` last (Decision 5).
- **Stop.** The interview ends on `NEXT: none`, a small goal, or the owner's stop. What happens to the branches never asked is an open owner decision: ADR-0008 designs filling them with the recommended answers as `Source: default` requirements, and recommends that, but the owner hasn't ruled (Owner decisions, item 1; Decision 6). The cynic never answers for the owner.
- **Tracing.** The plan architect's brief gets the requirements path and this run's R-ids; `plan.md`'s crew table gains a `Requirements` column, and every run R-id is served by a crew or listed under `Unserved:`; `plan.json` and `plan.schema.json` don't change. Each goal file gains a `## Requirements` section quoting its R-n lines exactly, checked by `cli.ts trace` before the first lead starts. The judge needs no change: the goal file is already approved scope (Decision 8).
- **Greenfield.** With no code outside `docs/`, `.claude/`, `README*`, `LICENSE*`, `.gitignore` and `.gitattributes`, section 0 runs the interview at size `large` before `foundry:init`, and passes `Greenfield: <repo>/docs/requirements.md` to the init architect, which then maps planned modules citing R-ids (Decision 9).

Seams the build crews pin (ADR-0008, Seams; the tests are `tests/contract-interview.check.ts`, `tests/interview-skill.check.ts` and `tests/interview-wiring.check.ts`, none of which exists yet):

| Seam | Producer | Consumer | Contract |
| --- | --- | --- | --- |
| `interview/ledger.ts` exports `PACKS`, `parseBranches`, `remainingBranches`, `nextBranches`, `parseRequirements`, `goalRequirementLines`, `checkTrace` | `interview-ledger` crew | `cli.ts`, tests | ADR-0008 Seams 1 to 4; erasable TypeScript, Node built-ins only (P19) |
| `interview/cli.ts` `COMMANDS` and `main(argv)`: `next` 2-3 args, `remaining` 2, `check` 1, `trace` 3; `NEXT:`, `OK:`, `ERROR:`, `TRACE:` lines; exit 0, 1 or 2 | `interview-ledger` crew | the interview and run skills | ADR-0008 Seam 5 |
| `skills/interview/branches.md` and the skill's `# Requirements` example | `interview-skill` crew | `cli.ts`, the foreman | ADR-0008 Seam 6 |
| `cli.ts` calls and the goal-file `## Requirements` example in `skills/run/SKILL.md` | `interview-wiring` crew | the foreman | ADR-0008 Seam 7 |
| `requirements.md` | the foreman, through the interview | the fact-finder (as `SPEC:` lines), the plan architect, goal files, `trace` | `parseRequirements` and its error strings, ADR-0008 Decision 7 |

## On disk

Everything for a session lives under one folder:

```
<git common dir>/foundry/<session id>/
  decisions.md               foreman: one line per decision, `- HH:MM | decision | reason | cynic | followed`
                             (0.4.0: a `## Run <start> | <goal>` heading per run; grammar below)
  events.jsonl               0.4.0, plugin: one line per spawn, stall, tag and final report
                             (0.8.0: and one per WebFetch or WebSearch call, while plan.json exists)
  events.<n>.jsonl           0.4.0, plugin: the event log rolled over, past 3 MiB
  plan.md                    foreman: the approved plan, written once the owner approves
                             (0.3.0: the architect drafts it with plan.json; the foreman owns it after that.
                             0.6.0: the plugin writes the draft from the plan-mode architect's hand-back, ADR-0015 item 9)
  plan.json                  0.3.0: the architect drafts it; the foreman owns it after that; hooks only read it.
                             0.6.0: the plugin writes the draft, with approvedAt null, from the plan-mode
                             architect's hand-back, and never over a plan that is already approved (ADR-0015 item 9)
  goals/<slug>.md            foreman: each crew's goal, done-check, owned files, high-impact paths
  reports/<crew>/<agent>.md  plugin: each crew agent's last report, judges' included
  reports/<crew>/<agent>.interim.md  plugin: a lead's interim stop
  messages.jsonl             plugin: lead-to-lead messages
  messages.<n>.jsonl         plugin: the log rolled over, past 3 MiB
  scratch/                   0.3.0, architect: plan-mode scratch output
  scratch/foundry.candidate.json  0.4.0, init: the config it would write, validated before the write (ADR-0002)
  interview.json             designed (ADR-0008), foreman: the owner interview's state for the run's first goal
  checks/<slug>-<n>.json     designed (ADR-0009), factory.ts check: one record per done-check run on the Workflow path
```

**Designed, not built yet.** `interview.json` ([ADR-0008](adr/0008-owner-interview.md), Decisions 2, 5 and 7) is the interview's state, rewritten by the foreman with Write after each round: a string `goal`, a `size` of `small`, `standard` or `large`, arrays `packs`, `opened` and `requirements` (the R-ids this run accepted), an object `visits` (`{ "by": "fact" | "owner" | "closed" | "default", "note" }` per branch id) and a boolean `stopped`; `cli.ts` exits 2 on a state file without them (Seam 5). The CLI takes the state path as an argument, so another goal can use its own file; only `<foundry dir>/interview.json` is fixed.

`requirements.md` is the interview's stored shape: one file per project, append-only by id, `## R-<n>: <title>` headings with `Status` (`open`, `met`, `dropped` or `replaced by R-<k>`), `Kind` (`functional`, `nfr` or `constraint`), `Added`, `Source` (`owner`, `default`, `goal` or `repo:<path>`), `Example` and `Measure` lines, and a required `## Non-goals` section. `parseRequirements` is its contract. The foreman writes it, commits it alone as `docs(req): ...` before the plan, marks ids `met` at the end of the run, and no crew owns or edits it (ADR-0008, Decision 7). Where it lives is an open owner decision: ADR-0008 designs and recommends the project repo, at `<dir of the architecture key>/requirements.md` (`docs/requirements.md` here and on a greenfield repo), committed so crews' worktrees see it; the alternative is the session's foundry dir under `.git`, which stays private but isn't seen by crews' worktrees or other machines (ADR-0008, Owner decisions, item 2; Decision 2).

`checks/<slug>-<n>.json` ([ADR-0009](adr/0009-workflow-factory.md), Decision 1, `check`) holds the command, exit code, `git rev-parse HEAD` of the checkout and the last 40 lines of output. `check` adds a new file each time and never changes an old one; the crew's lowest-numbered file is its red record, and `finish` refuses a merge when it is missing or has `exit` 0 (Decision 1, "finish, merge step", item 1). On the Workflow path `factory.ts finish` also writes the crew agents' reports, `reports/<slug>/<label>.md`, from the Workflow journal's results, with each file's mtime set to the agent's last transcript timestamp so `latestJudge`'s newest-file rule orders judges truthfully; it never overwrites a report with different text (Decision 1, "finish, record step" and "start, budget and label numbering across runs"). `factory.ts` also writes `plan.json` and `plan.md` (`plan-write`, the plan-file route's rules), the Workflow crews' `status`, and stamped decision lines (ADR-0009, "What moves where").

The plugin writes only `reports/`, the message logs, (0.4.0) the event logs and (0.6.0) the draft `plan.json` and `plan.md` it takes from the plan-mode architect's hand-back ([ADR-0015](../../../docs/adr/0015-agent-worktree-cleanup.md) item 9). The foreman writes `decisions.md`, `plan.md` and `goals/`, as `skills/run/SKILL.md` tells it to; the plugin only stamps the time on new `decisions.md` lines (see Decision times).

The folder is `git rev-parse --path-format=absolute --git-common-dir` run in the session's working directory, plus `foundry/<session id>`. Every worktree of a repo shares one git common dir, so all crews write to the same place. Outside git the base is `$HOME/.claude` (or `%USERPROFILE%\.claude`). The path is worked out once per session and cached; a `/clear` works it out again. Session ids, crew names and agent names pass through `safeName` in `register.ts`: each run of characters other than letters, digits, `.`, `_` and `-`, and each run of two or more dots, becomes `-`; runs of `-` collapse to one; leading and trailing `-` and `.` are dropped; the result is cut to 100 characters, and an empty result becomes `agent`.

A report file is named after the agent's spawn name, else its id, under its crew's folder. A judge's report is `reports/<crew>/<crew>-judge.md`, then `<crew>-judge-2.md` and so on; those are the merge-gate files. A red team is named `<crew>-redteam` so its report never lands on one. A successor lead `<slug>-2` is a crew of its own as far as the hooks go, with its own folder.

Each line of `messages.jsonl` is `{ "ts", "from", "to", "summary" }`, where `from` and `to` are crew names and `summary` is the `SendMessage` summary. Only messages between two leads of different crews are logged. When the log is 3 MiB or more, the next append first copies it to `messages.<n>.jsonl` at the first free `n` and starts a new log.

### `events.jsonl` (0.4.0)

Each line is one JSON object under [`events.schema.json`](events.schema.json): `{ "v": 1, "ts", "event", "crew", "agent" }` plus the event's own fields. `spawn` (a crew agent's or a lead's `Agent` call that went through) adds `agentId`, `type`, `model`, `effort` and `by`; `stall` (a stall or idle-lead wake) adds `kind` and `minutes`; `tag` (a lead's tagged message to `main`) adds `tag`; `report` (a final report saved) adds `marker`, the report's leading marker or null. No line holds message, prompt or report text. Appends are serialized like the message log's and roll at 3 MiB the same way; a failed append is logged and changes nothing else ([ADR-0003](adr/0003-event-log-and-retro.md), section 1).

From 0.5.0 one more event kind records a spent repair budget: `{ "v": 1, "ts", "event", "crew", "agent" }` and nothing else, with `agent` the judge whose FAIL spent it. It is appended after that judge's `report` line, on a v2 or later plan, whenever a saved judge FAIL leaves the crew's this-run FAIL count above `repairBudget`. `v` stays 1, because a new event kind isn't a renamed or retyped field. A crew can get the line more than once, so readers count distinct crews. The event name is fixed in [ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 3. Spawn lines gain no keys.

From 0.8.0 the `fetch` event records one `WebFetch` or `WebSearch` call ([ADR-0005](adr/0005-growth-model.md), section 11): `{ "v": 1, "ts", "event": "fetch", "crew", "agent", "tool" }` plus `url` when `tool` is `"WebFetch"` or `query` when it is `"WebSearch"`, never both. `crew` is the caller's crew slug, or `"main"` for a caller outside every crew (a `foundry:*` agent the foreman started, or the main session). `agent` is the agent's name, or `"main"` for the main session. The `url` keeps scheme, host, port and path; userinfo is removed, each query value becomes an empty string with its key kept, and the fragment is dropped (P8). The `query` is cut to its first 200 characters. The line is written only when the foundry dir resolves and holds `plan.json`, so a session that never ran foundry gets no event log from its fetches. `v` stays 1, as for the spent-budget line. The schema branch is in [`events.schema.json`](events.schema.json). Examples:

```json
{"v":1,"ts":"2026-10-29T08:12:03.512Z","event":"fetch","crew":"growth-contract","agent":"growth-contract-architect","tool":"WebFetch","url":"https://example.com:8443/docs/api?version=&lang="}
{"v":1,"ts":"2026-10-29T08:12:41.090Z","event":"fetch","crew":"main","agent":"main","tool":"WebSearch","query":"example-cli export command flags"}
```

The first came from `https://user:secret@example.com:8443/docs/api?version=2&lang=en#auth`.

On the Workflow path ([ADR-0009](adr/0009-workflow-factory.md), designed, not built yet), `factory.ts` writes spawn lines in place of the Agent hook. `start` appends one per workflow crew it starts, `{"event":"spawn","crew":slug,"agent":slug,"agentId":null,"type":"workflow-crew","model":null,"effort":null,"by":"factory"}`, and `start --resume stale` appends a fresh one with a new `ts`. `finish` appends, for each crew agent of a run, a `spawn` line with the `agentId`, the meta file's `agentType`, the `model` and `effort` the transcript records and `by: "workflow:<run id>"`, plus a `report` line with `markerOf`'s marker (Decision 1, `start` and "finish, record step"). `finish` merges only crews that have a `by: "factory"` line, and a run with no `by: "workflow:<run id>"` line counts as not recorded. ADR-0009 says `events.schema.json` doesn't change, since both `by` values are strings it allows (Decision 8). `finish` without `--result` also appends `{"v":1,"ts":"...","event":"incomplete","crew":"<slug>","run":"<run id>"}` per crew with a label in the run (Decision 1, `finish`); `incomplete` is not in the schema's `event` enum and the line has no `agent` field, which the schema requires, so as written that line doesn't validate (an open question for the build, not settled here).

### `decisions.md` grammar (0.4.0)

```
# <optional title>
## Run <RFC 3339 start> | <goal>
- HH:MM | <decision> | <reason> | <cynic> | <outcome>
- HH:MM | cynic-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>
  <two-space continuation>
```

`<outcome>` is `followed`, `followed (deferred)` or `overruled: <reason>`. One `## Run` heading per run lets `scripts/retro.py` split a session dir that holds several runs; without headings it reports the split as `"not recorded"`. retro also reads the older shapes (date-stamped lines, free-form lines, a literal `HH:MM`) and says `"not recorded"` for what they lack ([ADR-0003](adr/0003-event-log-and-retro.md), sections 2 and 3).

**Goal tags (designed in [ADR-0010](adr/0010-mid-run-intake.md), section 6; not built yet).** A goal added mid-run gets no heading of its own: it shares its run's `## Run` heading, plan, judge window and event log, so retro's run split stays as it is. Every decision line about an added goal starts its decision field with `[<id>] `, the goal's id, for example `- HH:MM | [intake] intake-gates status running | ... | none | followed`; the first is `- HH:MM | [<id>] goal added: <goal on one line> | owner request mid-run | none | followed` (section 4, step 2). Lines about the run's first goal, `run`, carry no tag. `scripts/retro.py` counts lines whose decision field matches `^\[([a-z0-9]+(?:-[a-z0-9]+)*)\] ` per goal, and adds a top-level `goals` key to its output only when `plan.json` has a non-empty `goals` array, so every existing output keeps its keys (section 6).

### `plan.json`

`plan.json` (0.3.0) is the seam between the architect, the foreman and the hooks: the goal, the architecture doc's path, `approval`, `approvedAt`, `maxParallelCrews`, and one entry per crew with its wave, verdict, modules, owned paths, done-check, whether that check was proved, estimated agents, an optional `ownerApproval` and status. [`plan.schema.json`](plan.schema.json) is the contract; [ADR-0001](adr/0001-design-phase.md), section 8, is the source. The rules it adds:

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
- `wave` is an integer of 0 or more; `maxParallelCrews` and `estAgents` are integers of 1 or more; `goal`, `architecture` and `doneCheck` are non-empty strings.

**Plan v2 (0.5.0, [ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 1).** The schema describes versions 1 and 2. `version` is `1` or `2`. A v2 plan requires the top-level `repairBudget`, an integer of 0 or more: how many fresh judges a crew may start after judge FAILs in this run. The architect copies it from `.claude/foundry.json` (default 2). A v1 plan may not carry it, and every v1 plan that was valid stays valid. There is no per-crew budget. The hooks never validate the version. `parsePlan` passes `version` and `repairBudget` through unchecked, and each 0.5.0 rule asks `planAtLeastV2` (an integer `version` of 2 or more) first. So a v3 plan inherits the v2 rules, and a v1 plan, or one with no version, gets 0.4.3 behaviour.

**Plan v3: several goals in one run (designed in [ADR-0010](adr/0010-mid-run-intake.md), sections 1 and 2; not built yet).** Today one plan holds one goal, and the plan-file route never writes over an approved plan, so a goal the owner adds mid-run has no way in but a hand edit (ADR-0010, Context, items 1, 2 and 4). The design keeps one `plan.json` per session and appends goals under the approved plan. The schema gains version `3` (enum `[1, 2, 3]`; v3 requires `repairBudget` like v2) and three fields, all v3 only:

- `goals`, top level, optional: the goals added after the run's approval, in the order they were added, each `{ "id", "goal", "addedAt", "approval", "approvedAt" }`. `id` follows the crew-slug pattern and is never `run`; `approval` is `owner` exactly when the goal has a wave-0 crew; `approvedAt` is null until the foreman logs an `auto` goal or the owner approves an `owner` one, with the same conditional as the top level. The run's first goal stays in the top-level `goal`, `approval` and `approvedAt`, and its id is the reserved word `run`.
- `crews[].goal`, optional: the goal id the crew serves. Absent means `run`, and `"run"` written out means the same.
- `crews[].after`, optional: crews, in any goal, that must be `merged` or `dropped` before this crew starts; the only cross-goal ordering.

A conditional forbids all three below version 3, so every v1 and v2 plan validates unchanged and every crew of one belongs to `run`. Waves are numbered per goal: an added goal's first wave is its wave 0, and the wave-0 and `ownerApproval` rules apply within each goal. The schema can't check that a crew's `goal` names an entry or that `after` names a crew; the hooks do (see [Plan gates](#plan-gates-030)).

Goals reach the plan through a new architect mode and a new hook route (ADR-0010, section 2). A main-session `foundry:architect` call whose prompt's first line is `Mode: amend` is tracked like a plan call, and its hand-back carries a ```` ````json plan-amend.json ```` block, `{ "goal": { "id", "goal", "approval" }, "crews": [ ... ] }`, and a ```` ````markdown plan.md ```` block. The plan-amend route calls `amendPlan(existing, amend, now)`, a pure function in the new `hooks/intake.ts`, inside the same chain as the plan-file route, writes the result to `plan.json`, and writes the markdown block to `<foundry dir>/plan-<id>.md`, never to `plan.md`. `amendPlan` refuses, and the route writes nothing and logs `plan-amend route wrote nothing: <reason>`, when the plan isn't approved yet (the foreman then re-plans in plan mode), when a block or field is malformed, when a slug collides with another goal's crew, when an `after` entry names no crew, when `approval` doesn't match the goal's wave 0, or when the goal already exists and is approved or has started crews. On success it changes only what it adds: the amend's crews get `goal` and `status: "planned"`, `version` becomes 3, and a new goal and its crews go at the end (add path), or a still-unapproved goal's crews are swapped in place keeping its `addedAt` and queue position (replace path, the reconcile round's). Every other field and every other goal's crew deep-equals its value before, which is what keeps existing crews' approval intact, and the same amend sent twice leaves the file byte-identical. `routePlanFiles` and `keepReason` don't change: a `Mode: plan` hand-back over an approved plan is still kept.

```mermaid
flowchart LR
  owner["Owner<br/>[person]"]
  foreman["Foreman<br/>[main session: /foundry:run]"]
  arch["architect-amend-&lt;id&gt;<br/>[agent: foundry:architect, Mode: amend]"]
  cynic["Cynic<br/>[agent: foundry:cynic]"]
  route["plan-amend route<br/>[hook: register.ts + intake.ts amendPlan]"]
  plan[("plan.json v3, plan-&lt;id&gt;.md<br/>[foundry dir]")]
  gate["gateOf / planVerdict<br/>[hook: tool.call on Agent]"]
  status["/foundry<br/>[command: statusOf, planLines]"]
  lead["Leads<br/>[agents: foundry:lead]"]
  owner -->|"new goal mid-run"| foreman
  foreman -->|"Mode: amend brief: goal, in-flight crews"| arch
  arch -->|"plan-amend.json + plan.md blocks"| route
  route -->|"append goal + crews, approvedAt null"| plan
  foreman -->|"verdicts, collisions"| cynic
  foreman -->|"goals[i].approvedAt, status"| plan
  foreman -->|"start ready leads"| gate
  plan -->|"read fresh"| gate
  gate -->|"allow or refuse with reason"| lead
  plan -->|"goals, crews, wait text"| status
  status -->|"every goal and what each crew waits on"| owner
```

*What mid-run intake adds around `plan.json`, as designed.* Traces to: `plugins/foundry/docs/adr/0010-mid-run-intake.md:142-166` (the diagram, copied), which traces to `hooks/register.ts:873-905` (plan route and its chain), `:327-348` (gates), `:1261-1312` (status), `:1681-1694` and `:1759-1761` (architect detection and hand-back), and `skills/run/SKILL.md:104-139` (plan architect brief), line numbers the ADR took at `fa0fa9f`, which `b81ad50` leaves unchanged in both files.

```mermaid
sequenceDiagram
  participant O as Owner
  participant F as Foreman
  participant A as architect-amend-<id>
  participant H as Hooks
  participant C as Cynic
  participant L as Leads
  O->>F: new goal while crews run
  F->>F: log "[<id>] goal added", short depth pass
  F->>A: Agent, first line "Mode: amend"
  A-->>H: hand-back with plan-amend.json and plan.md blocks
  H->>H: amendPlan: validate, append goal and crews, write plan.json and plan-<id>.md
  F->>F: find -newer marker, check ownership and after
  F->>C: review the goal's verdicts and collisions
  alt goal approval is owner
    F->>O: the goal's crew table
    O-->>F: approve
  end
  F->>H: set goals[i].approvedAt, then status running
  F->>L: start each crew whose wait text is "ready to start"
  H-->>F: refuse with the gate's reason when one applies
```

*Taking a goal mid-run, end to end, as designed.* Traces to: `plugins/foundry/docs/adr/0010-mid-run-intake.md:168-192`, which traces to `skills/run/SKILL.md:104-139` (marker and `find -newer`), `:150-162` (cynic review), `:172-204` (approval), `:206-264` (start and refusals), and `hooks/register.ts:1681-1694` and `:1759-1761`.

The foreman's side is a new `### Take a new goal mid-run` in `skills/run/SKILL.md` section 7 (ADR-0010, section 4): an owner message asking for work no crew covers, sent after `approvedAt` is set, is a new goal and the owner's ruling on frozen scope; the foreman acknowledges it in one line, logs the tagged `goal added` line, runs a short altitude and depth pass, starts the amend architect, checks the amendment, has a cynic review it with one reconcile round at most, and approves and freezes the goal's scope with section 5's rules applied to that goal alone. The top-level `approval` and `approvedAt` and other goals' entries are never edited, and merge mode and target are the run's. Whether an added goal with a wave-0 crew waits for the owner's approval of its plan before it starts is an open owner decision; ADR-0010 designs the `owner` approval that way and recommends yes (ADR-0010, Owner decisions).

One file lives in the project repo, not the foundry folder:

```
<repo>/.claude/foundry.json  0.3.0: the project's foundry config
```

`init` writes `architecture` and `adr`; from 0.4.0 it also proposes `roles`, `deploy`, `writingSkill` and `promptOverrides`, and writes those the owner approves. The owner can add any key by hand; each but the first two has a default. The contract is [`foundry-config.schema.json`](foundry-config.schema.json) ([ADR-0002](adr/0002-kit-manifest-and-config.md)). A key it doesn't declare is reported and ignored; a declared value it rejects is reported and unset. Inside `roles` and `promptOverrides` that unsets only the bad entry. `deploy` fails closed: any error inside it, an undeclared key included, unsets the whole key, so devops asks its lead. When init writes, errors in what the owner wrote are reported by path and kept; an owner value of the wrong shape to hold a key init would add, such as `roles: "x"`, is kept and that key is skipped; and only an error at a path init itself is writing stops the write:

| Key | Written by | Default | Used for |
| --- | --- | --- | --- |
| `architecture` | `init` | `docs/architecture.md`, unless the repo has an architecture doc of its own | The architecture doc's path |
| `adr` | `init` | `docs/adr` | The ADR directory |
| `maxParallelCrews` | the owner | 4 | The most crews running at once |
| `merge` | the owner | `sequential` | Merge mode of auto-started runs |
| `target` | the owner | the current branch | Target branch of auto-started runs |
| `roles`, 0.4.0 | `init` on approval, or the owner | the inventory, as 0.3.0 | Agent type per job: `build`, `test`, `review`, `search`, `docs`, `deploy` |
| `deploy`, 0.4.0 | `init` on approval, or the owner | none | `{target, command, production}` for devops; `production: true` always goes to the owner |
| `writingSkill`, 0.4.0 | `init` on approval, or the owner | none | The skill the writer loads, when listed |
| `repairBudget`, 0.5.0 | `init` on approval, or the owner | 2 | The integer of 0 or more the architect copies into a v2 `plan.json` ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 2) |
| `promptOverrides`, 0.4.0 | `init` on approval, or the owner | none | Per role (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`), a file under `.claude/foundry/prompts/` the role reads in addition to its prompt; never prompt text. The key is proposed like the others; the prompt files themselves are the owner's |

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
| `tool.call` on `Agent`, 0.5.0 | On a v2 or later plan: refuses a main-session `foundry:*` call with no `model` or a missing or unknown `effort`, and refuses a crew's judge-named spawn once its repair budget is spent (see [Repair budget and head guard](#repair-budget-and-head-guard-050)). |
| `tool.call` on `Workflow`, designed in ADR-0009, not built yet | For a main-session `Workflow` call only: refuses a script that isn't foundry's `plan.js` or `wave.js` but names a `foundry:` type, a foundry script with a bad `args.foundry` or roles table, a plan script on an approved plan, and a wave script whose crews aren't `running` or fail `planVerdict` (see [Workflow calls](#workflow-calls-designed-in-adr-0009-not-built-yet)). |
| `tool.call` on `WebFetch`, `WebSearch`, 0.8.0 | The fetch gate: runs `fetchVerdict` on every call in the session, whoever makes it, and appends its `fetch` line to `events.jsonl` when there is one. Allows every call today (see [Fetch gate](#fetch-gate-080)). |
| `tool.call` on `Write`, `Edit` | Stamps the clock's time on new lines of this session's `decisions.md`; from 0.4.0, on every literal `HH:MM` too. |
| `tool.call`, any tool | Records activity, the main session's too. On `SubagentHandback`, refuses an empty hand-back from a crew agent and captures the report. |
| `turn.step` | Records activity for each model request, the main session's too. |
| `classic.SubagentStop` | Runs the lead stop gate and saves the stopping agent's report. From 0.4.0, each final report saved (here or from `SubagentHandback`) appends a `report` line to `events.jsonl`. From 0.5.0, on a v2 or later plan, the gate also sends back a final report that lacks the Examined and Not examined sections, or that the head guard rejects. A judge FAIL that spends the budget appends the spent-budget line. |
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

The model check runs first. In 0.4.3 the foreman's own Agent calls aren't checked, though the skill tells it to set both. From 0.5.0, on a v2 or later plan, a main-session call whose `subagent_type` starts with `foundry:` must set `model` and one of the four efforts (`mainCallVerdict`, refusals `MAIN_MODEL_REFUSAL` and `MAIN_EFFORT_REFUSAL`, [ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 7). It runs before the plan gates. With no plan file, such as the plan-mode architect's start, it lets the call through. The hooks refuse `high` and `xhigh` nowhere. Whether the owner asked for them is a prompt rule, and retro's target share for them is zero.

A call that starts a lead from the main thread, or any agent from inside a crew, gets this note in its result: `[foundry] If <name>'s report does not reach you, read <path> once it stops.`

### Workflow calls (designed in ADR-0009, not built yet)

A Workflow script's `agent()` is not an Agent tool call, so none of the Agent gates above runs for it: the probe's cynic with no model ran on the session model, and a lead started past the cap ([ADR-0009](adr/0009-workflow-factory.md), Probe). ADR-0009, Decision 6, adds three things to `hooks/register.ts` and changes nothing else in it:

- `export` on the existing `fencedBlock` (`register.ts:848`), so `factory.ts plan-write` applies the plan-file route's block rules.
- Two pure exported functions. `workflowRoleVerdict(roles)` refuses a roles table with a model other than `opus` or `sonnet`, an effort other than `low` or `medium`, a missing model or effort, a `lead` or `devops` role, or a role key that doesn't match `^[a-z]+$`. `workflowCallVerdict(plan, input)` calls a script foundry's when its resolved `scriptPath` is `<pluginDir>/workflows/plan.js` or `wave.js`, or its text equals one of those files byte for byte, and then checks, in order: no plan or a plan below v2, undefined; a script that isn't foundry's but contains `foundry:`, or a `scriptPath` that can't be read, refused with "foundry agents run in a Workflow only from the plugin's plan.js and wave.js"; any other script that isn't foundry's, undefined; a foundry script with no `args.foundry` object, refused; then `workflowRoleVerdict(args.foundry.roles)`; `kind: "plan"` on a plan whose `approvedAt` is set, refused; `kind: "wave"`, refused for any crew whose `status` isn't `running` or that `planVerdict` refuses. Every refusal starts `[foundry] Refused:`.
- One handler, `on('tool.call', { tool: 'Workflow' }, ...)`, right after the Agent handler, for main-session calls only (`e.agentId === undefined`): it reads the plan within `PLAN_READ_MS`, returns the verdict's deny or calls `next(e)`, and logs each refusal with `logRule`.

The three crew-keyed Agent gates, `agentVerdict`, `effortVerdict` and the repair-budget gate, key on `crewOf(callerId)` and can't fire for a workflow agent, which has no `foundry:lead` ancestor. On the Workflow path the script's `spawn()` (throws on a role without model or allowed effort), `workflowRoleVerdict` in `start`, `plan-args` and this gate, `wave.js`'s spend count and `finish`'s transcript audit and `judgeFails` check replace them: those rules are the script's, the CLI's and the audit's, not a hook's refusal (ADR-0009, Decision 4, "What replaces the lead's gates"). `finish` also audits every Workflow run of the session since the newest `## Run` header that is foundry's or holds a `foundry:*` agent, and while any entry stands it merges nothing (Decision 1, "finish, session audit").

If a copy of a script is needed because Workflow refuses a `scriptPath` inside the plugin, `plan-args` and `start` take `--scripts-dir` and copy the script byte for byte as `foundry-plan.js` or `foundry-wave.js`; the gate still recognises the copy by its text, and an inline `script` with the same text too (Decision 6, "scriptPath fallback").

Seams (ADR-0009, Seams to pin; none of these tests exists yet):

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `fencedBlock` export | hooks | `factory.ts plan-write` | the plan-file route's block rule, `register.ts:879-904` | `tests/workflow-gate.check.ts` |
| `workflowRoleVerdict`, `workflowCallVerdict` | hooks | the Workflow handler, `factory.ts` | ADR-0009 Decisions 2 and 6 | `tests/workflow-gate.check.ts` |
| `factory.ts` commands, flags, one-line JSON output, exit codes 0, 1 and 2 | `bin/factory.ts` | the foreman, `wave.js`'s runner | ADR-0009 Decision 1 | `tests/factory.check.ts`, with fixtures in `tests/fixtures/workflow-run/` |
| `plan.js` and `wave.js` control flow, `roles.json` | `workflows/` | the Workflow tool | ADR-0009 Decisions 2 to 4 | `tests/workflows.check.ts`, with stubbed `agent()` |
| `settings` on this repo's `.claude/foundry.json` | `factory.ts` | the foreman | `{"merge":"sequential","target":"main","source":".claude/foundry.json"}` | `tests/run-procedure.check.ts` |

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

**Goal-aware gates (designed in [ADR-0010](adr/0010-mid-run-intake.md), section 3; not built yet).** For plan v3, `planVerdict` keeps its signature and prefix but is rebuilt on a new `register.ts` function, `gateOf(plan, name): { deny, waits } | undefined`, which gives each refusal a `/foundry` wait text too. A crew's goal is `goalOf(crew)`, exported from `hooks/intake.ts`: its `goal` when that is a string, else `run`. The checks, first match wins:

| # | Gate | Refusal reason | `/foundry` wait text |
| --- | --- | --- | --- |
| 1 | run approval, unchanged | `this run changes the design; get the owner's approval first` | `waits for the owner's approval of the plan` |
| 2 | the crew's goal isn't `run` and names no entry in `goals` | `<slug> names goal <id>, which isn't in the plan` | `waits for a fix: goal <id> isn't in the plan` |
| 3 | the goal's `approval` is `owner` and its `approvedAt` is null | `goal <id> changes the design; get the owner's approval first` | `waits for the owner's approval of goal <id>` |
| 4 | `ownerApproval` is `pending`, unchanged | `<slug> waits for the owner's approval` | `waits for the owner's approval` |
| 5 | an `after` entry names no plan crew | `<slug> waits for <x>, which isn't in the plan` | `waits for a fix: <x> isn't in the plan` |
| 6 | an `after` crew isn't `merged` or `dropped` | `<slug> waits for <a, b> to merge` | `waits for <a, b> to merge` |
| 7 | wave gate, within the crew's goal only | `wave <n> isn't merged yet: <slugs>` for `run`; `wave <n> of goal <id> isn't merged yet: <slugs>` for an added goal | `waits for wave <n> to merge: <slugs>` |
| 8 | parallel cap, global across goals, unchanged | `<running> crews running, the cap is <cap>; start <slug> when one merges` | `waits for a free slot: <running> of <cap> running` |

So each goal runs its own wave sequence, and a new goal's wave 0 can start while the run goal is mid-wave; `after` is the only coupling between goals. All goals share one `maxParallelCrews` and one queue, the `crews` array, with added goals' crews at its end, so at equal readiness older goals' crews start first. The foreman starts the planned crews whose wait text is `ready to start`, in array order, up to the free slots. Disjoint ownership across goals stays a plan-time rule that the amend architect and the foreman enforce; the hooks never compare `owns`. The successor and duplicate-slug rules don't change, and on a v2 plan every crew is in `run`, so the gates behave as above.

The idle-lead prompt also reads the plan, to name a successor the gates map back to the same crew: a plan slug `C` gets `C-2`, a successor `B-<n>` gets `B-<n+1>`, counting past any name that is itself a plan slug (plan `[auth, auth-2]` gives `auth-3`). It waits at most 2 seconds for that read, on the engine clock. A read that hasn't settled by then, or one that fails, gives the 0.2.1 name (`auth` to `auth-2`, `gateway-3` to `gateway-4`), and the prompt still goes out.

### Report capture

When a crew agent stops, the hook writes its last assistant message to its report file. When the agent sent its report through `SubagentHandback`, the hook writes that message instead, and the stop that follows leaves the file alone. A lead's hand-back is written only if it would pass the stop gate; otherwise the stop decides what's written.

A crew agent's hand-back under 40 characters once trimmed (`HANDBACK_MIN`), or one that is only `placeholder`, `todo` or `tbd`, is refused. A hand-back that starts `QUESTION:`, `BLOCKED:`, `PROPOSAL:` or `CHECKPOINT:` is exempt from the length, but is refused when nothing, or only a stand-in, follows the tag: `[foundry] Refused: that hand-back is too short to be a report. Hand back your real report: what you did, the branch, and proof.` If the crew can't be read, the hand-back goes through.

### The lead stop gate

A lead's stop is checked against its hand-back, else its last message. It goes through when the text starts with `CHECKPOINT:`, `BLOCKED:`, `QUESTION:` or `PROPOSAL:`, or has a `## Proof` heading, or while the lead's tagged message to `main` is unanswered (its tag in `/foundry`; any message from the foreman clears it). Otherwise the stop is sent back with:

`[foundry] Not done yet: finish with your report, in the sections Summary, Branch, Changes, Proof, Checks run and Open questions (each a "## " heading), or, if you cannot finish, start your final message with CHECKPOINT:, BLOCKED:, QUESTION: or PROPOSAL:.`

The gate sends a stop back at most twice in a row (`LEAD_STOP_BLOCKS`), then lets the next one through, so a lead can't loop forever. A stop while the lead still has work out is interim and always goes through: a descendant is live, or a background task belonging to a descendant is running or pending. A stop excused by an unanswered tag is interim too. An interim stop's text is saved to `<agent>.interim.md` and doesn't change the report file, its tag or the lead's idle period. A stop the gate sends back is saved nowhere. The gate applies to `foundry:lead` agents only.

From 0.5.0, on a v2 or later plan, an untagged text that passes by its `## Proof` section gets two more checks, in this order:

1. `examinedVerdict`: both the Examined and the Not examined headings must be present, as fixed in ADR-0004, section 3.
2. `headVerdict`: the head guard, below.

Their send-backs count in the same streak, so the two-block bound still holds. An unanswered tag doesn't excuse them. A hand-back is saved as the report only if it passes the first check. The head guard runs only at the stop, because it calls git.

### Repair budget and head guard (0.5.0)

Designed in [ADR-0004](adr/0004-scope-repair-and-head-gates.md), sections 5 and 6; the literals are in its section 3, and the exported functions in section 9. Both rules read the crew's **this-run judge files**: `reports/<crew>/<crew>-judge*.md`, not interim, modified at or after `plan.json`'s `approvedAt`. This session dir already holds `design-judge.md` to `-judge-7.md` from earlier runs that reused the crew name, so counting by name alone would be wrong.

- **Budget.** A crew's FAIL count is the number of its this-run judge files that start `VERDICT: FAIL`. Once that count is greater than `repairBudget`, the budget is spent. A judge-named spawn from inside the crew is then refused with the `BUDGET_REFUSAL` prefix, and the hooks append the spent-budget line when the FAIL that spent it is saved. The lead sends `main` the budget-blocked message and stops. A successor lead has its own folder, so it starts a fresh count.
- **Head guard.** The judge writes its head and patch lines under `## Proof checked`. At a lead's final stop, the hook takes the crew's newest this-run judge file. It must be a PASS with no UNSCOPED finding and with both lines. The hook then compares the judged head with `git rev-parse <branch>`, where the branch comes from the report's Branch line. If the head moved, it compares the judged patch id with the current one, computed by `PATCH_COMMAND`. An equal head, or an equal patch id, goes through: the patch-bound PASS. A different patch id is sent back. An unknown head or patch id fails open.
- **Merge gate.** The foreman reads the same file under the same rule, and merges a moved head only on an equal patch id with the lead's checks re-run green.

```mermaid
sequenceDiagram
  participant L as Lead
  participant H as Hooks (register.ts)
  participant J as Judge
  participant R as reports/crew/
  participant E as events.jsonl
  participant F as Foreman
  L->>H: Agent foundry:judge, name crew-judge-k
  H->>R: list and read this-run judge files
  alt FAIL count > repairBudget (v2 plan)
    H-->>L: Refused, repair budget spent
    L->>F: BLOCKED message, last findings
  else within budget
    H->>J: start
    J->>R: report with VERDICT, head and patch lines (saved at its stop)
    opt VERDICT FAIL leaves the budget spent
      H->>E: append the spent-budget line
    end
  end
  L->>H: final report (stop)
  H->>R: newest this-run judge file
  H->>H: git rev-parse branch, and on a moved head PATCH_COMMAND
  alt no clean PASS, no head lines, or patch id differs
    H-->>L: Not done yet (counts in the stop streak)
  else same head, or same patch id
    H->>F: report goes through
    F->>R: merge gate re-reads the same file
  end
```

*The bounded repair loop and the head guard on a v2 plan, 0.5.0, as designed.*
Traces to: `plugins/foundry/docs/adr/0004-scope-repair-and-head-gates.md` (sections 5 and 6), `plugins/foundry/hooks/register.ts:1662` (the `Agent` handler the gate joins), `:1837` (the stop gate, `classic.SubagentStop`), `:1028-1037` (`writeReport`, where the spent-budget line is appended), `:1174` (`judgeFilesOf`), `:475` (`latestJudge`) and `:506` (`judgeRuling`), which pick the crew's newest judge file this run and rule it (line numbers at `da17861`), `plugins/foundry/agents/lead.md:101-105`, `:153-155`.

### Seams (0.5.0)

Each row is a seam inside foundry that ADR-0004 adds or changes. The contract tests read only `tests/fixtures/contract-050/**` or inline data.

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `plan.json` v2, `repairBudget` | architect (copied from `.claude/foundry.json`) | hooks (`repairBudgetOf`, `planAtLeastV2`), foreman | `plan.schema.json` versions 1 and 2; ADR-0004 section 1 | ajv on `plan.example.json` and `fixtures/contract-050/plan-v1.json` |
| `.claude/foundry.json` `repairBudget` | owner, `foundry:init` on approval | architect | `foundry-config.schema.json`; ADR-0004 section 2 | the schema |
| Judge head and patch lines under `## Proof checked` | judge | hooks (`judgeRuling`, `headVerdict`), foreman's merge gate | ADR-0004 sections 3 and 6, `PATCH_COMMAND` | `tests/contract-gates.test.ts`, `tests/gates.check.ts` |
| Lead's Examined and Not examined headings, and its Branch line | lead | hooks (`examinedVerdict`, `branchOf`), judge | ADR-0004 sections 3, 4 and 6 | `tests/contract-gates.test.ts`, `tests/gates.check.ts` |
| Judge's UNSCOPED finding tag | judge | hooks (`judgeRuling`'s `unscoped`), foreman | ADR-0004 sections 3 and 4 | `tests/contract-gates.test.ts`, `tests/gates.check.ts` |
| Spent-budget record: the `events.jsonl` line, and the lead's budget-blocked message | hooks (line); lead (message) | retro (`budgetsSpent`, from the line only); foreman (message) | `events.schema.json`; ADR-0004 sections 3 and 5 | `tests/contract-gates.test.ts`, `tests/test_contract_retro_050.py` |
| retro's per-run `budgetsSpent` | `scripts/retro.py` | the `foundry:retro` skill | ADR-0004 section 8 (`retro` stays 1) | `tests/test_contract_retro.py` `RUN_KEYS`, `tests/test_contract_retro_050.py` |
| Main-session `foundry:*` calls on a v2 plan | foreman | hooks (`mainCallVerdict`) | ADR-0004 section 7 | `tests/contract-gates.test.ts` |

### Fetch gate (0.8.0)

Designed in [ADR-0005](adr/0005-growth-model.md), section 11. Every `WebFetch` and `WebSearch` call in the session, whoever makes it, passes one exported pure function. A guardrail added later (an allowlist, a deny list, an owner prompt, a size or count cap) is a change to this function and its tests alone; no prompt names a source, a domain or a limit.

```ts
export type FetchEvent =
  | { event: 'fetch'; crew: string; agent: string; tool: 'WebFetch'; url: string }
  | { event: 'fetch'; crew: string; agent: string; tool: 'WebSearch'; query: string }
export type FetchVerdict = { kind: 'allow'; line: FetchEvent | null } | { kind: 'deny'; line: FetchEvent | null; reason: string }
export function fetchVerdict(tool: 'WebFetch' | 'WebSearch', input: { readonly url?: unknown; readonly query?: unknown }, crew: string, agent: string, hasPlan: boolean): FetchVerdict
```

- **Pure (P3).** It takes plain values and touches neither `$` nor the file system. `FetchEvent` joins the `FoundryEvent` union; `appendEvent` adds `v` and `ts` as for every line.
- **Inputs.** `tool` is the call's tool name and `input` the call's input (`e as unknown as { url?: unknown; query?: unknown }`, as the `SendMessage` handler reads its input). The handler resolves `crew` and `agent` before the call: `crew` is the caller's crew slug from `crewOf`, or `"main"` for a caller outside every crew (a `foundry:*` agent the foreman started, or the main session); `agent` is the agent's name, or `"main"` for the main session. `hasPlan` is true when the foundry dir resolves and `plan.json` exists in it.
- **Decision.** `kind` is `'allow'` for every call today. A later guardrail returns `{ kind: 'deny', line, reason }`; `reason` is the refusal text the caller sees.
- **Line.** `line` is `null` when `hasPlan` is false. Otherwise it is the `fetch` event for the call, with `crew`, `agent` and `tool` as passed. For `WebFetch`, `url` is `input.url` with userinfo removed, each query value replaced by an empty string (keys kept, in order, duplicates kept), and the fragment dropped; scheme, host, port and path stay as the WHATWG `URL` parser gives them, so a default port is dropped. `https://user:secret@example.com:8443/docs/api?version=2&lang=en#auth` gives `https://example.com:8443/docs/api?version=&lang=`. A `url` that isn't a string, or doesn't parse, is logged as `""`. For `WebSearch`, `query` is `input.query` cut to its first 200 characters (`slice(0, 200)`); a non-string is logged as `""`.
- **The handler.** `on('tool.call', { tool: ['WebFetch', 'WebSearch'] }, ...)`, ending in `.catch(failOpen)` (P5), like the `Write`/`Edit` handler. It calls `fetchVerdict`, awaits `logEvent` with a non-null `line`, then returns `{ deny: reason }` when `kind` is `'deny'` (the refusal shape `agentVerdict` uses) and calls `next(e)` when it is `'allow'`. `logEvent` queues the append like every event line, waits at most `EVENT_WAIT_MS` and never rejects, as for `spawn` lines; a failed append, a throwing `$.fs.write` included, is logged and never blocks the call.

```mermaid
sequenceDiagram
  participant C as Caller (member, lead, foundry agent or main session)
  participant H as tool.call handler (register.ts)
  participant V as fetchVerdict
  participant Q as event queue (logEvent)
  participant E as events.jsonl
  participant T as WebFetch or WebSearch
  C->>H: WebFetch url, or WebSearch query
  H->>H: crew and agent (crewOf, or "main"); hasPlan (dir resolves, plan.json exists)
  H->>V: tool, input, crew, agent, hasPlan
  V-->>H: kind allow, line or null
  opt line is not null
    H->>Q: logEvent(line), waits at most EVENT_WAIT_MS
    Q->>E: append v, ts and the line (a failure is logged only)
  end
  H->>T: next(e), the call goes through
```

*The fetch gate, 0.8.0, as designed: every call is allowed, and a line is logged while a plan exists.*
Traces to: `plugins/foundry/docs/adr/0005-growth-model.md` (section 11), `plugins/foundry/hooks/register.ts:166-171` (`FoundryEvent`), `:1027-1033` (`appendEvent`, which adds `v` and `ts`), `:1064-1083` (`logEvent`'s queue, wait cap and failure log), `:1694` (the awaited `spawn` line), `:1587-1588` (how a handler reads its input), `:1768-1779` (the `Write`/`Edit` handler the fetch handler follows).

### Seams (0.8.0)

Each row is a seam inside foundry that ADR-0005 adds or changes. The contract tests read only `tests/fixtures/contract-080/**` or inline data.

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `fetchVerdict` and the fetch handler | hooks | the session's `WebFetch` and `WebSearch` calls; `appendEvent` | the signature and rules above; ADR-0005 section 11 | `tests/contract-fetch.test.ts` |
| The `fetch` line in `events.jsonl` | hooks | retro (`fetches`) | `events.schema.json` `fetch` branch; "On disk" above | `tests/contract-fetch.check.ts`, `tests/test_contract_retro_080.py` |
| retro's per-run `fetches`, `extendPasses`, `defaultDecisions`, `openOwnerActions` | `scripts/retro.py` | the `foundry:retro` skill; retro's JSON stays internal (P15) | `fetches` is `{total, perAgent: {<agent>: n}}`; `extendPasses` counts commits in the run's window whose subject starts `docs(arch): extend ` or is `docs(arch): adopt learned items`; `defaultDecisions` counts ADRs in the adr dir holding the line `Decided by: default`; `openOwnerActions` counts `- [ ] ` lines under an `Owner actions` heading; each is `"not recorded"` where its source is absent, as ADR-0003 does | `tests/test_contract_retro_080.py` |
| The plan-mode `UNCOVERED: ` hand-back | architect | foreman; `routePlanFiles`, which writes nothing for it | ADR-0005 section 4 and its literals table | `tests/contract-fetch.test.ts` (regression guard), `tests/gates.check.ts` |
| A lead report's optional `## Learned` section | lead | foreman's run-end extend pass; `leadStopPasses`, which neither needs nor refuses it | ADR-0005 section 7 | `tests/contract-fetch.test.ts` (regression guard), `tests/gates.check.ts` |
| The fetch rule, the literals and the web tools in the prompts | `agents/*.md`, `skills/run/SKILL.md` | every agent and the foreman | ADR-0005 sections 2, 3 and the literals table | `tests/gates.check.ts` |

### retro's leftover details (0.9.0)

Designed in [ADR-0006](adr/0006-leftover-causes.md). retro's top-level keys are now `retro`, `dir`, `split`, `runs`, `judgeFiles`, `plan`, `eventsSkipped`, `eventsOutsideRuns`, `leftovers` and `leftoverDetails`. `leftoverDetails` is `"not recorded"` whenever `leftovers` is (and when `git worktree list --porcelain` fails), else an array sorted by `id`, one entry per agent `leftovers` counts, each with exactly the keys `id`, `branch`, `folder`, `head`, `dirty`, `inMain` and `skip` (null where absent). `skip` is the reason worktrees' `decideSelfClean` would give, checked in its order for the checks retro can see, or `passes every check retro can see`. retro copies those rules from `plugins/worktrees/hooks/register.ts:734-752` without importing them (repo ADR-0001), so they can drift; ADR-0006 section 1 records the source and what retro can't see.

```mermaid
flowchart LR
  retro["retro.py<br/>[foundry script: Python]"]
  events[("events.jsonl<br/>[foundry dir]")]
  git[("Local git<br/>[refs, worktree list, main checkout HEAD]")]
  disk[(".claude/worktrees/agent-id<br/>[folders on disk]")]
  skill["foundry:retro<br/>[skill: skills/retro/SKILL.md]"]
  sweep["worktrees sweep<br/>[other plugin: decideSelfClean]"]
  retro -->|"reads spawn agentIds"| events
  retro -->|"for-each-ref, worktree list, status, is-ancestor, merge-tree (quarantined), cherry, branch --show-current"| git
  retro -->|"isdir"| disk
  retro -->|"JSON: leftovers, leftoverDetails"| skill
  sweep -.->|"rules copied by hand, never imported"| retro
```

*Where `leftoverDetails` comes from: git and the disk only; the dashed edge is the copied rule set, not a call.*
Traces to: `plugins/foundry/scripts/retro.py:452-472` (`leftovers`, which `leftoverDetails` shares its ids and "not recorded" rules with), `:410-419` (`git_out`, `GIT_OPTIONAL_LOCKS=0`); `plugins/worktrees/hooks/register.ts:734-752` (`decideSelfClean`), `:1261-1272` (`inMainBy`), `:1324` (the detached drop); ADR-0006 section 1.

```mermaid
sequenceDiagram
  participant S as foundry:retro skill
  participant R as retro.py
  participant G as Local git
  participant J as reports/*/*-judge*.md
  S->>R: python retro.py <foundry dir>
  R->>G: worktree list --porcelain; status; is-ancestor / merge-tree / cherry; branch --show-current
  R-->>S: leftoverDetails [{id, branch, folder, head, dirty, inMain, skip}]
  S->>J: VERDICT: and finding lines only (P24)
  S->>G: at most 3 reads per anomaly
  S-->>S: CAUSE: <anomaly> | <evidence> | <fix location>
```

*The root-cause step: one `CAUSE:` line per anomaly, from git, the disk, `decisions.md`, judge verdict and finding lines and the plugin's own files.*
Traces to: ADR-0006 section 3; `plugins/foundry/skills/retro/SKILL.md` (sections 2 to 4, after wave 1).

The red team's first step becomes `git reset --hard <sha>` in its own worktree (no longer `git checkout --detach <sha>`), and before it reports it runs `git reset --hard <sha>` and `git clean -fd` and confirms `git status --porcelain --untracked-files=all` prints nothing. It never commits, even when the worktrees hook tells it to commit; it discards instead (ADR-0006 section 2).

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| retro's `leftoverDetails` | `scripts/retro.py` | the `foundry:retro` skill's root-cause step; retro's JSON stays internal (P15) | ADR-0006 section 1 | `tests/test_contract_leftover_details.py` |
| retro's top-level key set | `scripts/retro.py` | the `foundry:retro` skill | `TOP_KEYS` grows by exactly `leftoverDetails` | `tests/test_contract_retro.py`, `tests/test_contract_retro_050.py` |
| The red team's start and end state | `agents/judge.md`, `agents/lead.md` | the red-team judge; worktrees' sweep | ADR-0006 section 2 and its literals table | `tests/redteam-reset.check.ts` |
| The root-cause step | `skills/retro/SKILL.md` | the model running `/foundry:retro` | ADR-0006 section 3 | `tests/retro-cause.check.ts` |

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

Prints `Crews (<n>):` and one line per lead: name, status (`ended` once the agent list drops it), live members by model family, then one of `waiting on you: <question>`, `blocked: <text>`, `proposal: <text>`, `waiting on members`, `no report yet` or `last report <time> ago`, then `last active <time> ago`. Under each lead it lists stalled agents, the verdict in the crew's newest judge file this run and the report folder. That verdict is read the way the merge gate reads it: `judgeFilesOf` (`register.ts:1174`) lists the crew's judge files, `latestJudge` (`:475`) picks the newest one modified at or after `approvedAt`, and `judgeRuling` (`:506`) rules it, so a `VERDICT:PASS` with no space is no PASS here either. (Foundry 0.10.0, built by the `hooks-cleanup` crew; until then status kept a parser of its own that picked the file by its `-judge-<k>` number.) Then it lists one line per member: `<name> <status> <n>m (<family>), last activity <time> ago` (or `no activity seen`), timed from its spawn or first sighting. The last lines name the message log, when there is one, and `Foundry dir: <path>`. With no crews it prints `No foundry crews in this session. Start them with /foundry:run.` If reading the crews fails: `foundry could not read the crews; see the debug log.`

From 0.3.0, `/foundry` first shows the plan, read through the same guard as the gates: `Plan (<n> crews, approval <approval>):`, with `, waiting for the owner` added while `approval` is `owner` and `approvedAt` is null, then one line per crew sorted by wave, ties in `crews` order: `- wave <wave>: <slug>, <verdict>, <status>`, with `, waits for the owner's approval` when `ownerApproval` is `pending`. A missing field prints as `?`. Then come the lines above. With no plan, or one it can't read, the output is the 0.2.1 output.

**Goals and wait reasons (designed in [ADR-0010](adr/0010-mid-run-intake.md), section 5; not built yet).** `planLines` changes in two ways. Every `planned` crew gets `, ` plus its wait text from `gateOf` (see [Plan gates](#plan-gates-030)), or `, ready to start` when no gate refuses it; other statuses get no suffix, and a pending crew's line reads as before. When `goals` is a non-empty array, the header becomes `Plan (<n> crews, <k> goals, approval <a><waiting>):` with `k = 1 + goals.length`, and each goal gets a line, `Goal <id> (approval <a>[, waiting for the owner][, done]): <text>`, with its crews under it in today's order: `run` first, then `goals` in array order, then any unknown ids crews name, as `Goal <id> (not in the plan):`. `<text>` has each whitespace run collapsed to one space and is cut to its first 99 characters plus `…` when longer than 100. Without `goals` there are no goal lines and the header is today's. ADR-0010's example, a plan with the run's four crews and one added goal `intake`:

```
Plan (7 crews, 2 goals, approval owner):
Goal run (approval owner): Make foundry prod-grade on quality and bloat, from the reviewed anti-bloat analysis: (1) hook clean…
- wave 0: eval-design, design, merged
- wave 1: hooks-cleanup, extend, merged
- wave 1: evals-build, change, running
- wave 2: prompt-rules, change, planned, waits for wave 1 to merge: evals-build
Goal intake (approval owner): Mid-run intake: start new crews mid-run, tell the owner what is in progress, take more work
- wave 0: intake-design, design, running
- wave 1: intake-gates, change, planned, waits for prompt-rules to merge
- wave 1: intake-retro, change, planned, waits for prompt-rules to merge
```

The live-crew block below it doesn't change, and the foreman answers a progress question from this view or from `plan.json`, one line per goal.

### Failing open

Each hook step runs inside a guard. If foundry's code throws, the guard logs `foundry: <step> failed, letting the call through: <error>` or `foundry: a hook failed and was skipped: <error>` to the debug log, and the call goes on as if the plugin weren't installed. A step that fails refuses nothing.

The Workflow handler (designed in [ADR-0009](adr/0009-workflow-factory.md), Decision 6; not built yet) fails open the same way, through `.catch(failOpen)`. So a throw in the Workflow gate, or a `tool.call` that never fires for the main session's Workflow call, lets the run through unchecked. The gates don't rest on that hook alone: `factory.ts start` refuses a crew `planVerdict` refuses, `spawn()` in `plan.js` and `wave.js` throws before `agent()` on a role that is missing or fails `workflowRoleVerdict`'s rules, and `finish`'s session audit blocks every merge while it finds a `foundry:*` agent in a run that isn't foundry's, or an agent of an in-scope run with no explicit model or a model family other than opus or sonnet. So without the hook an agent on the wrong model can still run and spend tokens, but its work can't reach the target (ADR-0009, Decision 6).

## Failure modes and recovery

**A stalled agent.** The heartbeat prompts the foreman. The foreman messages the stalled agent's lead, or the lead itself, and asks for its state. `/foundry` keeps showing the agent as stalled until it does something. Before stopping it, the foreman or lead reads its transcript tail: a resumed agent may be compacting.

**An idle lead.** A lead seen to go idle without a final report in its stint, while no member works, gets one `[foundry] idle lead:` prompt after 15 minutes. The foreman resumes it with a message, or starts its successor from its report.

**The usage limit.** When the five-hour window runs out while crews work, the limit-reset wake prompts the foreman after the reset. The foreman messages each lead that hasn't sent its final report: "Usage limit reset. Resume from where you stopped."

**A lead stops with work left.** Its report starts with `CHECKPOINT:`. The foreman starts a fresh lead, `<slug>-2` (then `-3`), from that report. The successor's brief names the original goal file, the predecessor's branch and commit, and the crew's original base commit; the successor resets its worktree to the predecessor's branch first. Its members, judges and report folder carry its own name. The other leads are told the new name. A member that stops with `CHECKPOINT:` is handled the same way inside the crew: a fresh member from its handoff note, never a resume.

**A lead tries to stop without a report.** The stop gate sends it back, at most twice in a row. After that the stop goes through, and the foreman sees a report that isn't in the fixed format.

**A lost hand-back.** Hand-backs from nested agents have been lost on some machines. The report is on disk anyway: the lead reads `reports/<crew>/<member>.md`, and the foreman reads `reports/<lead>/<lead>.md`, at the path in the `[foundry]` note from the Agent call.

**A judge FAIL.** The lead sends the findings to a builder. Each later judge is a fresh agent under the next unused name, never a resume, and any fix after a FAIL or a red-team break needs a fresh judge. When two fix attempts at one level end with the same check failing, the lead climbs the ladder: Sonnet, then Opus at `medium`, `high`, `xhigh`, each step a fresh agent whose first deliverable is a root-cause analysis with evidence. When `xhigh` fails twice, the lead sends `BLOCKED:` with the failing check, its output and the theories ruled out, and the foreman takes it to the owner. In `single` mode an integration-judge FAIL goes back to the integrator, and a fresh `integration-judge-2` rules next.

From 0.5.0, on a v2 plan, the judge FAILs a crew may repair are bounded. Once a crew's this-run FAIL count is greater than `repairBudget`, the hooks refuse its next judge, and the lead sends the budget-blocked message to `main` with the last findings. A spent budget goes to the foreman, never up an effort level. The foreman takes it to the owner, or re-plans; a successor lead starts a fresh count ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 5).

**A verdict on the wrong commit.** The foreman merges only when the judge file's `## Proof checked` SHA equals `git rev-parse <crew branch>`. After a merge of the target (a rebase before 0.6.0) that moved the head, the old PASS doesn't count. From 0.5.0 the SHA is the judge's head line, and a PASS also stands for a moved head when the patch line equals the merged branch's `PATCH_COMMAND` id, with `<base>` the target head last merged in, and the lead's checks passed again after the merge. The lead stop gate enforces the same rule as a send-back ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 6).

**A reload mid-session.** The module's memory starts over. An agent that ended before the reload resolves to no crew, so a message to it from a crew agent is refused. A pending limit-reset wake survives in plugin state.

## Not verified yet

- The 0.5.0 rules are a design until run 3's wave 1 merges. One thing was checked at design time: `PATCH_COMMAND` gives the same id, `a40f2083…`, for `edeb6ef...80d4ccd` (a merge commit) and for `9ab68c0^...9ab68c0` (the single commit it merged), and prints nothing for an empty range (`80d4ccd...80d4ccd`). The hook's two-step form feeds the diff to `git patch-id` through `$.process.run`'s `stdin`, which worktrees' hooks already use (`plugins/worktrees/hooks/register.ts:843`). It hasn't been run from foundry's hooks.

- The 0.3.0 plan gates, `/foundry` plan lines and idle-prompt successor name are covered by `tests/v03.test.ts`, run against the mock engine, not observed in a live run. [`plan.example.json`](plan.example.json) validates against [`plan.schema.json`](plan.schema.json).

- No prompt in 0.2.0, neither the skill nor any of the five agents, has run as a live agent in a 0.2 run. The hooks are covered by `tests/crew.test.ts`, `tests/hooks.test.ts` and `tests/v02.test.ts`, which run `register.ts` against the mock engine from `claude-code/testing`.
- A lead's status after it ends a turn while its members still run is unobserved. `/foundry` shows `waiting on members` for a lead that isn't `running` and has live descendants, and the stall check skips any agent that isn't `running`; both rest on that status.
- Capturing a report from `SubagentHandback` is covered by tests, not observed live.
- The limit-reset wake rests on three things a probe confirmed: `$.clock` timers run from `session.start`, a hot reload cancels them (so the wake is re-armed from plugin state), and `$.prompt.submit` wakes an idle session. Nobody has yet seen the wake fire after a real usage-limit stop.
- Where an organization manages Claude Code, `SubagentStop` hooks run only in plugins it lists. There, reports come only from the hand-back tool. The lead stop gate is a `SubagentStop` hook too, so it shouldn't run there either; that is inferred from the code, not seen.
- `/goal` is session-only: a Stop hook on the main session judges it, so a lead can't use it. Foundry uses the goal file and the lead stop gate instead (backlog item 20).
- The gate's two-block bound relies on the engine setting `stop_hook_active` on the stop after a block. That comes from the hook type docs and hasn't been seen live. Claude Code also lets a stop through itself after 8 consecutive blocks.
- The Workflow path ([ADR-0009](adr/0009-workflow-factory.md), "Probe") is a design, and four facts it touches are unverified. Each has a design answer that doesn't rely on it: whether `tool.call` fires for the main session's own `Workflow` call (if not, the CLI and `finish`'s audit hold the gates); whether `scriptPath` accepts a file inside the plugin (the fallback is the `--scripts-dir` copy, then the inline `script`, then `start --no-workflow`); whether the Workflow call blocks the foreman's turn until the script returns (the stale-run rules cover a dead run either way); and what `agent()` returns when the agent ends with SubagentHandback, not final text. Also unverified: that a `foundry:lead` run by `agent()` has no Agent tool (inferred from `kit:builder` in probe 2); whether a SendMessage from a workflow agent reaches the foreman or a lead; whether Workflow accepts a script the CLI, not the harness, placed in the session's `workflows/scripts/` dir; and that agent transcripts are appended every turn, which the stale check relies on. The stale rule's `STALE_MS` of 30 minutes is a chosen margin, not a proof.

*Drafted with AI assistance and reviewed by the author.*
