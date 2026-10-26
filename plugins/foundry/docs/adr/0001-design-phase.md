# ADR-0001: a design phase, principle packs and planned work breakdown

Status: accepted (wave 0 of foundry 0.3.0). Date: 2026-10-26. Decided by: Ram (owner), with the foreman.

## Context

The intel run on 2026-10-26 took about six hours for three crews. Two of them merged with 10 and 12 agent reports. The third, gateway, needed 32: 8 builders, 9 testers, 7 writers, 4 judges and 4 red teams. Its decision log shows the cause. There was no gateway design, so the design happened inside the build:

- its file ownership was widened mid-run, and drift was accepted after the fact (schema, config key, two engines, a registry);
- done-checks couldn't be run with the crew's own access;
- a design question (the model byline) surfaced after building started and caused another build-and-judge cycle.

Foundry 0.2.1 splits work at two fixed levels: the foreman splits into crews by file ownership, and leads split into member tasks of "one sitting". Neither level has a rule for when a piece is small enough or too small. No artifact holds the design, so each brief carries its own paraphrase of it.

## Decision

### 1. The architecture lives in the project repo

Each project has one architecture doc. Foundry's `init` writes it when it's missing (step 0). It holds:

- **Principles:** the rules every change follows, chosen from foundry's principle packs and adapted to this repo, with a reason wherever a pack rule is dropped.
- **Module map:** each module, the paths it owns, what it's responsible for, and its seams (the interfaces other modules use).
- **Decisions:** ADRs for the decisions already visible in the code, then one per design change.

Where the doc goes: the repo's existing architecture doc, if it has one, which `init` extends rather than replaces. Otherwise `docs/architecture.md`, with ADRs in `docs/adr/`. The doc's path is recorded in `<repo>/.claude/foundry.json`. `init` writes only `architecture` and `adr`. The owner can add the optional keys by hand; each has a default:

```json
{
  "architecture": "docs/architecture.md",
  "adr": "docs/adr",
  "agentCap": 40,
  "maxParallelCrews": 4,
  "merge": "sequential",
  "target": "<current branch>"
}
```

`merge` and `target` apply to auto-started runs (section 6).

### 2. Principle packs ship with foundry, as a skill

`skills/principles/` holds one file per domain. Each pack is a list of rules that can be checked against a diff, each with a one-line test ("a module imports another only through its index").

- `core`, applied to every project: high cohesion and loose coupling; depend on interfaces at module edges; SOLID where there are objects; explicit contracts at seams; fail fast; idempotent operations; observability; secure defaults; YAGNI.
- `service`: 12-factor (config in the environment, stateless processes, disposability, dev/prod parity, logs as streams), backing services as attached resources, health endpoints.
- `frontend`: component composition, one-way data flow, state kept next to its use, the design-system / app boundary, an accessibility baseline, performance budgets.
- `data`: idempotent re-runnable pipelines, schema contracts between stages, raw data never changed, lineage, backfills, data-quality checks as gates.
- `ai`: evals before changes, versioned prompts and models, deterministic seams around model calls, cost and latency budgets.
- `infra`: infrastructure as code, immutable deploys, least privilege, a rollback path.
- `library`: a stable public API, semver, no side effects on import.

`SKILL.md` indexes the packs and says how to pick them. A pack is loaded with the Skill tool and read from its base directory, so no agent needs the plugin's install path.

### 3. The architect

`agents/architect.md`: Opus, effort high. It loads the packs the work touches, and that's what makes it a frontend, data or backend architect. Tools: Read, Grep, Glob, Bash (read-only git, plus the done-check commands it proves and an already-installed schema validator, both in plan mode), Skill, Write and Edit. Write and Edit are limited to these files:
- the architecture doc;
- the ADR directory;
- `.claude/foundry.json`, in init mode;
- `<foundry dir>/plan.json` and `plan.md`, in plan mode.

It never edits source or tests. It runs in three modes.

- **init:**
  - Started by the `foundry:init` skill. That's the owner running `/foundry:init`, or the foreman when a run finds no architecture doc.
  - It writes the architecture doc, the module map, the ADRs for decisions already in the code, and `.claude/foundry.json`.
