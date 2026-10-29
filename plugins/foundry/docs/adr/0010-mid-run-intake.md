# ADR-0010: mid-run intake, several goals in one run

Status: proposed, 2026-10-29. Written by the design crew `intake-design` (a mid-run design slice in wave 1), for the foundry release after 0.10.0. It becomes accepted when the foreman merges this crew. Not repo ADR-0010.

VERDICT: change. The interface that can't take the work is `plan.json` with its plan-file route and gates (`docs/plan.schema.json`; `hooks/register.ts` `Plan`, `planVerdict`, `planLines`, `keepReason`, `routePlanFiles`). It holds one goal, has no way to append crews once `approvedAt` is set, and runs one global wave sequence, so a goal added mid-run either waits for every crew already in flight or is hand-edited into a wave it doesn't belong to.

## Context

The owner's words (decisions.md, 17:35): "add another work here to add ability to start new crews mid-way. our factory cant tell users that it is working on something and cant pick more work..."

What happens today, checked against the code at `fa0fa9f`:

1. **One plan per session.** `planPath(dir)` is `${dir}/plan.json` (`hooks/register.ts:287-289`), and `dir` is `<git common dir>/foundry/<session id>` (`foundryDir`, `:126-129`). The schema has a single `goal` string (`docs/plan.schema.json`, `properties.goal`). This run's `plan.json` still carries only the first goal: its `goal` field holds the anti-bloat text, and the three goals added at 17:35 appear only as crews and in `decisions.md`.
2. **The plan-file route never writes over an approved plan.** `keepReason` (`:859-869`) returns `'it is approved'` unless `approvedAt === null`, and `routePlanFiles` (`:879-905`) then logs `plan-file route kept the existing plan: it is approved` and writes nothing. The claim is right, with one detail: the plan is kept for any `approvedAt` other than exactly `null`, including a missing one. So no plan architect can add a goal's crews once the run is approved.
3. **`decisions.md` is per session, and retro splits it by `## Run`.** `isDecisionLog` (`:655-657`) matches `/foundry/<session>/decisions.md`. `skills/run/SKILL.md:22` writes one `## Run <start> | <goal>` heading per run. `scripts/retro.py:47` (`HEADING`) and `read_decisions` (`:193-241`) split on that heading only, and `read_plan` (`:385-414`) counts crews for the whole plan, with no per-goal view.
4. **The only ways to add crews are a mid-run design slice or a hand edit.** `skills/run/SKILL.md:274-288` (section 7, "Run a mid-run design slice") is written for a lead's design `PROPOSAL:`. It covers adding a design crew, not a new goal. This run used it for owner goals (decisions.md 17:35). At 16:42 the foreman had first sent the new goals to their own sessions, because "one session holds one plan.json and one decisions.md". Then the foreman hand-edited three design crews into wave 1 of `plan.json`. The goal-file claim is right.
5. **The wave gate and cap are global.** `planVerdict` (`:327-348`): the wave gate refuses a crew while any other crew in a lower wave isn't `merged` or `dropped` (`:334-342`), whatever goal that crew serves. The cap counts every other crew whose `status` is `running` against `maxParallelCrews` (default `DEFAULT_CAP = 4`, `:285`, `:343-347`). In this run the effect shows: `prompt-rules` (wave 2) now waits on `intake-design`, `speed-design` and `interview-design` as well as on its own goal's `evals-build`, because the hand-edit put them in wave 1.
6. **`/foundry` shows no goals and no reasons.** `statusOf` (`:1261-1312`) puts `planLines` (`:356-367`) above the live-crew lines. `planLines` prints one line per crew, `- wave <w>: <slug>, <verdict>, <status>`. The only reason it ever gives is `, waits for the owner's approval` (`:363`). It names no goal and doesn't say what a planned crew is waiting for.

## Options

