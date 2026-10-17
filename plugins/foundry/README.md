# foundry

Runs a large goal as several crews of agents working in parallel. The main session is the foreman and the only one that talks to you. Each crew has a lead that delegates to member agents in its own worktree, and the crews' branches merge into your target branch at the end.

## How it works

`/foundry:run` loads the foreman's protocol. The foreman:

1. lists the agent types the session can start: your project's (`.claude/agents/*.md`), yours (`~/.claude/agents/`) and plugin agents;
2. splits the goal into crews, each with a slug, a goal, members by agent type and model, and the files or areas it owns;
3. shows the plan as a table and waits for your approval;
4. asks for the merge mode and the target branch;
5. starts one `foundry:lead` per crew on Opus, in the background, each in its own worktree and named after its crew;
6. passes the leads' questions to you and your answers back;
7. has the crews' branches merged by agents (see merge modes), and asks before any push or PR.

The foreman never does a crew's work itself.

It works with or without agents of your own. When the project defines none that fit, members run as `general-purpose` with a role prompt the lead writes. The [kit](../kit) plugin's `builder`, `test-writer`, `reviewer` and `scout` make good members, and the [worktrees](../worktrees) plugin starts each worktree from your current commit instead of `origin/HEAD`.

## The lead

`foundry:lead` runs on Opus. It splits its crew's goal into member tasks and starts each member with an explicit model (Opus for judgment, Sonnet for mechanical work), named `<crew>-<role>`, in a worktree. It merges the members' branches into the crew branch and runs the checks. It messages another lead only when their work collides, and sends the foreman, as a message starting `QUESTION:`, any question only you can answer. Its final report has fixed sections: Summary, Branch, Changes, Checks run, Open questions. It starts with `CHECKPOINT:` when the lead stopped with work left.

## Merge modes

| Mode | What happens | Use it when |
| --- | --- | --- |
| `sequential` | Crews land on the target one at a time. The foreman asks each lead in turn to rebase its branch onto the target, resolve the conflicts and run the checks, then fast-forwards the target to it. | You want one reviewable merge per crew. |
| `single` | One integrator agent (Opus, in a worktree) merges every crew branch into one integration branch, `foundry/<short goal>`, resolves the conflicts and runs the checks. You get one PR. | Each merge to the target triggers something expensive, such as a Vercel deploy. |

Conflicts are always resolved by an agent, never in the main thread. The foreman asks you before any push or PR.

## What the hooks do

A crew is a `foundry:lead` started by the main thread, plus every agent below it, however deep. An agent goes by the name it was spawned with, else its id, and the crew by its lead's. Agents outside every crew are left alone.

- **Reports are saved.** When a crew agent stops, its last message is written to `<git common dir>/foundry/<session id>/reports/<crew>/<agent name>.md`. A report sent through the hand-back tool is saved instead, and the sign-off at the stop that follows doesn't overwrite it. Outside git the folder is `~/.claude/foundry/<session id>/`. The folder is worked out once per session, from the session's working directory; the git common dir is the main checkout's `.git`, so every worktree writes to the same place. Hand-backs from nested agents have been lost on some machines; the lead and the foreman read the file when one doesn't arrive. Each Agent call that starts a lead or a crew member gets a `[foundry]` note naming the path.
- **Crew messages follow the chain.** A member's `SendMessage` may go to its own lead and the other members of its crew. A lead's may go to `main`, its own members and the other leads. Anything else from inside a crew is refused, with a reason telling a member to go through its lead and a lead to message the other crew's lead. So is an address no agent of the session has had, and a name two live agents in different crews share. A name resolves to its live agents first; when none is live, to the newest one seen.
- **Lead-to-lead messages are logged** to `<foundry folder>/messages.jsonl` as `{ ts, from, to, summary }`. Once the log passes 3 MiB it moves to `messages.<n>.jsonl`, the first free number, and a new log starts.
- **Crew agents set a model.** An Agent call from inside a crew without `model` is refused, with a reason telling the agent to set it. The main thread and agents outside crews are not affected.
- **`/foundry`** lists the crews: each lead's name and status, its live members by model, when it last reported, and its report folder. A lead whose last message to `main`, or last captured message, starts with `QUESTION:` shows as `waiting on you: <question>` until the foreman messages it.

Every hook fails open. If foundry's own code throws, the call goes on as if the plugin were not installed, and the error goes to the debug log.

## Limitations

- The slash command is `/foundry`, not `/foundry:status`. A plugin registers its command under a bare name, and `/status` is built in.
- A member is matched to its crew through the agents' parent ids. An agent that ended before the plugin loaded (a reload mid-session) resolves to no crew, and a message to it from a crew agent is refused.
- A lead restarted with the same name shares the old lead's report folder. Start it as `<slug>-2` instead; the skill does.
- Capturing a report from the hand-back tool, through a `tool.call` hook on `SubagentHandback`, is covered by tests but not yet verified in a live session.
- Where an organization manages Claude Code, `SubagentStop` hooks run only in plugins it lists, so reports are captured only from the hand-back tool there.

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
