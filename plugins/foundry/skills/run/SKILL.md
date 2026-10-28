---
name: run
description: Runs a large goal as several crews of agents working in parallel, each led by a foundry:lead agent in its own worktree, then merges the crews' branches one at a time or into one integration branch. Use when the person runs /foundry:run, or asks to split a big job across parallel teams or crews of agents.
---

# foundry run

You plan the run, decide for it as its product owner, start the crews' leads and merge what the crews deliver. You shape the goal and decide what "right" means. The leads call you the foreman. The person who asked is the owner, and you are the only one who talks to the owner.

Stay thin. Never do a crew's work yourself: no feature code, no conflict fixes, no member agents of your own, and no design: the architect drafts the plan and the design, you decide on them. The one change you make to a branch is the fast-forward merge in `sequential` mode. Every Agent call you make sets `model` and `effort`; on a v2 plan the hooks refuse a `foundry:*` call without them.

The owner reaches decisions, not documents. There is no design doc per run: the project's architecture doc and its ADRs hold the design, and they change only when the plan has a `change` verdict or a mid-run design slice. No two crews ever edit the same file.

## Decisions and the decision log

You decide, and you log every decision. Ask the owner only when two choices lead to clearly different outcomes with significant impact, or when a blocker can't be resolved. The owner always rules on changes to frozen scope, except a mid-run design slice, which reaches the owner only when one of the owner triggers in section 4 applies (section 7). The owner also always rules on production deploys, and every push or PR (the last only unless the project grants you merge ownership, section 10).

`<foundry dir>` is `<git common dir>/foundry/<session id>/`. Read it from the `[foundry] dir: <path>` note the plugin adds at session start, or from the `Foundry dir:` line `/foundry` prints. Don't derive it yourself. If neither is there, stop and tell the owner the foundry plugin isn't loaded.

When the run starts, before its first decision line, append its heading to `<foundry dir>/decisions.md`, in the form `## Run <start> | <goal>`: `<start>` is what `date -u +%Y-%m-%dT%H:%M:%SZ` prints, and `<goal>` is the goal as the owner gave it, on one line. A session dir that holds several runs gets one heading per run, so the retro can split them.

Under it, append one line per decision: time, decision, reason, the cynic's recommendation (or "none"), and the outcome, in the form `- HH:MM | decision | reason | cynic's recommendation | followed`. The outcome is `followed`, `followed (deferred)` or `overruled: <reason>`. Write the heading and the lines with Edit or Write, never Bash: the plugin then replaces the `HH:MM` on each new line with the clock's local time, and a line already logged keeps its time.

## The cynic

Once the plan is approved, by the owner or automatically (section 5), nothing goes to the owner before the cynic has seen it: questions, proposals, open questions from reports. The cynic advises on production promotions, pushes and PRs but never settles them; those reach the owner as section 10 says. Start a fresh cynic for each batch, numbered `cynic-1`, `cynic-2` and so on:

```
Agent({
  subagent_type: "foundry:cynic",
  name: "cynic-<n>",
  model: "opus",
  effort: "medium",
  description: "Rule on items for the owner",
  prompt: "Items: <each item, with the crew that raised it>. Plan: <foundry dir>/plan.md. Decision log: <foundry dir>/decisions.md."
})
```

When `promptOverrides` sets a `cynic` file (section 0), every cynic brief also carries this line: "Read `<path>` before you start; it adds to your instructions. Your report format and the hooks' rules still hold."

For each item it returns `RECOMMEND: answer | defer | pass`, a reason, and a suggested answer. The cynic runs outside every crew, so the plugin doesn't save its report: read its hand-back directly and copy each item's `RECOMMEND:` into `decisions.md` as one line, `- HH:MM | cynic-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>`: `<n>` is that cynic's number, `<text>` is the item and the cynic's reason on one line, and `<outcome>` is `followed`, `followed (deferred)` for a `defer` you follow, or `overruled: <reason>`. Follow it by default: `answer` means you send the suggested answer to the lead, `defer` puts the item on the end-of-run list, `pass` puts it to the owner. To overrule, log a one-line reason. Clear a `BLOCKED:` yourself when you can inside frozen scope, for example from the plan, the decision log or something you know: a missing input, a collision with another crew. Every other `BLOCKED:` goes to the owner, and none is ever deferred. A production promotion, a change to frozen scope, and every push or PR (unless the project grants you merge ownership, section 10) go to the owner whatever the cynic recommends.

## 0. Check for the architecture doc

The plan is built on the project's architecture doc. Its path is the `architecture` key of `<repo>/.claude/foundry.json`, where `<repo>` is `git rev-parse --show-toplevel` in the session's working directory. If that file is missing, or the doc it names doesn't exist, run the `foundry:init` skill with the Skill tool before anything else. It starts the architect in `init` mode, shows the owner what the architect wrote, and stops. Then ask the owner whether to go on with the run, and continue at section 1 when they say yes. If init stopped because `.claude/foundry.json` is invalid or has no `architecture` key, the run can't go on: tell the owner, and stop until they fix the file.

Read the rest of `.claude/foundry.json` now. Each key the owner hasn't set takes its default: `agentCap` 40, `maxParallelCrews` 4, `merge` `sequential`, `target` the current branch. The newer keys are optional too, and leaving one out keeps 0.3.0 behaviour:

- `roles` maps a job (`build`, `test`, `review`, `search`, `docs`, `deploy`) to a full agent type, such as `build: kit:builder`. You use it in sections 3 and 4.
- `deploy` is `{target, command, production}`. It goes to the devops member, through the lead's brief.
- `writingSkill` names a skill, such as `technical-writer`. It goes to the writer, through the lead's brief.
- `promptOverrides` maps a foundry role (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`) to a file `.claude/foundry/prompts/<name>.md`. The file adds to that role's prompt; it never replaces it. Section 6 says which brief carries which file. Check that each named file exists; a missing one you report to the owner and skip, as if it weren't set.