- **A. Amend mode: one plan per session, goals appended under the approved plan (chosen).** A new architect mode hands back one goal's crews. A new hook route appends them to `plan.json` and leaves every existing byte of meaning untouched. The gates become goal-aware.
- **B. Several plans per session (`plan-<goal>.json`).** Rejected. The cap and cross-goal file ownership need every running crew. So `planVerdict`, `planCrewFor` and `planLines` would all read and merge N files, and slug uniqueness across files would go unchecked. `retro.py read_plan` reads one file, and `runStart` (`:443-448`) needs one `approvedAt`. It is more files and more readers for the same data.
- **C. One session per goal (what 16:42 did).** Rejected. Two sessions on one repo can't see each other's `plan.json`. The cap stops being a cap (each session allows `maxParallelCrews`), nothing checks file ownership across them, and the owner has two `/foundry` views and two logs.
- **D. Keep hand-editing `plan.json` (17:35).** Rejected. Nothing validates the edit, the added goal isn't recorded as a goal, and section 7's rules (meant for lead proposals) get stretched over owner goals.
- **E. Append the new goal's crews as waves after the last wave.** Rejected. Under the global wave gate the new goal waits for everything in flight, so the factory still "cant pick more work" in practice.

## Decision

### 1. `plan.json` version 3: goals, a crew's goal, a crew's `after`

`docs/plan.schema.json` gains version `3`. The version enum becomes `[1, 2, 3]`. The `repairBudget` conditional's `if` becomes `{"version": {"enum": [2, 3]}}`, so v3 requires `repairBudget` too. New fields:

| Field | Where | Type | Meaning |
|---|---|---|---|
| `goals` | top level, optional, v3 only | array, `minItems: 1`, of goal objects | The goals added after the run's approval, in the order they were added. The run's first goal stays in the top-level `goal`, `approval` and `approvedAt`, unchanged; its id is the reserved word `run`. |
| `goals[].id` | goal object, required | string, the crew-slug pattern `^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$`, `maxLength: 100`, `not: {"const": "run"}` | The goal's handle in `/foundry`, in crews' `goal` field and in `decisions.md` tags. |
| `goals[].goal` | required | string, `minLength: 1` | The goal as the owner gave it. |
| `goals[].addedAt` | required | string, `format: date-time` | When the hook appended it (its clock, RFC 3339 UTC, `Z`). |
| `goals[].approval` | required | `"auto"` or `"owner"` | `"owner"` exactly when the goal has a crew in its wave 0, as for a run (section 5 of run/SKILL.md). |
| `goals[].approvedAt` | required | string `date-time` or `null` | Null until the foreman logs (auto) or the owner approves (owner). A conditional mirrors the top-level one: `approval: "auto"` requires a string, so an auto goal on disk fails the schema until the foreman logs it, exactly as an auto plan does today. |
| `crews[].goal` | crew, optional, v3 only | string, crew-slug pattern | The id of the goal the crew serves. Absent means `run`. |
| `crews[].after` | crew, optional, v3 only | array of crew-slug strings, `minItems: 1`, `uniqueItems: true` | Crews, in any goal, that must be `merged` or `dropped` before this crew starts. It is the only cross-goal ordering. |

A top-level `allOf` conditional forbids `goals` when `version` is 1 or 2, and forbids `goal` and `after` on any crew then (`crews.items.not.anyOf: [{required:[goal]},{required:[after]}]`). The schema can't check that `goal` names an entry or that `after` names a crew. The hooks check both and refuse on failure (section 3). Existing v1 and v2 plans validate unchanged. Every crew of a v2 plan belongs to `run`, so all hook behaviour on them is unchanged, apart from the `/foundry` suffixes in section 5.

Waves are numbered per goal: an added goal's first wave is its wave 0. The existing schema rules apply within each goal: wave 0 means `verdict: "design"`, and `ownerApproval` only on design crews.

### 2. Amend mode and the plan-amend route

**Architect.** `agents/architect.md` gains `## amend mode` after `## design mode`. The foreman starts it. Its brief's first line is exactly `Mode: amend`. The brief carries the goal id, the goal text, the foundry dir, the schema path, and the in-flight crews from `plan.json`: each crew's slug, goal, `owns`, `status`, and the goal id it serves. The architect applies plan mode's verdict and breakdown rules, with crews, waves and verdicts, done-checks proved, `estAgents` and the leaf test, to the new goal only. On top of plan mode's rules it never edits or reorders an existing crew. No new crew's `owns` may match a path owned by a crew of another goal that isn't `merged` or `dropped`, unless the new crew's `after` names that crew. A new crew that needs another goal's unmerged interface names that crew in `after`. Its hand-back carries the plan-mode report lines plus two fenced blocks: ```` ````json plan-amend.json ```` holding `{ "goal": { "id", "goal", "approval" }, "crews": [ ... ] }`, and ```` ````markdown plan.md ```` holding the goal's readable plan (plan mode's `plan.md` content, for this goal only). The architect writes no file but its untracked scratch, as in plan mode.

