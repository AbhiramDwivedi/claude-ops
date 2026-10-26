# foundry

Runs a large goal as several crews of agents working in parallel. The main session is the foreman: it plans the run, decides for it, and is the only one that talks to you. Each crew has a lead that delegates to member agents in its own worktree, and a judge that checks the crew's work against proof. A crew's branch merges into your target branch only after its judge says `VERDICT: PASS`.

[docs/architecture.md](docs/architecture.md) covers the internals: who talks to whom, the files on disk, each hook, and how a run recovers from failures.

## Roles

| Role | Who | What it does |
| --- | --- | --- |
| Owner | You | Picks the goal's altitude, approves the plan, the merge mode and the target branch. Rules on changes to frozen scope, on production deploys, and on every push or PR. |
| Foreman | The main session, after `/foundry:run` | Plans the run and decides for it as product owner, logging every decision. Starts the leads, answers them, and merges what the crews deliver. Never does a crew's work. |
| Cynic | `foundry:cynic`, Opus, effort `high`, outside every crew | Read-only. For each question, proposal or blocker bound for you, recommends `answer`, `defer` or `pass`. Before the merge, checks the crews for drift from the plan and for overlap. It recommends; the foreman decides. |
| Lead | `foundry:lead`, Opus, one per crew | Splits the crew's goal into member tasks, delegates them, merges the members' branches into the crew branch, runs the checks and reports. |
| Members | Your project's agents, plugin agents, or `general-purpose` | Do the building. Each starts with an explicit model and effort and a name that starts with its crew's. |
| Judge | `foundry:judge`, Opus | Never the builder. Checks the proof in the crew's reports, answers a four-question rubric, and reports `VERDICT: PASS` or `VERDICT: FAIL`. Runs one effort level above the strongest builder it judges, from `high` to `xhigh`. In red-team mode it tries to break the crew's work instead. |
| Writer | `foundry:writer`, Opus | A member for the prose a crew ships. Loads the best writing skill the session has (`technical-writer` when it's installed) and writes only what the code or a command it ran shows. |
| DevOps | `foundry:devops`, Sonnet | A member that validates a deploy with proof: rollout status, health endpoint, smoke tests, logs. May deploy a preview or staging build. Never deploys to production or changes it. |

foundry works with or without agents of your own. When the project defines none that fit, members run as `general-purpose` with a prompt the lead writes, which says what the job is rather than who the agent is. The [kit](../kit) plugin's `builder`, `test-writer`, `reviewer` and `scout` make good members, and the [worktrees](../worktrees) plugin starts each worktree from your current commit instead of `origin/HEAD`.

## How a run goes

`/foundry:run` loads the foreman's protocol. The foreman:

1. asks you once whether the goal is the end or one step toward a bigger outcome, and describes the bigger version. You pick one;
2. runs a short depth pass: what a top practitioner would do that wasn't asked for, what the rawest material is, which tools that practitioner would use, and what besides a model verifies the result. The answers decide which crews exist;
3. lists the agent types the session can start (your project's `.claude/agents/*.md`, yours in `~/.claude/agents/`, plugin agents) and the project's skills;
4. splits the goal into crews, usually two to four. Each crew owns its own files, has a done-check it can't game (code it doesn't own, or tests a test-writer writes before the builder starts), tags its high-impact paths (auth, money, migrations, CI, lockfiles), and gets its own port range and database or temp directory;
5. shows the plan as a table and asks for the merge mode and the target branch. Scope grows here, once. When you approve, the foreman writes the plan to disk and the scope is frozen;
6. writes a goal file for each crew and starts every lead in one message, in the background, each in its own worktree;
7. handles the leads' messages, each tagged `QUESTION:`, `BLOCKED:` or `PROPOSAL:`. It decides what it can and logs it. Anything bound for you goes through a cynic first, and a `PROPOSAL:` defaults to no because the scope is frozen;
8. merges each crew once its highest-numbered judge file says `VERDICT: PASS` for the crew branch's head commit;
9. reports to you, and asks before every push and every PR.

The foreman follows the cynic's recommendation by default. To overrule it, the foreman logs a one-line reason, and every overrule appears in the end-of-run report. The foreman clears a `BLOCKED:` itself when it can inside frozen scope, for example from the plan, the decision log or something it knows: a missing input, a collision with another crew. Every other `BLOCKED:` reaches you, and none is ever deferred. A production promotion, a change to frozen scope, and every push or PR reach you whatever the cynic recommends, unless the project grants the foreman merge ownership for pushes and PRs.

## Inside a crew

A lead first proves it can run its crew's checks in its own worktree. If it can't, it sends `BLOCKED:` before splitting any work. It then runs its own, fuller depth pass and turns the answers into member tasks. Anything that would add scope goes to the foreman as a `PROPOSAL:`.

Every member report carries proof: a command and its output, before-and-after numbers, or a walk through the real flow. These don't count as proof: tests the builder wrote after building, "I verified it" with no output, a typecheck alone, a mocked end-to-end test, and output from another commit. Builders may not edit the done-check tests. Every commit carries a `Foundry-Crew: <slug>` trailer.

After the last merge and a green run of the checks, the lead starts a fresh judge. For a crew with high-impact paths, the plan can add a red team first: `foundry:judge` in red-team mode, which works in its own worktree, checks out the crew head SHA there itself, and proves each break with a command and its output. A reproduced break is fixed, and a fresh red team runs before the judge does.

When two fix attempts at one level end with the same check failing, the lead climbs the escalation ladder: Sonnet, then Opus at effort `medium`, `high`, `xhigh`. Each step is a fresh agent, never a resume, and its first deliverable is a root-cause analysis with evidence. If `xhigh` fails twice, the lead sends `BLOCKED:`.

The lead's final report has fixed sections: Summary, Branch, Changes, Proof, Checks run, Open questions. A report that starts with `CHECKPOINT:` means the lead stopped with work left, and the foreman starts a successor lead, `<slug>-2`, from it.

## Merge modes

| Mode | What happens | Use it when |
| --- | --- | --- |
| `sequential` | Crews land on the target one at a time. The foreman asks each lead in turn to rebase its branch onto the target, resolve the conflicts and run the checks. If the rebase moved the head, a fresh judge rules on it. On a PASS for that head, the foreman fast-forwards the target to it. | You want one reviewable merge per crew. |
| `single` | One integrator agent (Opus, in a worktree) merges every crew branch into one integration branch, `foundry-<short goal>`, resolves the conflicts and runs the checks. An integration judge rules on the result. You get one PR. | Each merge to the target triggers something expensive, such as a deploy. |

Conflicts are always resolved by an agent, never in the main thread.

## The end-of-run report

Before anything leaves the machine, the foreman reports each crew's summary and what merged where, the checks and every judge's verdict, the decisions it made and every cynic overrule with its reason, and the items deferred to the end. It lists the high-impact files that changed and asks you to read those, and only those.

## What the hooks do

A crew is a `foundry:lead` started by the main thread, plus every agent below it, however deep. An agent goes by the name it was spawned with, else its id, and the crew by its lead's. Agents outside every crew are left alone, which includes the cynic, the integrator and the integration judge.

- **Reports are saved.** When a crew agent stops, its last message is written to `<git common dir>/foundry/<session id>/reports/<crew>/<agent name>.md`. A report sent through the hand-back tool is saved instead. Outside git the folder is `~/.claude/foundry/<session id>/`. The git common dir is the main checkout's `.git`, so every worktree writes to the same place. Hand-backs from nested agents have been lost on some machines; the lead and the foreman read the file when one doesn't arrive. Each Agent call that starts a lead or a crew member gets a `[foundry]` note naming the path, and the main session gets a `[foundry] dir: <path>` note at session start.
- **Crew messages follow the chain.** A member's `SendMessage` may go to its own lead and the other members of its crew. A lead's may go to `main`, its own members and the other leads. Anything else from inside a crew is refused, with a reason telling a member to go through its lead and a lead to message the other crew's lead. So is an address no agent of the session has had, and a name two live agents in different crews share.
- **Lead-to-lead messages are logged** to `<foundry folder>/messages.jsonl` as `{ ts, from, to, summary }`. Once the log passes 3 MiB it moves to `messages.<n>.jsonl`, the first free number, and a new log starts.
- **Crew agents set a model and an effort.** An Agent call from inside a crew without `model`, without `effort`, or with `effort: "max"` is refused, with a reason saying what to set.
- **A lead can't stop without a report.** When a lead with no live members and no members' background tasks running stops on a message that has no `## Proof` section and doesn't start with `CHECKPOINT:`, `BLOCKED:`, `QUESTION:` or `PROPOSAL:`, the stop is sent back with a reason. The hook sends a stop back at most twice in a row, then lets it through. That bound relies on Claude Code sending `stop_hook_active` on the stop after a block, which hasn't been seen live; Claude Code itself lets a stop through after 8 consecutive blocks. A stop while a member, or a member's background task, still runs goes through; the lead's own background tasks don't count.
- **Stalls wake the foreman.** Every minute the plugin checks for running crew agents with no tool call or model request for 15 minutes. It reports each one once, with a toast and a `[foundry] stalled:` prompt to the main session.
- **A usage-limit reset wakes the foreman.** When the five-hour window hits its limit while a lead is still at work, the plugin sets a timer for two minutes after the reset and then sends a `[foundry] limit reset:` prompt, once per reset.
- **`/foundry`** lists the crews: each lead's name and status, its live members by model, when it last reported and was last active, any stalled agents, the verdict in its highest-numbered judge file, and its report folder. A lead whose last message to `main`, or last captured report, starts with `QUESTION:`, `BLOCKED:` or `PROPOSAL:` shows as `waiting on you:`, `blocked:` or `proposal:` with the first line, until the foreman messages it. A lead that ended its turn while its members still work shows as `waiting on members`.

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