- **plan:**
  - Started by the foreman at the start of every run, outside every crew, like the cynic.
  - For a goal, it writes the verdicts and the work breakdown (sections 4 and 5) as a draft `plan.json` plus a readable `plan.md`.
  - The draft sets `approval`: `owner` when the plan has a wave-0 crew, `auto` otherwise.
  - The foreman owns both files after that: it checks `approval`, sets `approvedAt`, and updates `status`.
- **design:**
  - A member of a wave-0 design crew, started by that crew's lead.
  - It writes the ADR and the architecture-doc change for each `change` verdict, and names the seams the crew's test-writer must pin with contract tests.

### 4. Extend or change, decided by Opus

For each module the goal touches, the architect gives one verdict.

- **extend:** new instances of existing patterns, inside existing modules, behind existing interfaces. Examples: a new route, stage, provider, component or command. This is the default.
- **change:** any of these:
  - a new module or seam;
  - a changed interface or stored data shape;
  - a new external service or dependency;
  - a principle added or broken.

  A `change` verdict must name the existing interface that can't take the work, and why.

The cynic reviews the verdicts on its own. If the two disagree, the architect gets one round to reconcile. The owner is asked only when:

- they still disagree after that round;
- a change breaks a declared principle;
- it adds an external service or recurring cost;
- it changes a stored data shape in a way that's hard to undo.

### 5. Work breakdown on paper, by the leaf test

The architect splits the goal once, on paper, along the module map. Agents never start sub-leads to split further.

1. **Items.** Each item lives in one module, or in one seam the contract tests pin.
2. **Leaf test.** An item stops splitting when all four hold:
   - it owns files no sibling item touches;
   - it has a done-check it can run with its own access, and the architect runs that command once while planning to prove it;
   - every design decision it needs is in the architecture doc or a wave-0 ADR;
   - it fits one agent's context.

   Split only along the condition that fails.
3. **Floor.** An item with no check that could fail for it alone is too small. It merges into a sibling in the same module.
4. **Crews.** Items group into crews, by module to start with. No two crews may edit the same file.
5. **Waves.**
   - Wave 0 holds the `change` work: ADRs, the architecture-doc change and the contract tests. It merges before any other wave starts.
   - A crew that needs another crew's new interface goes in a later wave, unless a wave-0 contract test pins that interface.
   - Each wave merges before the next starts.
6. **Parallelism.**
   - Every module the goal touches gets its own crew, so they all run in parallel within a wave.
   - Two modules share a crew only when one of them has too little work to clear the floor.
   - The hard rule is files, not modules: no two crews edit the same file. A large module can be split across crews when its parts own disjoint files. That's the architect's call, made when one crew couldn't hold the whole module's work.
   - A shared file inside a module (an index, registry or route table) goes to exactly one crew. Alternatively, wave 0 adds an extension point so each crew adds its own file instead.
   - When the parts are small enough for one lead to coordinate, keep one crew and run its members in parallel instead. A second crew adds a lead, a judge and a rebase-and-re-judge at merge.
   - When a wave has more crews ready to run than `maxParallelCrews` allows (default 4, set in `.claude/foundry.json`), the extra crews queue within the wave and start as running ones merge.
   - The plan shows the queue order.
7. **Budget.** The plan gives an estimated agent count per crew and a total. A plan over the cap (default 40 agents, set in `.claude/foundry.json` as `agentCap`) is re-planned with fewer, larger crews or more waves before anyone sees it.
8. **Leads split members by the same leaf test** and never re-split the design. Work that doesn't fit goes to the foreman as `PROPOSAL:`.

### 6. Approval only when the design changes

- **Extend-only run, no wave 0:**
  - The architect's draft has `approval: "auto"`. The foreman logs the plan, overwrites `approvedAt` with its own log time, and starts the crews without asking.
  - Merge mode and target come from `.claude/foundry.json`. Without them, the merge mode is `sequential` and the target is the current branch. The foreman logs which it used.
  - The owner sees the plan in the end-of-run report.
- **Run with a wave 0:**
  - The architect's draft has `approval: "owner"` and `approvedAt` null. The foreman shows the plan table with the ADRs and asks for the merge mode and target as in 0.2.1.
  - It sets `approvedAt` when the owner approves.
  - Later waves start as earlier ones merge, with no further pause.
  - `approvedAt` is null only while a run waits for the owner.