**Hook detection.** In the `tool.call` handler on `Agent` (`register.ts:1681`), a main-session `foundry:architect` call whose prompt's first line, trimmed as today, is `Mode: amend` is tracked like a plan call. `State.pendingPlanCalls` (`:796`) becomes a `Map<string, 'plan' | 'amend'>` keyed by tool_use_id. `State.planArchitects` (`:794`) becomes a `Map<string, 'plan' | 'amend'>` keyed by agent id, with its binding at `:1581` and `:1694` and its clear at `:1556-1557`. At the hand-back (`:1759-1761`), a `'plan'` id goes to `writePlanFiles` as today. An `'amend'` id goes to the new `writeAmendFiles`, which shares the `state.planRoute` chain (`:873-877`), so plan and amend routes never interleave.

**Merge rule.** The new file `hooks/intake.ts` exports a pure `amendPlan(existing: unknown, amend: unknown, now: string): { plan: Record<string, unknown>; id: string } | { reason: string }`. It imports nothing from `register.ts`. The route reads `plan.json` fresh inside the chain, calls it, and writes the result with `JSON.stringify(plan, null, 2) + '\n'`. It writes the `plan.md` block to `<foundry dir>/plan-<id>.md` and never touches `plan.md`. `amendPlan` refuses, and the route writes nothing and logs `plan-amend route wrote nothing: <reason>`, when:

- there's no readable plan (`parsePlan` undefined), or its top-level `approvedAt` isn't a string: `the plan isn't approved; give the goal to the plan architect instead`. Before approval the scope isn't frozen, so the foreman re-plans with plan mode;
- either block is missing or not JSON, or the amend isn't an object;
- `goal.id` fails the slug pattern or is `run`; `goal.goal` isn't a non-empty string; `goal.approval` isn't `auto` or `owner`;
- `crews` isn't a non-empty array of objects, or a crew's `slug` fails the pattern, repeats within the amend, or equals a slug of an existing crew outside this goal;
- an `after` entry names no crew in the existing plan or the amend;
- `goal.approval` is `"owner"` and no amend crew has `wave: 0`, or `"auto"` and one has;
- `goal.id` already exists in `goals` and that goal has `approvedAt` set (`goal <id> is approved`) or any crew of it isn't `planned` (`goal <id> has started crews`).

When `goal.id` exists, its `approvedAt` is null and all its crews are `planned`, the amend **replaces** that goal's entry and crews in place. This is the reconcile round's path (section 4). So the same amend sent twice leaves the same plan (core 7).

On success it returns the existing object with these changes only: `version: 3`; `goals` becomes the old `goals` (or `[]`) plus, or with in place, `{ id, goal, addedAt: now, approval, approvedAt: null }`; and `crews` becomes the old crews plus the amend's crews at the end, each with `goal` set to the id and `status` set to `"planned"`, whatever the hand-back carried. Every other top-level field and every existing crew object deep-equals its value before the write. **That is what keeps existing crews' approval intact:** the top-level `approval` and `approvedAt`, each existing crew's `status`, `wave` and `ownerApproval`, and every earlier goal's entry pass through untouched. It logs `plan-amend route added goal <id>: <n> crews` (core 8). `routePlanFiles` and `keepReason` don't change: a `Mode: plan` hand-back over an approved plan is still kept.

### 3. The gates (`planVerdict`)

`Plan` (`:282`) and `parsePlan` (`:296-305`) also carry `goal` and `goals`. `planVerdict` keeps its signature and its `${MARK} Refused: ` prefix. It is rebuilt on a new `register.ts` function `gateOf(plan, name): { deny: string; waits: string } | undefined`, which runs these checks in order. First match wins:

| # | Gate | Refusal text (after `[foundry] Refused: `) | `/foundry` wait text |
|---|---|---|---|
| 1 | run approval: top-level `approval === 'owner' && approvedAt === null` (unchanged) | `this run changes the design; get the owner's approval first` | `waits for the owner's approval of the plan` |
| 2 | the crew's `goal` names no entry in `goals` (new) | `<slug> names goal <id>, which isn't in the plan` | `waits for a fix: goal <id> isn't in the plan` |
| 3 | goal approval: the crew's goal entry has `approval === 'owner' && approvedAt === null` (new) | `goal <id> changes the design; get the owner's approval first` | `waits for the owner's approval of goal <id>` |
| 4 | `ownerApproval === 'pending'` (unchanged) | `<slug> waits for the owner's approval` | `waits for the owner's approval` |
| 5 | an `after` entry names no plan crew (new) | `<slug> waits for <x>, which isn't in the plan` | `waits for a fix: <x> isn't in the plan` |
| 6 | an `after` crew isn't `merged` or `dropped` (new) | `<slug> waits for <a, b> to merge` (in `after` order) | `waits for <a, b> to merge` |
| 7 | wave gate, now **within the crew's goal only** | `wave <n> isn't merged yet: <slugs>` for `run`; `wave <n> of goal <id> isn't merged yet: <slugs>` for an added goal | `waits for wave <n> to merge: <slugs>` |
| 8 | cap, **global across goals** (unchanged) | `<running> crews running, the cap is <cap>; start <slug> when one merges` | `waits for a free slot: <running> of <cap> running` |

A crew's goal is `goalOf(crew)`, exported from `intake.ts`: the crew's `goal` when it is a string, else `run`. Gate 7 filters `others` by `goalOf(c) === goalOf(target)` before today's lower-wave check. A non-array `after` is ignored, as other malformed fields are today. A non-string entry inside one counts as naming no crew (gate 5, printed with `planField`). The duplicate-slug and successor rules (`planCrewFor`, `:312-321`) don't change.

**How waves and `maxParallelCrews` interleave goals.** Each goal runs its own wave sequence, so a new goal's wave 0 can start while the run goal is mid-wave-2. `after` is the only coupling between goals. All goals share one `maxParallelCrews` from the plan, and the queue order is still the `crews` array. Added goals' crews sit at its end, so at equal readiness older goals' crews start first. The foreman's start rule (section 6 of run/SKILL.md) becomes: start the planned crews whose wait text is `ready to start` (section 5), in array order, at most `maxParallelCrews` minus the running ones. The amend can't change `maxParallelCrews`. The foreman edits it only on the owner's word, logged.

**Disjoint ownership across goals** stays a plan-time rule, as within a goal today (the hooks never compare `owns`). The architect enforces it in amend mode (section 2), and the foreman sends back an amendment that breaks it (section 4). The judge still checks each diff against its crew's `owns`. Two crews that touch one file are either in one goal's two waves or ordered by `after`.

### 4. Scope approval and the cynic for an added goal

run/SKILL.md gains `### Take a new goal mid-run`, in section 7 after "Run a mid-run design slice". It is a new subsection; sections 1-6 are only referenced, not rewritten. The foreman does this:

1. **What counts as a new goal.** An owner message asking for work that no crew in `plan.json` covers, sent after `approvedAt` is set. The owner's request is the owner's ruling on frozen scope, so no further scope question is asked. A change to an in-flight crew's work isn't a new goal; it takes the `PROPOSAL:` path. A lead or the foreman can't start a goal. The foreman's own idea goes to a cynic and then the owner, under "Build only approved scope" rule 2, and becomes a goal only on the owner's yes. Before `approvedAt` is set, the foreman folds the request into the plan with a fresh plan architect instead. The foreman never tells the owner to open another session.
2. **Acknowledge and log.** The foreman tells the owner in one line that it takes the request as goal `<id>` and that running crews continue. It logs `- HH:MM | [<id>] goal added: <goal on one line> | owner request mid-run | none | followed`. It picks `<id>` from the goal's words, in the crew-slug pattern, unique among goal ids, never `run`.
3. **Short altitude and depth pass** (sections 1-2), asking only what the goal leaves open.
4. **Amend architect.** It starts `architect-amend-<id>` (`model: "opus"`, `effort: "medium"`, foreground, first line `Mode: amend`) with a fresh `mktemp` marker, as in section 4. After the hand-back it runs `find "<foundry dir>/plan.json" "<foundry dir>/plan-<id>.md" -newer "<marker>"`, then `rm` the marker. Both files must be listed; the debug log line `foundry: plan-amend route ...` says why one is missing.
5. **Check the amendment** against section 4's send-back list, with `approval` checked against the goal's own wave 0. It also checks that no new crew's `owns` overlaps an unmerged crew of another goal unless `after` names it.
6. **Cynic.** A cynic reviews the new goal's verdicts and the cross-goal collisions, exactly as in "Have a cynic review the verdicts". On disagreement, one reconcile round runs under `architect-amend-<id>-2` with the same brief plus the findings. The route replaces the still-unapproved goal (section 2). The owner hears about a verdict only on the section-4 triggers.
7. **Approve and freeze the goal's scope** with section 5's rules applied to the goal. For an `auto` goal, the foreman sets `goals[i].approvedAt` to its log time and starts. For an `owner` goal, it shows the goal's crews in the section-5 table, waits for the owner, then sets `goals[i].approvedAt`. Merge mode and target are the run's and are never asked again. The top-level `approval` and `approvedAt` and the other goals' entries are never edited. "Build only approved scope" applies per goal, from that goal's `approvedAt`.
8. **Start** per section 3 above. Goal files and lead briefs are written as in section 6; a lead's brief also names its goal id.