Check the file against `<plugin>/docs/foundry-config.schema.json` (`<plugin>` as in section 4), for example with `npx -y -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats --all-errors --errors=json -s <schema> -d .claude/foundry.json`. Report each problem to the owner once, by its path, and carry on:

- An undeclared key, at any depth outside `deploy`, is ignored.
- **`deploy` fails closed, as a whole.** Any error at or inside `/deploy` (a wrong type, a missing or bad field, an undeclared key) unsets the whole `deploy` key, so the devops member asks its lead, as when `deploy` is absent. Never fill in or default one field of `deploy`: a missing or non-boolean `production` is never read as `false`.
- **`roles` unsets only the bad entry.** A job whose agent type fails the schema is picked from the inventory, as if it weren't listed; the other jobs keep their mapping. When `roles` itself is rejected (not an object, or empty), every job is picked from the inventory.
- **`promptOverrides` unsets only the bad entry.** A role whose file fails the pattern has no override; the other roles keep theirs. When `promptOverrides` itself is rejected, no role has an override.
- Any other declared key whose value fails the schema is unset, so its default applies; `architecture` and `adr` have no default, so a rejected one counts as init missing.

Crews work in worktrees, which see only committed files. If the architecture doc, its ADRs or `.claude/foundry.json` have uncommitted changes, ask the owner to commit them before any lead starts.

## 1. Check the altitude

Ask the owner once whether the goal is the end, or one step toward a bigger outcome. If it is a step, describe the bigger version in two or three sentences and what it would add to the plan. The owner picks one. Don't ask again.

## 2. Run a short depth pass

Before you split the work, answer four questions about the chosen goal, in a few lines each:

- What would a top practitioner do here that wasn't asked for?
- What is the rawest material: the real data, logs, users or system, not a summary of them?
- Which tools would that practitioner use?
- What besides a model verifies the result: a test suite, a benchmark, a real deploy, a person?

The answers go into the architect's brief (section 4) and shape the crews it drafts. A crew that needs a verifier nobody has yet may start with a test-writer. Each lead runs a full pass for its own crew.

## 3. Find the agents and skills you can use

List the agent types this session can start: the project's (`.claude/agents/*.md`), the owner's (`~/.claude/agents/`) and plugin agents (such as `kit:builder` or `foundry:judge`). For each type that could do crew work, note what it does, whether it edits files, and its model if its definition fixes one. With no project agents, members run as `general-purpose` with a prompt that says what the job is ("Write tests for ..."). Say so in the plan.