- **Questions still reach the owner** through the cynic's escalation rules in either case: a wave doesn't make the run silent.

### 7. Conformance

- The judge adds one rubric question: does the diff conform to the architecture doc's principles and module map, and to this run's ADRs? A violation that doesn't affect the done-check is a QUESTION. One that breaks a declared principle is a FAIL.
- Crews never edit the architecture doc or ADRs. A needed design change goes to the foreman as `PROPOSAL:`.
- **Mid-run design slice:** when the foreman takes up a design proposal, it handles it like this.
  - It adds a design crew (`verdict: "design"`) to the earliest wave that hasn't started yet.
  - It moves only the crews that depend on the slice, and haven't started, one wave later. Running crews and crews that don't depend on it keep their wave.
  - The run-level `approval` and `approvedAt` don't change.
  - The slice waits for the owner only when one of section 4's triggers applies. Then the foreman sets the crew's `ownerApproval` to `"pending"`, and to `"approved"` when the owner answers.
  - Otherwise the slice starts like any crew.

### 8. The plan file contract

`plan.json` is the seam between the architect, the foreman and the hooks:

```json
{
  "version": 1,
  "goal": "…",
  "architecture": "docs/architecture.md",
  "approval": "auto | owner",
  "approvedAt": "ISO time or null",
  "agentCap": 40,
  "maxParallelCrews": 4,
  "crews": [
    {
      "slug": "auth",
      "wave": 0,
      "verdict": "extend | change | design",
      "modules": ["auth"],
      "owns": ["src/auth/**"],
      "doneCheck": "pnpm test -- auth",
      "doneCheckProved": true,
      "estAgents": 6,
      "ownerApproval": "pending | approved (optional; mid-run design slices only)",
      "status": "planned | running | merged | dropped"
    }
  ]
}
```

- `verdict` describes a crew:
  - `design` is a crew that writes ADRs and contract tests;
  - `change` is a build crew whose module's design changed, so it runs after the design crew;
  - `extend` is a build crew working inside the existing design.
- `approval` is set once, at plan time. It's `owner` exactly when the plan has a wave-0 crew; mid-run slices never change it.
- Within a wave, the order of the `crews` array is the queue order.
- The agent total is the sum of `estAgents`, so it isn't stored.
- `version` goes up whenever a field is added; the schema allows no other properties.
- The foreman updates `status` as crews start and merge.
- The hooks treat the file as read-only.

### 9. Hooks

- **Wave gate:** an Agent call starting a `foundry:lead` whose slug is in `plan.json` is refused while any crew in an earlier wave isn't `merged` or `dropped`. Reason: `wave <n> isn't merged yet: <slugs>`.
- **Parallel cap:** starting a lead is also refused while `maxParallelCrews` crews are already `running`. Reason: `<running> crews running, the cap is <cap>; start <slug> when one merges`.
- **Approval gate, run level:** when `approval` is `owner` and `approvedAt` is null, starting any lead in the plan is refused. Reason: `this run changes the design; get the owner's approval first`.
- **Approval gate, crew level:** a crew whose `ownerApproval` is `pending` is refused on its own. Reason: `<slug> waits for the owner's approval`.
- **No plan file, or a slug not in it:** no gate. 0.2.1 runs keep working.
- **`/foundry`** shows each crew's wave, verdict and status from `plan.json`, then the 0.2.1 member lines.
- **Failure:** the hooks fail open, like every other foundry hook.

## Consequences

- Design changes become visible and rare: the default is extend, and a change costs a wave and, sometimes, the owner's attention.
- Extend-only runs need no human input before the end-of-run report.
- Planning costs one architect pass, plus a cynic review per run. That's cheaper than one gateway-style rework loop.
- `init` is now the first part of the old run 2. The kit-manifest extension work (role mapping, port slices, deploy target, prompt overrides) and `foundry retro` stay in run 2.
- Risk: the architect over-calls `change`. Mitigation: the default and the rule that a change must name the interface that can't take the work. `retro` will measure it later.
- Risk: the hooks trust the foreman's `status` field. A foreman that marks a crew merged too early defeats the wave gate. The gate guards against forgetting, not against lying. The judge-gated merge is still the real control.