Section 7's "Run a mid-run design slice" stays for a lead's design `PROPOSAL:` within one goal. A slice joins the proposing crew's goal (its `goal` field set to that id).

### 5. What the owner sees in `/foundry`

`planLines` (`:356-367`) changes in two ways.

**Wait suffix.** Every crew whose `status` is `planned` gets `, ` plus its wait text from `gateOf`, or `, ready to start` when no gate refuses it. Other statuses get no suffix. The old `, waits for the owner's approval` is now gate 4's wait text, so a pending crew's line reads as before.

**Goal grouping.** Only when `goals` is a non-empty array. The header becomes `Plan (<n> crews, <k> goals, approval <a><waiting>):`, with `k = 1 + goals.length` and `<a><waiting>` as today. Each goal then gets a line, and its crews follow it in today's order (wave, then array index). The `run` goal comes first, then `goals` in array order, then any unknown goal ids that crews name, in order of first appearance. A goal line is `Goal <id> (approval <a>[, waiting for the owner][, done]): <text>`. `<text>` is the goal with each whitespace run collapsed to one space, cut to its first 99 characters plus `…` when longer than 100. `waiting for the owner` shows when that goal's (for `run`, the top level's) `approval` is `owner` and `approvedAt` is null. `done` shows when every crew of the goal is `merged` or `dropped`. An unknown id's line is `Goal <id> (not in the plan):`. Without `goals`, there are no goal lines and the header is today's.

Example, this run as it would look after the three goals were added through amend mode:

```
Plan (9 crews, 2 goals, approval owner):
Goal run (approval owner): Make foundry prod-grade on quality and bloat, from the reviewed anti-bloat analysis: (1) hook clea…
- wave 0: eval-design, design, merged
- wave 1: hooks-cleanup, extend, merged
- wave 1: evals-build, change, running
- wave 2: prompt-rules, change, planned, waits for wave 1 to merge: evals-build
Goal intake (approval owner): Design mid-run intake: the foreman takes new goals during a run, starts crews for them, and shows…
- wave 0: intake-design, design, running
- wave 1: intake-gates, change, planned, waits for intake-design to merge
- wave 1: intake-retro, change, planned, waits for intake-design to merge
```

(The `intake-*` build crews wait on `intake-design` through the goal's wave gate, and on `prompt-rules` through `after`; the first gate that refuses is what shows.) The live-crew block below it (`statusText`, `:697-728`) doesn't change. The foreman answers a progress question from this view or from `plan.json`, one line per goal.

### 6. `decisions.md` and retro, per goal

- **No new heading.** An added goal shares its run's `## Run` heading, its plan, its judge window (`runStart` reads the top-level `approvedAt`, `:443-448`) and its event log, so retro's run split stays as it is.
- **Tag.** Every decision line about an added goal starts its decision field with `[<id>] `, for example `- HH:MM | [intake] intake-gates status running | ... | none | followed`. Lines about the run goal carry no tag. run/SKILL.md "Decisions and the decision log" says so in one sentence.
- **retro.py.** `new_run` gains an internal `"_goals": {}` (not printed, like `_dt`). In `read_decisions`, a line counted in `decisions.total` whose decision field (`fields[0].strip()`) matches `^\[([a-z0-9]+(?:-[a-z0-9]+)*)\] ` adds 1 to `_goals[<tag>]`. `retro()` adds a top-level key `goals` **only when** `plan.json` has a non-empty `goals` array, so every existing output, and the exact-key tests that pin it (`tests/test_contract_retro.py:58-61`, `tests/test_contract_leftovers.py:182`), stay as they are. `goals` is a list, `run` first and then the plan's goals in order. Each entry is `{ "id", "goal", "addedAt", "crews", "estAgents", "status", "decisions" }`. `goal` and `addedAt` come from the plan (`goal` is the top-level text for `run`; `addedAt` is `"not recorded"` for `run`). `crews`, `estAgents` and `status` are counted as `read_plan` does, over that goal's crews only, using `goalOf`'s rule. `decisions` counts, in the **last** run (the last heading, or the whole log when there is none), the tagged lines for that id. `run` gets the untagged lines plus lines tagged with an id the plan doesn't have.
- **retro/SKILL.md** section 2 gains one bullet: when `goals` is present, report one row per goal (crews, `estAgents`, status counts, decisions). A goal with crews but 0 decisions is reported as is; it is not an anomaly and gets no `CAUSE:` line.

### Diagrams

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

What the build adds around `plan.json`. Traces to `hooks/register.ts:873-905` (plan route and its chain), `:327-348` (gates), `:1261-1312` (status), `:1681-1694` and `:1759-1761` (architect detection and hand-back), and `skills/run/SKILL.md:104-139` (plan architect brief).

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

Taking a goal mid-run, end to end. Traces to `skills/run/SKILL.md:104-139` (marker and `find -newer`), `:150-162` (cynic review), `:172-204` (approval), `:206-264` (start and refusals), and `hooks/register.ts:1681-1694` and `:1759-1761`.

### Principles

- core 5: the seam is `plan.schema.json` v3 plus `amendPlan`'s signature.
- core 6: `amendPlan` validates the hand-back and writes nothing on failure.
- core 7: sending the same amend twice gives the same plan.
- core 8: every route outcome is a debug-log line.
- core 13: each build crew's done-check reruns its new test against `fa0fa9f`'s code and requires it to fail.
- ai 9: ordering, approval and the cap stay in hook code, not in the prompt. The prompt changes only say when to start the amend architect and how to read its result.

No principle is added or broken.

## Owner decisions

- When a goal you add mid-run has a design (wave-0) crew, should it wait for you to approve its plan before it starts, the same rule as at run start? Recommended: yes. A goal with no design crew starts at once and shows up in the end-of-run report, as an extend-only run does today. "No" would let added designs start without your review, which is faster but skips the one look you get today.

## Files touched

- plugins/foundry/hooks/intake.ts (new: `goalOf`, `RUN_GOAL`, `amendPlan`, the goal-text cut used by `planLines`)
- plugins/foundry/hooks/register.ts (`Plan` and `parsePlan` at :282-305; `planVerdict` at :327-348 rebuilt on a new `gateOf`; `planLines` at :356-367; `State.planArchitects` and `pendingPlanCalls` at :794-796, :1530, :1556-1557, :1581; architect detection at :1681-1694; hand-back routing at :1759-1761; new `writeAmendFiles` and `routeAmendFiles` beside `routePlanFiles` at :873-905)
- plugins/foundry/tests/intake-gates.test.ts (new)
- plugins/foundry/tests/v03.test.ts (the four plan-line expectations at :358, :360, :376, :464 gain wait suffixes)
- plugins/foundry/docs/plan.schema.json (version 3, `goals`, crew `goal` and `after`, their conditionals)
- plugins/foundry/agents/architect.md (new `## amend mode` section and its report block)
- plugins/foundry/skills/run/SKILL.md (new `### Take a new goal mid-run` in section 7; section 6's start rule and the refusal list name the new gates; one sentence on the `[<id>]` tag under "Decisions and the decision log")
- plugins/foundry/docs/architecture.md (`### plan.json` at :282, `### Plan gates (0.3.0)` at :415, `### /foundry` at :641, `### decisions.md grammar` at :270, and the two diagrams above)
- plugins/foundry/README.md (one paragraph on adding goals mid-run)
- plugins/foundry/scripts/retro.py (`new_run`, `read_decisions`, a per-goal reader beside `read_plan`, the conditional `goals` key in `retro()`)
- plugins/foundry/tests/test_contract_retro_intake.py (new)
- plugins/foundry/skills/retro/SKILL.md (one bullet in section 2)

## Build crews

- intake-gates | owns: plugins/foundry/hooks/intake.ts, plugins/foundry/hooks/register.ts, plugins/foundry/tests/intake-gates.test.ts, plugins/foundry/tests/v03.test.ts, plugins/foundry/docs/plan.schema.json, plugins/foundry/agents/architect.md, plugins/foundry/skills/run/SKILL.md, plugins/foundry/docs/architecture.md, plugins/foundry/README.md | doneCheck: git ls-files --error-unmatch plugins/foundry/hooks/intake.ts plugins/foundry/tests/intake-gates.test.ts && claude plugin test plugins/foundry && T=$(mktemp -d) && git archive -o "$T/a.tar" fa0fa9f plugins/foundry/hooks plugins/foundry/tests/harness.ts plugins/foundry/.claude-plugin && tar -x -f "$T/a.tar" -C "$T" && cp plugins/foundry/tests/intake-gates.test.ts "$T/plugins/foundry/tests/" && ! claude plugin test "$T/plugins/foundry" | after: prompt-rules
- intake-retro | owns: plugins/foundry/scripts/retro.py, plugins/foundry/tests/test_contract_retro_intake.py, plugins/foundry/skills/retro/SKILL.md | doneCheck: git ls-files --error-unmatch plugins/foundry/tests/test_contract_retro_intake.py && python -m unittest discover -s plugins/foundry/tests -p "test_*.py" && T=$(mktemp -d) && git archive -o "$T/a.tar" fa0fa9f plugins/foundry/scripts && tar -x -f "$T/a.tar" -C "$T" && mkdir -p "$T/plugins/foundry/tests" && cp plugins/foundry/tests/test_contract_retro_intake.py "$T/plugins/foundry/tests/" && ! python -m unittest discover -s "$T/plugins/foundry/tests" -p test_contract_retro_intake.py | after: prompt-rules

**Why two crews, and why the prompt edits ride with the hooks.** The two crews share no file. The prompt and doc edits (`architect.md`, `run/SKILL.md`, the architecture doc, the README) have no check that could fail for them alone, so by the floor rule they ride with the crew whose behaviour they describe. The judge checks them against this ADR. Each crew: `kit:test-writer` (sonnet, medium) writes the new test first, and the builder may not edit it; `kit:builder` (sonnet, medium); for `intake-gates` also a writer (sonnet, medium) for the prompt and doc edits; `foundry:judge` (opus, medium). Neither suite calls a model.

**`after`.** Both crews wait for `prompt-rules`, which owns `skills/run/SKILL.md` and `skills/retro/SKILL.md` and edits the `tests/*.check.ts` wording checks. ADR-0008 (interview) and ADR-0009 (speed) build crews will also want `register.ts`, `run/SKILL.md`, `architect.md` or `plan.schema.json`. Their slugs don't exist yet, so the foreman adds whichever of them shares a file with `intake-gates` to its `after` (or the reverse) when it turns the three ADRs into crews. `intake-retro` shares no file with them as far as this ADR can see.

**What the contract tests pin.** `tests/intake-gates.test.ts` imports only from `claude-code/testing`, `./harness` and names `../hooks/register` exports at `fa0fa9f` (such as `LEAD_TYPE`). It never imports `../hooks/intake`, so its run against `fa0fa9f`'s code fails on assertions, not on a missing module. Every Agent call in it sets `model` and `effort` (a v2+ plan refuses a main-session `foundry:*` call without `effort`, `mainCallVerdict` `:567-571`). It pins, through the Agent `tool.call` entry, the architect hand-back and `command.run` `foundry`:
1. an added goal's wave-1 crew isn't held by the run goal's unmerged wave 0, and the run goal's own wave gate is unchanged;
2. the `wave <n> of goal <id> isn't merged yet` text;
3. gates 2, 3, 5 and 6, each refusal text exact;
4. the cap counts running crews of every goal;
5. a `Mode: amend` hand-back on an approved plan appends the goal (`approvedAt: null`, `addedAt` from the harness clock) and its crews (`status: "planned"`, `goal` set); every pre-existing crew and top-level field deep-equals its value before; `plan-<id>.md` is written and `plan.md` is not;
6. each refusal in section 2 leaves `plan.json` byte-identical and logs `plan-amend route wrote nothing: `;
7. an amend for an existing unapproved, unstarted goal replaces it, and one for an approved goal is refused;
8. a `Mode: plan` hand-back over an approved plan is still kept;
9. `/foundry`'s wait suffixes, `ready to start`, the goal lines with the 100-character cut, `done` and `not in the plan`, and no goal lines without `goals`.

`tests/test_contract_retro_intake.py` (Python, like the other retro contract tests, such as `tests/test_contract_retro_080.py`; `retro.py` is Python and those tests run with `python -m unittest`) builds its fixtures in a tempdir and runs `retro.py` by subprocess. It pins the `goals` entries (`run` first, then counts per goal, `"not recorded"` `addedAt` for `run`), tagged-decision counting over the last run only, unknown tags counting to `run`, and the key's absence without `goals`.

**Existing tests that pin behaviour this design removes.** Only the planned-crew lines without a suffix are removed: `tests/v03.test.ts:358`, `:360`, `:376` and `:464`. They go to `intake-gates`. No other `*.test.ts` checks `/foundry` output for a planned crew. A file-by-file grep for files holding both `planned` and a status call found only `tests/v03.test.ts`. Line `:347` keeps passing, because gate 4's wait text is the old suffix. No retro test changes, because the `goals` key is absent without plan goals.

**How the done-checks were proved** (outputs in the crew's report):

- **Red at `fa0fa9f`.** Run from this worktree at HEAD `fa0fa9f`, both checks fail at their first step: `git ls-files --error-unmatch` exits 1 with `error: pathspec 'plugins/foundry/hooks/intake.ts' did not match any file(s) known to git`, and the same for `tests/test_contract_retro_intake.py`. At that HEAD `claude plugin test plugins/foundry` gives 435 pass, 0 fail, and `python -m unittest discover -s plugins/foundry/tests -p "test_*.py"` gives 147 tests OK, so the full-suite steps aren't red for an unrelated reason.
- **Green on a hand-made sample.** A throwaway clone in the scratchpad (`intake-sample/repo`), never pushed, had three sample changes. The first was a 5-line `hooks/intake.ts` (`goalOf`), a one-line goal filter in `planVerdict`'s wave gate, and a two-test `intake-gates.test.ts`. The second was a sample `read_goals` in `retro.py` and a two-test `test_contract_retro_intake.py`. Each was committed in the clone. In the clone, `git ls-files --error-unmatch` exited 0 for both checks, `claude plugin test plugins/foundry` gave 437 pass, 0 fail, and the Python suite ran 149 tests, OK. **The revert step:** the `fa0fa9f` hooks, harness and plugin.json, or `scripts/`, with the sample test added, failed as required. `claude plugin test` gave 1 pass, 1 fail (`Expected: undefined`, `Received: "[foundry] Refused: wave 0 isn't merged yet: a"`); unittest gave `FAILED (errors=1)` on `KeyError: 'goals'`. So `!` turns both green.
- **What differs from the literal command.** The worktree-isolation guard refused git commands it couldn't verify, including running a check script inside the clone and `git archive -o` to a path outside the worktree. So the steps ran one by one, and the `fa0fa9f` tree came from `cp` out of this clean worktree at `fa0fa9f` instead of `git archive`. The archive-into-`mktemp -d`-then-`claude plugin test "$T/plugins/foundry"` mechanism was itself run once from this worktree (with `git archive ... | tar -x`), on `status-judge.test.ts`: 5 pass, exit 0. The build crew's lead runs each literal command once before members start.

## Consequences

- An owner can add a goal at any point after approval. The factory says it has taken the goal, keeps running crews going, and shows every goal and every crew's blocker in one `/foundry` view.
- A v2 plan behaves as today, apart from the new `/foundry` suffixes. A plan becomes v3 the first time a goal is appended, and its existing crews belong to `run`.
- Goals no longer block each other through waves, so the cap and `after` do the throttling. A forgotten `after` between goals that touch one file is caught only by the architect, the foreman's check and the judge, as within a goal today. The hooks still don't compare `owns`.
- `plan.md` stays the first goal's plan, and each added goal has `plan-<id>.md`.
- Retro attributes crews and decisions per goal only when the plan has goals and the foreman tags its lines. Untagged lines count to `run`, so a forgotten tag under-counts an added goal and never miscounts a run.
