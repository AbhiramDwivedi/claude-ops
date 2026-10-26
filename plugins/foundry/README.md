# foundry

Runs a large goal as several crews of agents working in parallel. The main session is the foreman: it plans the run, decides for it, and is the only one that talks to you. Each crew has a lead that delegates to member agents in its own worktree, and a judge that checks the crew's work against proof. A crew's branch merges into your target branch only after its judge says `VERDICT: PASS`.

Since 0.3.0 an architect agent plans each run against your project's architecture doc. It decides, module by module, whether the goal fits the existing design or changes it, splits the work into crews and waves, and writes the plan to `plan.json`. A run that only extends the design starts without asking you; a run that changes it waits for your approval.

[docs/architecture.md](docs/architecture.md) covers the internals: who talks to whom, the files on disk, each hook, and how a run recovers from failures. [ADR-0001](docs/adr/0001-design-phase.md) records the 0.3.0 design phase and why it exists.

## Roles

| Role | Who | What it does |
| --- | --- | --- |
| Owner | You | Picks the goal's altitude. Approves a plan that changes the design, with its merge mode and target branch. Rules on changes to frozen scope, on production deploys, and on every push or PR. |
| Foreman | The main session, after `/foundry:run` | Has the architect draft the plan, decides on it as product owner, and logs every decision. Starts the leads, answers them, and merges what the crews deliver. Never does a crew's work or the design. |
| Architect | `foundry:architect`, Opus, effort `high` | Loads the principle packs the work touches. Edits only the architecture doc, the ADRs, `.claude/foundry.json` (in `init` mode) and `plan.json` and `plan.md` (in `plan` mode); never source or tests. In `init` mode it writes the architecture doc. In `plan` mode, outside every crew, it drafts the run's verdicts and work breakdown. In `design` mode, as a member of a design crew, it writes the ADR and the doc change for each `change` verdict and names the seams to pin with contract tests. |
| Cynic | `foundry:cynic`, Opus, effort `high`, outside every crew | Read-only. Reviews each of the architect's verdicts on its own. For each question, proposal or blocker bound for you, recommends `answer`, `defer` or `pass`. Before the merge, checks the crews for drift from the plan and for overlap. It recommends; the foreman decides. |
| Lead | `foundry:lead`, Opus, one per crew | Splits the crew's goal into member tasks, delegates them, merges the members' branches into the crew branch, runs the checks and reports. |
| Members | Your project's agents, plugin agents, or `general-purpose` | Do the building. Each starts with an explicit model and effort and a name that starts with its crew's. |
| Judge | `foundry:judge`, Opus | Never the builder. Checks the proof in the crew's reports, answers a five-question rubric, and reports `VERDICT: PASS` or `VERDICT: FAIL`. Runs one effort level above the strongest builder it judges, from `high` to `xhigh`. In red-team mode it tries to break the crew's work instead. |
| Writer | `foundry:writer`, Opus | A member for the prose a crew ships. Loads the best writing skill the session has (`technical-writer` when it's installed) and writes only what the code or a command it ran shows. |
| DevOps | `foundry:devops`, Sonnet | A member that validates a deploy with proof: rollout status, health endpoint, smoke tests, logs. May deploy a preview or staging build. Never deploys to production or changes it. |

foundry works with or without agents of your own. When the project defines none that fit, members run as `general-purpose` with a prompt the lead writes, which says what the job is rather than who the agent is. The [kit](../kit) plugin's `builder`, `test-writer`, `reviewer` and `scout` make good members, and the [worktrees](../worktrees) plugin starts each worktree from your current commit instead of `origin/HEAD`.

The principle packs ship as the `foundry:principles` skill, one pack per domain: `core` (applied to every project), `service`, `frontend`, `data`, `ai`, `infra` and `library`. Each rule can be checked against a diff and comes with a one-line test, such as "a module imports another only through its index". The architect picks the packs and adapts them into the architecture doc's principles, giving a reason for each rule it drops.

## Set up the architecture doc

Run `/foundry:init` once per project. A run does it for you when the doc is missing.

1. It reads `.claude/foundry.json` at the repo root. If the `architecture` key names a file that exists, it tells you where the doc is and stops.
2. Otherwise it starts the architect in `init` mode. The architect writes the doc's principles, its module map (each module, the paths it owns, what it does and its seams) and an ADR for each decision already visible in the code. It extends an architecture doc the repo already has; with none, the doc goes to `docs/architecture.md` and the ADRs to `docs/adr/`. It writes `.claude/foundry.json` with the `architecture` and `adr` keys only.
3. It shows you what the architect wrote and stops. It doesn't commit. Commit the files before a run: crews work in worktrees, which see only committed files.

You can add the other keys to `.claude/foundry.json` by hand:

| Key | Default | What it sets |
| --- | --- | --- |
| `architecture` | `docs/architecture.md` | Path of the architecture doc. |
| `adr` | `docs/adr` | Directory of the ADRs. |
| `agentCap` | `40` | The most agents a plan may estimate in total. |
| `maxParallelCrews` | `4` | The most crews running at once within a wave. |
| `merge` | `sequential` | Merge mode for an auto-started run. |
| `target` | the current branch | Target branch for an auto-started run. |

## How a run goes

`/foundry:run` loads the foreman's protocol. The foreman:

0. checks for the architecture doc. When it's missing, the foreman runs the `foundry:init` skill, then asks whether to go on. It reads `.claude/foundry.json`, and asks you to commit the doc, its ADRs or that file if they have uncommitted changes;
1. asks you once whether the goal is the end or one step toward a bigger outcome, and describes the bigger version. You pick one;
2. runs a short depth pass: what a top practitioner would do that wasn't asked for, what the rawest material is, which tools that practitioner would use, and what besides a model verifies the result. The answers go into the architect's brief;
3. lists the agent types the session can start (your project's `.claude/agents/*.md`, yours in `~/.claude/agents/`, plugin agents) and the project's skills;
4. starts the architect in `plan` mode. The architect gives each module the goal touches one verdict. `extend`, the default, means new instances of existing patterns behind existing interfaces, such as a new route, provider or command. `change` means a new module or seam, a changed interface or stored data shape, a new external service or dependency, or a principle added or broken; it must name the existing interface that can't take the work, and why. The architect then splits the work along the module map into crews and waves, runs each crew's done-check once to prove it, estimates agents per crew, and writes a draft `plan.json` with a readable `plan.md`. The foreman sends the draft back if two crews own one file, a done-check can be gamed or wasn't proved, or the estimate is over `agentCap`;
5. has a cynic review each verdict on its own. If they disagree, the architect gets one round to reconcile. You are asked only when they still disagree, a change breaks a declared principle, adds an external service or a recurring cost, or changes a stored data shape in a way that's hard to undo;
6. gets the plan approved. In an extend-only run (no wave 0) the foreman sets `approval: "auto"`, takes the merge mode and target from `.claude/foundry.json` (else `sequential` and the current branch), logs them and starts without asking; you see the plan in the end-of-run report. A run with a wave 0 has `approval: "owner"`: the foreman shows you the plan table with the ADRs and asks for the merge mode and target branch, as in 0.2.1. Either way it shows each crew's estimated agents against `agentCap` and the queue order. Scope grows here, once, and freezes when `approvedAt` is set;
7. writes a goal file for each crew and starts the leads wave by wave, in the background, each in its own worktree. Wave 0 holds the `change` work (ADRs, the architecture-doc change, the contract tests) and merges before any other wave starts. Within a wave the crews start in plan order, up to `maxParallelCrews` at once; the rest queue and start as running crews merge. The next wave starts, without a pause, once every crew in the earlier waves is `merged` or `dropped`;
8. handles the leads' messages, each tagged `QUESTION:`, `BLOCKED:` or `PROPOSAL:`. It decides what it can and logs it. Anything bound for you goes through a cynic first, and a `PROPOSAL:` defaults to no because the scope is frozen;
9. merges each crew once its highest-numbered judge file says `VERDICT: PASS` for the crew branch's head commit, sets the crew's `status` to `merged` in `plan.json`, and starts the next queued crew or wave;
10. reports to you, and asks before every push and every PR.

`plan.json` is the contract between the architect, the foreman and the hooks. The architect drafts it; after that the foreman owns it and sets `approvedAt` and each crew's `status` (`planned`, `running`, `merged` or `dropped`). Each crew's `verdict` is `design` (writes ADRs and contract tests), `change` (builds in a module whose design changed, after the design crew) or `extend` (builds inside the existing design). [docs/plan.schema.json](docs/plan.schema.json) is its schema.

A design change can also come up mid-run, as a lead's `PROPOSAL:`. When the foreman takes one up, it adds a design crew to the earliest wave that hasn't started and moves one wave later only the unstarted crews that depend on it. The run's approval doesn't change. The slice waits for you only when one of the triggers in step 5 applies; the foreman then sets the crew's `ownerApproval` to `pending`, and to `approved` when you answer.

The foreman follows the cynic's recommendation by default. To overrule it, the foreman logs a one-line reason, and every overrule appears in the end-of-run report. The foreman clears a `BLOCKED:` itself when it can inside frozen scope, for example from the plan, the decision log or something it knows: a missing input, a collision with another crew. Every other `BLOCKED:` reaches you, and none is ever deferred. A production promotion, a change to frozen scope, and every push or PR reach you whatever the cynic recommends, unless the project grants the foreman merge ownership for pushes and PRs.

## Inside a crew

A lead first proves it can run its crew's checks in its own worktree. If it can't, it sends `BLOCKED:` before splitting any work. It then runs its own, fuller depth pass and turns the answers into member tasks. Anything that would add scope goes to the foreman as a `PROPOSAL:`.

The lead splits its crew's goal by the leaf test the architect used for crews. A task stops splitting when it owns files no sibling task touches, has a done-check its member can run with its own access, needs no design decision outside the architecture doc and the wave-0 ADRs, and fits one agent's context. A task with no check that could fail for it alone is too small and merges into a sibling. The lead never re-splits the design and never starts a sub-lead. Crews never edit the architecture doc or the ADRs: work that doesn't fit, and any design decision the doc doesn't hold, go to the foreman as a `PROPOSAL:`. The exception is a design crew, whose lead starts the architect in `design` mode and then a test-writer to pin the seams it names.

Every member report carries proof: a command and its output, before-and-after numbers, or a walk through the real flow. These don't count as proof: tests the builder wrote after building, "I verified it" with no output, a typecheck alone, a mocked end-to-end test, and output from another commit. Builders may not edit the done-check tests. Every commit carries a `Foundry-Crew: <slug>` trailer and a `Foundry-Role: <role>` trailer (`test-writer`, `builder`, `writer`, `devops`, `redteam`, `architect`). The judge uses the role to check that no `builder` commit touched the done-check tests; one that did fails the crew. A file changed outside the crew's ownership goes to the foreman as a `QUESTION:` (extend the ownership, or revert), not a FAIL by itself.

After the last merge and a green run of the checks, the lead starts a fresh judge. The judge's fifth rubric question asks whether the diff conforms to the architecture doc's principles and module map and to the run's ADRs. A departure that doesn't affect the done-check is a `QUESTION:` for the foreman; one that breaks a declared principle is a FAIL. A project with no architecture doc doesn't fail on it. For a crew with high-impact paths, the plan can add a red team first: `foundry:judge` in red-team mode, which works in its own worktree, checks out the crew head SHA there itself, and proves each break with a command and its output. A reproduced break is fixed, and a fresh red team runs before the judge does.

When two fix attempts at one level end with the same check failing, the lead climbs the escalation ladder: Sonnet, then Opus at effort `medium`, `high`, `xhigh`. Each step is a fresh agent, never a resume, and its first deliverable is a root-cause analysis with evidence. If `xhigh` fails twice, the lead sends `BLOCKED:`.

The lead's final report has fixed sections: Summary, Branch, Changes, Proof, Checks run, Open questions. A report that starts with `CHECKPOINT:` means the lead stopped with work left, and the foreman starts a successor lead, `<slug>-2`, from it.

## Merge modes

| Mode | What happens | Use it when |
| --- | --- | --- |
| `sequential` | Crews land on the target one at a time. The foreman asks each lead in turn to rebase its branch onto the target, resolve the conflicts and run the checks. If the rebase moved the head, a fresh judge rules on it. On a PASS for that head, the foreman fast-forwards the target to it. | You want one reviewable merge per crew. |
| `single` | One integrator agent (Opus, in a worktree) merges every crew branch into one integration branch, `foundry-<short goal>`, resolves the conflicts and runs the checks. An integration judge rules on the result. You get one PR. | Each merge to the target triggers something expensive, such as a deploy. |

Conflicts are always resolved by an agent, never in the main thread. With more than one wave, `single` mode integrates wave by wave: each wave's crews merge into the integration branch and pass an integration judge before the next wave's leads start from that branch.

## The end-of-run report

Before anything leaves the machine, the foreman reports each crew's summary and what merged where, the checks and every judge's verdict, the decisions it made and every cynic overrule with its reason, and the items deferred to the end. It lists the high-impact files that changed and asks you to read those, and only those.

## What the hooks do

A crew is a `foundry:lead` started by the main thread, plus every agent below it, however deep. An agent goes by the name it was spawned with, else its id, and the crew by its lead's. Agents outside every crew are left alone, which includes the cynic, the integrator and the integration judge.

- **Reports are saved.** When a crew agent stops, its last message is written to `<git common dir>/foundry/<session id>/reports/<crew>/<agent name>.md`. A report sent through the hand-back tool is saved instead. Outside git the folder is `~/.claude/foundry/<session id>/`. The git common dir is the main checkout's `.git`, so every worktree writes to the same place. Hand-backs from nested agents have been lost on some machines; the lead and the foreman read the file when one doesn't arrive. Each Agent call that starts a lead or a crew member gets a `[foundry]` note naming the path, and the main session gets a `[foundry] dir: <path>` note at session start. A lead's interim stop (members still at work, or a tagged message to `main` unanswered) is saved as `<agent name>.interim.md` and leaves the report, the crew's status and its idle clock alone. A stop the gate sends back is saved nowhere.
- **Empty hand-backs are refused.** A crew agent's hand-back under 40 characters, or one that is only `placeholder`, `todo` or `tbd`, is refused with a reason asking for the real report. One that starts `QUESTION:`, `BLOCKED:`, `PROPOSAL:` or `CHECKPOINT:` may be short, but not empty after its tag.
- **Crew messages follow the chain.** A member's `SendMessage` may go to its own lead and the other members of its crew. A lead's may go to `main`, its own members and the other leads. Anything else from inside a crew is refused, with a reason telling a member to go through its lead and a lead to message the other crew's lead. So is an address no agent of the session has had, and a name two live agents in different crews share.
- **Lead-to-lead messages are logged** to `<foundry folder>/messages.jsonl` as `{ ts, from, to, summary }`. Once the log passes 3 MiB it moves to `messages.<n>.jsonl`, the first free number, and a new log starts.
- **Leads start by the plan.** When `plan.json` lists a lead's slug, an Agent call starting that `foundry:lead` is refused while a crew in an earlier wave isn't `merged` or `dropped` (`wave <n> isn't merged yet: <slugs>`), while `maxParallelCrews` crews are already `running`, while a run with `approval: "owner"` has no `approvedAt` (`this run changes the design; get the owner's approval first`), and while the crew's own `ownerApproval` is `pending` (`<slug> waits for the owner's approval`). With no `plan.json`, or a slug not in it, there is no gate, so 0.2.1 runs work as before. The hooks only read `plan.json`.
- **Crew agents set a model and an effort.** An Agent call from inside a crew without `model`, without `effort`, or with `effort: "max"` is refused, with a reason saying what to set.
- **A lead can't stop without a report.** When a lead with no live members and no members' background tasks running stops on a message that has no `## Proof` section and doesn't start with `CHECKPOINT:`, `BLOCKED:`, `QUESTION:` or `PROPOSAL:`, the stop is sent back with a reason. The hook sends a stop back at most twice in a row, then lets it through. That bound relies on Claude Code sending `stop_hook_active` on the stop after a block, which hasn't been seen live; Claude Code itself lets a stop through after 8 consecutive blocks. A stop while a member, or a member's background task, still runs goes through; the lead's own background tasks don't count. A stop while the lead's `QUESTION:`, `BLOCKED:` or `PROPOSAL:` message to `main` is unanswered goes through too: it asked once, and needs no tagged hand-back as well.
- **Stalls wake the foreman.** Every minute the plugin checks for running crew agents with no tool call or model request for 15 minutes. It reports each one once, with a toast and a `[foundry] stalled:` prompt to the main session. An agent that starts running again, or comes back into the list, counts as active from that moment, so a resumed agent isn't reported on its old activity.
- **An idle lead wakes the foreman.** A lead the plugin saw go from running to `idle`, with no final report (a `## Proof` section, `CHECKPOINT:` or `BLOCKED:`) since it last resumed, no waiting tag and no member at work, gets one `[foundry] idle lead:` prompt after 15 minutes, naming the successor to start. The report and tag on disk count too, so after a reload nothing is prompted for until the plugin sees a lead stop again.
- **A usage-limit reset wakes the foreman.** When the five-hour window hits its limit while a lead is still at work, the plugin sets a timer for two minutes after the reset and then sends a `[foundry] limit reset:` prompt, once per reset. If the main session was already active after the reset, the prompt is skipped.
- **Decision times are real.** A Write or Edit of this session's `decisions.md` has the `HH:MM` that opens each new `- HH:MM |` line replaced with the clock's local time. A line whose time is already on a decision line of the text it replaces (the file for a Write, `old_string` for an Edit) keeps it, so an edited line keeps its time. Write the log with Write or Edit, not Bash, or the hook doesn't see it.
- **`/foundry`** shows each crew's wave, verdict and status from `plan.json` when there is one, then lists the crews: each lead's name and status, its live members by model, when it last reported and was last active, any stalled agents, the verdict in its highest-numbered judge file, and its report folder. A lead whose last message to `main`, or last captured report, starts with `QUESTION:`, `BLOCKED:` or `PROPOSAL:` shows as `waiting on you:`, `blocked:` or `proposal:` with the first line, until the foreman messages it. A lead that ended its turn while its members still work shows as `waiting on members`. Under each crew, one line per member gives its status, how long it has run, its model family and its last activity.

Every hook fails open. If foundry's own code throws, the call goes on as if the plugin were not installed, and the error goes to the debug log.

## Limitations

- The slash command is `/foundry`, not `/foundry:status`. A plugin registers its command under a bare name, and `/status` is built in.
- A member is matched to its crew through the agents' parent ids. An agent that ended before the plugin loaded (a reload mid-session) resolves to no crew, and a message to it from a crew agent is refused.
- A lead restarted with the same name shares the old lead's report folder. Start it as `<slug>-2` instead; the skill does.
- No prompt in 0.2.0 (the skill or any of the five agents) has yet run as a live agent in a real run. The hooks are covered by tests against a mock engine.
- What status a lead shows after it ends its turn while its members still run hasn't been observed in a live session. `waiting on members` depends on it.
- Capturing a report from the hand-back tool, through a `tool.call` hook on `SubagentHandback`, is covered by tests but not yet verified in a live session.
- The limit-reset wake rests on three things a probe confirmed: `$.clock` timers run from `session.start`, a hot reload cancels them (so the wake is re-armed from plugin state), and `$.prompt.submit` wakes an idle session. Nobody has yet seen the wake fire after a real usage-limit stop.
- Where an organization manages Claude Code, `SubagentStop` hooks run only in plugins it lists. There, reports are captured only from the hand-back tool. The lead stop gate is a `SubagentStop` hook too, so it shouldn't run there either; that is inferred from the code, not seen.
- `agents/lead.md` tells a lead to load `subagent-limits:split-work`, a skill from the [subagent-limits](../subagent-limits) plugin, when it is available. A run without that plugin hasn't been tested.
- The plan gates trust the foreman's `status` field. A foreman that marks a crew `merged` too early lets the next wave start on code that isn't there. The gates guard against forgetting, not against lying; the judge-gated merge is still the real control.
- TODO: say whether the 0.3.0 prompts (the architect, `/foundry:init`, the plan flow) and the plan gates have run in a live run. Nothing in the repo records it.
- The gate's two-block bound relies on Claude Code sending `stop_hook_active` on the stop after a block, which hasn't been seen live; Claude Code lets a stop through itself after 8 consecutive blocks.

## Install

```
/plugin marketplace add AbhiramDwivedi/claude-ops
/plugin install foundry@claude-ops
```

## Testing

```bash
claude plugin validate plugins/foundry
claude plugin test plugins/foundry
```

*Drafted with AI assistance and reviewed by the author.*
