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
7. merges the crews' branches, runs the project's checks, and asks before any push or PR.

The foreman never does a crew's work itself.

It works with or without agents of your own. When the project defines none that fit, members run as `general-purpose` with a role prompt the lead writes. The [kit](../kit) plugin's `builder`, `test-writer`, `reviewer` and `scout` make good members, and the [worktrees](../worktrees) plugin starts each worktree from your current commit instead of `origin/HEAD`.

## The lead

`foundry:lead` runs on Opus. It splits its crew's goal into member tasks and starts each member with an explicit model (Opus for judgment, Sonnet for mechanical work), named `<crew>-<role>`, in a worktree. It merges the members' branches into the crew branch and runs the checks. It messages another lead only when their work collides, and sends the foreman any question only you can answer. Its final report has fixed sections: Summary, Branch, Changes, Checks run, Open questions. It starts with `CHECKPOINT:` when the lead stopped with work left.

## Merge modes

| Mode | What happens | Use it when |
| --- | --- | --- |
| `sequential` | Crews merge into the target one at a time. A crew whose branch conflicts rebases on what merged before it. The checks run after each merge. | You want one reviewable merge per crew. |
| `single` | Every crew branch merges into one integration branch, `foundry/<short goal>`. The checks run once, and you get one PR. | Each merge to the target triggers something expensive, such as a Vercel deploy. |

## What the hooks do

A crew is a `foundry:lead` started by the main thread, plus every agent below it, however deep. The crew's name is the lead's name. Agents outside every crew are left alone.

- **Reports are saved.** When a crew agent stops, its last message is written to `<git common dir>/foundry/<session id>/reports/<crew>/<agent name>.md`. A report sent through the hand-back tool is saved instead, and the sign-off after it doesn't overwrite it. Outside git the folder is `~/.claude/foundry/<session id>/`. The git common dir is the main checkout's `.git`, so every worktree writes to the same place. Hand-backs from nested agents have been lost on some machines; the lead and the foreman read the file when one doesn't arrive. Each Agent call that starts a lead or a crew member gets a `[foundry]` note naming the path.
- **Crew messages stay inside the crew.** A crew agent's `SendMessage` is allowed to `main`, to its own crew, and from one lead to another. Anything else from inside a crew is refused, with a reason telling a member to go through its lead and a lead to message the other crew's lead. Each lead-to-lead message is logged to `<foundry folder>/messages.jsonl` as `{ ts, from, to, summary }`.
- **Crew agents set a model.** An Agent call from inside a crew without `model` is refused, with a reason telling the agent to set it. The main thread and agents outside crews are not affected.
- **`/foundry`** lists the crews: each lead's name and status, its live members by model, when it last reported, and its report folder.

Every hook fails open. If foundry's own code throws, the call goes on as if the plugin were not installed, and the error goes to the debug log.

## Limitations

- The slash command is `/foundry`, not `/foundry:status`. A plugin registers its command under a bare name, and `/status` is built in.
- A member is matched to its crew through the agents' parent ids. An agent that has ended and was never seen by the plugin (started before a reload) resolves to no crew. A message to a crew member that has ended still goes through when its name starts with `<crew>-`.
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