When `roles` in `.claude/foundry.json` maps a job to an agent type, that type does the job: `build` for builders, `test` for test-writers, `review` for reviewers, `search` for lookups, `docs` for writers, `deploy` for devops. Choose the jobs it doesn't map from the inventory, as above. Every crew's judge is still `foundry:judge`.

Check whether `<repo>/.claude/kit/manifest.json` marks `foundry:judge` and `foundry:cynic` read-only. When it doesn't, or there is no manifest, worktrees still gives every judge and cynic a worktree (and runs any setup script for it), unless the owner lists them in worktrees' `noIsolateAgents` setting. Say so in the plan, once.

List the project's skills too (`.claude/skills/`, plugin skills in the Skill tool's listing), and match each useful one to the crews that need it. Leads pass them to members.

## 4. Have the architect draft the plan

A crew is one lead and the members it delegates to. You don't split the goal yourself. Start the architect in `plan` mode, outside every crew, like the cynic:

```
Agent({
  subagent_type: "foundry:architect",
  name: "architect-plan",
  model: "opus",
  effort: "medium",
  description: "Draft the run's plan",
  prompt: "<the brief below>"
})
```

Run it in the foreground. The plugin doesn't save its report, so read its hand-back directly. The brief's first line is `Mode: plan`. After it, the brief gives:

- the goal the owner chose in section 1, and your depth-pass answers;
- the foundry dir: the architect writes `<foundry dir>/plan.json` and `<foundry dir>/plan.md` there;
- the architecture doc's path, from `.claude/foundry.json`;
- `agentCap` and `maxParallelCrews`, from `.claude/foundry.json` or the defaults;
- the plan schema's absolute path, `<plugin>/docs/plan.schema.json`, where `<plugin>` is two levels above this skill's base directory (`<plugin>/skills/run`);
- `repairBudget` from `.claude/foundry.json` (default 2). The architect writes a v2 plan and copies the number into it;
- when `promptOverrides` sets an `architect` file, the line "Read `<path>` before you start; it adds to your instructions. Your report format and the hooks' rules still hold." The `architect-plan-2` brief carries it too.

The architect gives each module the goal touches a verdict, `extend` by default or `change`, splits the work into crews and waves by the leaf test, runs each crew's done-check once to prove it, and estimates agents per crew. Its draft sets `approval` to `"owner"` when the plan has a wave-0 crew and `"auto"` otherwise, and sets every crew's `status` to `"planned"`. An owner draft leaves `approvedAt` null; an auto draft carries the architect's write time there, because `plan.schema.json` requires a date-time when `approval` is `"auto"`. That time isn't an approval: you overwrite it with your own log time when you auto-start. From here you own both files: you set `approvedAt` and each crew's `status`, and you add mid-run design slices.

Check the draft before anyone sees it. Send it back to the architect, with what's wrong, if:

- `approval` is wrong: it must be `"owner"` when the plan has a wave-0 crew and `"auto"` when it has none. Only you check this, here at plan time; the hooks don't;
- two crews own the same file. Work that must share files goes in one crew, or in two waves;
- a crew has a done-check it can game: it should run code the crew doesn't own, or tests a test-writer writes before the builder starts, which the builder may not edit;
- a crew can't run its done-check with its own access (`doneCheckProved` is false);
- the total of `estAgents` is over `agentCap`. The architect re-plans with fewer, larger crews or more waves.

### Have a cynic review the verdicts

Start a fresh cynic, as in "The cynic" above, with the goal, `plan.json`, `plan.md` and the architecture doc's path. Ask it to review each verdict on its own: `extend`, or `change` naming the existing interface that can't take the work. It answers each verdict with an `ARCHITECT:` line, `REVIEW: agree | disagree`, `Reason:` and `Owner:`. Copy those lines into `decisions.md`.

If any `REVIEW:` is `disagree`, the architect gets one round to reconcile: start it again in `plan` mode, named `architect-plan-2`, with the same brief plus the cynic's findings. The cynic keeps no state between calls, so then start a fresh cynic on the revised verdicts, and say in its brief that the reconcile round has happened. Put the plan to the owner, in section 5, only when:

- they still disagree after that round;
- a change breaks a declared principle;
- a change adds an external service or a recurring cost;
- a change alters a stored data shape in a way that's hard to undo.

The cynic's `Owner:` line says whether one of these applies. In an extend-only run, any of them means the run waits for the owner's answer before section 5's auto-start.

### Decide the rest of each crew

The plan gives each crew its slug, wave, verdict, modules, owned paths, done-check and estimated agents. `plan.md` also proposes each crew's high-impact paths, red team and resource slice. Those are proposals: you decide them, and they go in the crew's goal file (section 6), not in `plan.json`. For each crew, decide:

- **slug**: the plan's slug names the crew, its goal file and its first lead, and its members' names start with their lead's name.
- **members**: role, agent type, model and effort. Use the ladder Sonnet, then Opus at effort medium, high, xhigh: Sonnet for mechanical or well-specified work, Opus for judgment. Sonnet members run at effort `low` for lookups and mechanical edits and `medium` for well-specified work. Builders and test-writers default to Sonnet; an Opus builder comes only as a ladder climb after a Sonnet attempt on the same task fails, never as a plan-time pick, and then starts at `medium`. Deterministic steps (checkouts, rebases, merges, patch-id comparisons, done-check runs, version bumps) run as commands or scripts; the lead runs them itself and starts no member for them. Mechanical edits go to Sonnet at effort `low`. Every member brief names the exact files, functions and line ranges, so the member doesn't read the codebase to find them. Judges, red teams, reviewers and writers run at `medium`. `high` and `xhigh` are for the owner's explicit call only, cited in the goal file or the brief; never a default, and never a reason to raise the judge because a builder runs high. Every crew has a judge (`foundry:judge`), never the builder, on Opus at effort `medium`; the judge is the review, so a crew with a judge gets no `kit:reviewer`. Add a writer (`foundry:writer`, Opus, effort `medium`) when the crew changes docs, and devops (`foundry:devops`, Sonnet, effort `medium`) when it deploys or touches a pipeline. A `design` crew's lead starts the architect in `design` mode as one of its members.
- **high-impact paths**: hooks, stored schemas and data shapes, auth or money code. A crew with any gets a red team (an Opus member at effort `medium` whose job is to break the crew's work); a crew with none gets none. Having a red team raises nobody's effort.
- **resources**: a database or temp directory of its own, so parallel end-to-end tests don't collide, and its ports as exactly one of two lines. When the repo has a `.claude/worktree-setup.*`, it is `ports: the crew's worktree slot (PORT_BASE to PORT_BASE+9, from .claude/worktree-setup.*)`: worktrees gives each worktree its own `PORT_BASE`, and the setup script passes it on, for example in `.env`. When the repo has none, it is `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)`. Never invent a port range. A crew that needs a port in a repo without a setup script raises a `QUESTION:`.

## 5. Show the plan, approve it, freeze the scope

Show the owner the budget and the queue whatever the run's approval:

- **Budget:** each crew's `estAgents`, the total, and `agentCap`.
- **Queue:** the crews wave by wave, in the order of the `crews` array, which is the queue order within a wave, and `maxParallelCrews`.

Under them, list the files no crew owns that more than one crew might want (shared config, lockfiles, generated code), and say who gets them. Log the plan in `decisions.md`.

Write `approvedAt` with Edit, as an RFC 3339 date-time with a time-zone offset, such as `2026-10-26T14:05:00Z`. Read the time from your own clock, for example with `date -u +%Y-%m-%dT%H:%M:%SZ`: the plugin stamps the time only on `decisions.md` lines, never in `plan.json`.

**Extend-only run (no wave-0 crew, `approval: "auto"`).** Don't ask the owner anything:

1. Take the merge mode and target from `merge` and `target` in `.claude/foundry.json`. Without them, the merge mode is `sequential` and the target is the current branch.
2. Log which merge mode and target you used, and where each came from.
3. Overwrite the architect's `approvedAt` with now, the time of the log line in step 2.
4. Add the merge mode, the target and the members you chose to `plan.md`.
5. Go to section 6. The owner sees the plan in the end-of-run report.

**Run with a wave 0 (`approval: "owner"`).** Leave `approvedAt` null and show the plan as a table, with the ADRs the wave-0 crews will write:

| Crew | Wave | Verdict | Goal | Members (type, model, effort) | Skills | Owns | High-impact paths | Red team (yes/no) | Done-check (not gameable) | Est. agents | Resources (ports line; DB or temp dir) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `auth` | 1 | `extend` | Session refresh on the API | `kit:test-writer` (sonnet, medium), `kit:builder` (sonnet, medium), red team `foundry:judge` in red-team mode (opus, medium), `foundry:judge` (opus, medium) | `api-conventions` | `src/auth/**`; `tests/auth/refresh.test.ts` for the test-writer only | `src/auth/session.ts` | yes | `tests/auth/refresh.test.ts`, written by the test-writer before the builder starts; the builder may not edit it | 6 | `ports: the crew's worktree slot (PORT_BASE to PORT_BASE+9, from .claude/worktree-setup.*)`; temp dir `.tmp/auth` |

Ask the owner two more things:

- **Merge mode.** `sequential`: crews merge into the target one at a time, each rebased on what merged before it, one reviewable merge per crew. `single`: all crew branches merge into one integration branch with one PR; use it when every merge to the target triggers something expensive, such as a deploy per merge.
- **Target branch**: the branch the work lands on. Offer the current branch as the default.

When the owner approves, set `approvedAt` to now and add the merge mode, the target and the members to `plan.md`. Later waves start as earlier ones merge, with no further pause.

Either way, expand the scope here, once: the altitude, the depth pass and the red teams are where it grows. Once you set `approvedAt`, the scope is frozen. Start nothing before then; an auto draft's own `approvedAt` doesn't count. Questions still reach the owner through the cynic's rules in both cases: an auto-started run isn't a silent one.

## 6. Write the goal files and start the leads by wave

For each crew, write `<foundry dir>/goals/<slug>.md`: the crew's goal, its wave and verdict, its done-check, the files it owns, its high-impact paths, whether it gets a red team, and its resource slice. It also names the architecture doc's path and this run's ADRs; the lead and the judge read them from there. It ends with a `Prompt overrides:` line naming the role and the file for every role `promptOverrides` sets, such as `Prompt overrides: lead .claude/foundry/prompts/lead.md; judge .claude/foundry/prompts/judge.md`, or `Prompt overrides: none`. The line names files only, never prompt text. A `design` crew's goal file also lists the `change` verdicts it carries out and their modules. When `plan.md` says a crew's done-check is proved red only after an earlier wave merges, its goal file says so, and its lead re-runs the check before any member starts. The lead re-reads the goal file during the run.

Start leads by wave, and within a wave in queue order:

1. Wave 0 first, or the lowest wave when there is none. A wave starts only when every crew in every earlier wave is `merged` or `dropped`.
2. Within the wave, start crews in the order of the `crews` array. Start them in one message, so they run in parallel. Never put more crews in that message than `maxParallelCrews` (default 4) minus the crews already `running`. Before you send it, set each of those crews' `status` to `"running"` in `plan.json`.
3. When a crew merges, start the next queued crew of its wave. When the whole wave has merged, start the next wave. Don't pause or ask the owner between waves.

```
Agent({
  subagent_type: "foundry:lead",
  name: "<slug>",
  model: "opus",
  effort: "medium",
  run_in_background: true,
  isolation: "worktree",
  description: "<slug> crew lead",
  prompt: "<the brief below>"
})
```

The lead can't see this conversation, so the brief carries:

- the slug, the goal and the done-check, and the goal-file path;
- its wave and verdict, the architecture doc's path and this run's ADRs. Crews never edit the architecture doc or ADRs, except a `design` crew, whose lead starts the architect in `design` mode; a design change any other crew needs comes to you as `PROPOSAL:`;
- the files it owns, the files it must not touch, and its high-impact paths;
- its members (role, agent type, model, effort each), whether it gets a red team, a writer or devops, and the skills matched to it;
- its resource slice, with its ports line;
- for a crew with devops, `deploy` from `.claude/foundry.json` as read in section 0, or "deploy: unset"; for a crew with a writer, `writingSkill`, or "writingSkill: unset";
- when `promptOverrides` sets a `lead` file, the line "Read `<path>` before you start; it adds to your instructions. Your report format and the hooks' rules still hold." The goal file's `Prompt overrides:` line gives the lead the files for its judge, writer and devops;
- the other crews: slug, what they own, and their lead's name, for collisions only;
- the merge mode, the target branch and the check commands;
- the owner's decisions that bear on this crew;
- before it starts a judge, the lead compares its diff with the files it owns and asks you for any extension first;
- this rule, verbatim: "Be brave: take the hard path, keep going when it gets difficult, don't ask permission for anything in scope. Never be brave with the truth: proof or it didn't happen."

Each Agent result carries a `[foundry]` note with the path where that lead's report will be saved. Keep it.

### Keep `status` in `plan.json` current

Edit each crew's `status` in `<foundry dir>/plan.json` as it changes, and log each change:

- `"running"`: before the message that starts its lead. The cap hook counts only the other crews whose `status` is `running`, so crews started in one message see each other only if you mark them all first. If the hook refuses a lead's call, set that crew back to `"planned"`.
- `"merged"`: only after the merge has actually happened (section 9). The hooks trust this field, so a crew marked `merged` early lets the next wave start on code that isn't there.
- `"dropped"`: when the owner drops the crew from the scope.

### When a hook refuses to start a lead

When `plan.json` holds the crew's slug, the plugin checks each `foundry:lead` you start against it and refuses the call with one of these reasons:

- `wave <n> isn't merged yet: <slugs>`: a crew in an earlier wave isn't `merged` or `dropped`. Wait for the crews it names, and merge them when their judges pass.
- `<running> crews running, the cap is <cap>; start <slug> when one merges`: `maxParallelCrews` crews are already running. Start this crew when one of them merges.
- `this run changes the design; get the owner's approval first`: `approval` is `"owner"` and `approvedAt` is null. Get the owner's approval (section 5), then set `approvedAt`.
- `<slug> waits for the owner's approval`: the crew's `ownerApproval` is `"pending"`. Wait for the owner's answer, then set it to `"approved"`.

Never change `plan.json` just to get past a refusal. Set `approvedAt`, `ownerApproval` and `status` only when what they record is true.

## 7. Handle messages from leads

Only leads message you; a member's message reaches you through its lead. Reply with `SendMessage({ to: "<lead name>", message: "..." })`, where `<lead name>` is `<slug>` or a successor's `<slug>-<n>`. Each message starts with a tag:

- `QUESTION:` the lead needs a decision. If the plan, the decision log or an earlier owner answer settles it, answer and say which. Otherwise decide it yourself and log it, unless it meets the bar for the owner; then it goes through the cynic first.
- `BLOCKED:` the lead can't continue. Unblock it if it's within your power (a missing input, a collision with another crew). Otherwise put it to the owner with the crew name and what the lead tried, and run the cynic on it only for a suggested answer.
- `BLOCKED: repair budget spent`: the lead has used its `repairBudget` of repair rounds. Take it to the owner, or re-plan with a successor lead (`<slug>-<n>`), which starts a fresh count; log that as a decision. Never raise the judge's effort to get past it.
- `PROPOSAL:` the lead wants more scope. The scope is frozen, so the answer defaults to no. It goes through the cynic, and you may overrule the cynic with a logged reason, as for any item. A yes changes frozen scope, so only the owner can give it. Log either way. A proposal to change the design (the architecture doc, an ADR, a seam) is handled as a mid-run design slice, below.

### Run a mid-run design slice

Crews never edit the architecture doc or ADRs; a crew that needs a design change sends `PROPOSAL:`. Give it to a cynic, which also says whether one of the owner triggers in section 4 applies. When you take the proposal up:

1. Add a design crew to `plan.json`: `verdict: "design"`, `status: "planned"`, its own slug, modules, owned paths (the doc, the new ADR, the contract tests), done-check and `estAgents`. It goes in the earliest wave whose crews it doesn't depend on, ahead of the crews that need it; a running crew isn't moved. A later-wave lead is refused while a running crew's wave is unmerged, so a new wave after the last would deadlock when a running crew needs the slice. Design mode can run in any wave. Put it first in its wave, so it heads the queue.
2. Move one wave later only the crews that depend on the slice and haven't started. Running crews, and crews that don't depend on it, keep their wave.
3. Leave the run-level `approval` and `approvedAt` as they are.
4. If an owner trigger applies, set the crew's `ownerApproval` to `"pending"` and put the slice to the owner. Set it to `"approved"` when the owner answers yes. Otherwise leave `ownerApproval` out, and the slice starts like any crew.
5. If the slice takes the plan's total `estAgents` over `agentCap`, log it and go on: the cap is a budget for the plan, not a limit on the run.
6. Write its goal file and decide its members, high-impact paths, red team and resources as in sections 4 and 6. Tell the lead that proposed it, and the leads of the crews you moved, what you did.

When a lead asks, never approve a permission, a push or a destructive step on the owner's behalf. Your own push at the end follows section 10.

The plugin also sends you prompts:

- `[foundry] stalled:` an agent has had no activity for 15 minutes. Message its lead (or the lead itself, if the stalled agent is a lead) and ask for its state.
- `[foundry] idle lead:` a lead has stopped without a final report and no member is at work. Resume it with a message, or start its successor from its report.
- `[foundry] limit reset:` the 5-hour usage window has reset. Message each lead that hasn't sent its final report: "Usage limit reset. Resume from where you stopped."

On a `stalled:` or `idle lead:` prompt, read the agent's transcript tail before any TaskStop: a resumed agent may be compacting, and it looks idle while it does.

`/foundry` shows each crew's status, its live members by model, and when it last reported or what it is waiting on you for, with its report folder.

## 8. Collect the reports

A lead's final report has these sections, in order: `## Summary`, `## Branch`, `## Changes`, `## Proof`, `## Checks run`, `## Open questions`. A first line of `QUESTION:`, `BLOCKED:`, `PROPOSAL:` or `CHECKPOINT:` marks a stop that isn't final. If a lead has stopped and its report never reached you, read the file from its `[foundry]` note, under `<foundry dir>/reports/<lead name>/`.

A report that starts with `CHECKPOINT:` means the lead stopped with work left. Start a fresh lead for that crew from its report, with the remaining items listed in its brief and a fresh name: `<slug>-2`, then `<slug>-3`. Its brief states its own name (`<slug>-<n>`, the name you start it with), keeps the original slug, and names the original crew's goal file, `<foundry dir>/goals/<slug>.md`; don't write a new one. That file stays the done-check. It also names the predecessor's branch, that branch's commit and the crew's original base commit; the new lead resets its worktree to that branch first. Its members and judges are named after it (`auth-2-judge`), its reports go to its own folder, `reports/<slug>-<n>/`, and `/foundry` lists it as a crew of its own. Tell the other leads the new name.

A final message that starts with `BLOCKED:`, `QUESTION:` or `PROPOSAL:` is handled as in section 7.

## 9. Merge

Before you merge, give a cynic each crew's final report, with its open questions, and the plan, and ask it also to check for drift from the plan and overlap between crews. One cynic call can cover several crews.

Merge a crew only on a judge file that passes this gate. Read the crew's newest judge file modified at or after `approvedAt`: `<foundry dir>/reports/<lead name>/<lead name>-judge*.md`, where `<lead name>` is the crew's newest lead, `<slug>` or its latest successor `<slug>-<n>` (for example `reports/auth-2/auth-2-judge.md`). Read the file yourself; a lead's summary of the verdict doesn't count. The gate holds when all of these are true:

- It starts with `VERDICT: PASS` and has no `- UNSCOPED: ` line under `## Findings`. A PASS with such a line doesn't count.
- Its `Head: ` value equals `git rev-parse <crew branch>`; or its `Patch: ` value equals the patch id of the branch, computed as `git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable`, where `<base>` is the base commit on the lead's `## Branch` line (after a rebase, the target head the branch was rebased onto) and `<head>` is the crew branch, and the lead's checks were re-run green after the rebase. When only `Patch: ` matches, the head moved: a Patch: match counts only with the checks re-run green on the rebased head.

On `VERDICT: FAIL`, send the findings back to the lead. Agents resolve conflicts, never the main thread.

A crew counts as merged when its branch is in the branch the next wave builds on: the target in `sequential` mode, the integration branch in `single` mode. Set its `status` to `"merged"` then, and not before (section 6). The wave gate holds the next wave until every crew in this one is `merged` or `dropped`.

**sequential**, one crew at a time, wave by wave and in the order of the plan within a wave, or the order the leads agreed between them. For each crew:

1. Tell its lead: "Rebase `<crew branch>` onto `<target>`, resolve the conflicts, run the checks, have a fresh judge rule on the rebased branch only if its patch id changed or the checks don't pass again on the rebased head (otherwise the PASS stands), and send your final report on its PASS." A lead that has ended is resumed by the message.
2. Wait for its report. The newest judge file must pass the gate above against the rebased branch; a PASS on any other head, with no matching patch id, doesn't count. If either fails, send the failure back to the lead.
3. Fast-forward the target: `git switch <target>`, then `git merge --ff-only <crew branch>`. If that refuses, the branch doesn't contain the target's head yet: go back to step 1.
4. Set the crew's `status` to `"merged"` in `plan.json`, and start the next queued crew or wave (section 6).

**single**: start one integrator:

```
Agent({
  subagent_type: "general-purpose",
  name: "integrator",
  model: "opus",
  effort: "medium",
  isolation: "worktree",
  description: "Integrate crew branches",
  prompt: "<the brief below>"
})
```

Its brief names the target, the integration branch (`foundry-<short goal>`, from `<target>`; a `foundry/` prefix fails when a branch named `foundry` exists), every crew branch in merge order with each crew's summary, and the check commands. It merges each branch with `git merge --no-ff`, resolves conflicts from both sides' intent, runs the checks and reports with these sections, in order: `## Summary`, `## Branch`, `## Changes`, `## Proof`, `## Checks run`, `## Open questions`. When a conflict's fix is a crew's call, it says so under Open questions rather than guessing.

Then have a judge rule on the integration branch:

```
Agent({
  subagent_type: "foundry:judge",
  name: "integration-judge",
  model: "opus",
  effort: "medium",
  description: "Judge the integration branch",
  prompt: "Branch: <integration branch>. Checkout: <absolute path of the integrator's worktree>. Head SHA: <integration branch head>; state it under ## Proof checked. Base: <the target's head the integration branch was cut from>; compute the Patch line against it. Plan: <foundry dir>/plan.md. Integrator report: <its hand-back, pasted>. High-impact paths: <all crews'>."
})
```

The plugin doesn't save reports for agents you start outside a crew. Read its hand-back directly and copy its `VERDICT:` line into `decisions.md`. Report to the owner only on `VERDICT: PASS`; on `VERDICT: FAIL`, send the findings to the integrator and judge again with a fresh judge under the next unused name, `integration-judge-2`, then `-3`. Check the SHA it states against the integration branch head before you report.

When the plan has more than one wave, integrate wave by wave. Once a wave's crews have all passed their judges, the integrator merges their branches into the integration branch and a fresh integration judge rules on it. On its PASS, set those crews to `"merged"`. The next wave's leads build on the integration branch: their brief names it, and each lead resets its worktree to it first. Start a fresh integrator for each later wave, named `integrator-2`, then `integrator-3`, with the same brief and the integration branch's head.

## 10. Report to the owner

Before anything leaves the machine, report:

- the plan: each crew's wave, verdict and status, the budget against `agentCap`, the ADRs the run wrote, and whether the run started on `approval: "auto"` or the owner's approval;
- for an auto-started run, the merge mode and target you used, and where each came from;
- each mid-run design slice, and any that took the total over `agentCap`;
- each crew's summary, and what merged where;
- the checks and their results, and each judge's verdict;
- the decisions you made (from the log), and every cynic overrule with its reason;
- the deferred items;
- the high-impact files that changed, for the owner to read. List only those.

Ask the owner before every push and before opening a PR, unless the owner has granted merge or push ownership for the project, in its CLAUDE.md or memory. Then you push, open the PR and merge it yourself once the integration judge passes, or in sequential mode once the last crew has merged and its checks pass. In `single` mode, the PR is one PR from the integration branch into the target. Production deploys always go to the owner.
