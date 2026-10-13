# worktrees

Keeps agents from stepping on each other's files, and cleans up after them.

- **Every agent that can edit gets a git worktree.** When an Agent call leaves `isolation` unset and the session is in a git repo, the mod sets `isolation: "worktree"`. Read-only agent types run in the session's checkout: `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `scout`, `reviewer`, plus any you list in `readOnlyAgents`. A call that already chose `worktree` or `remote` is left alone.
- **The worktree starts from your current commit.** Claude Code's default worktree starts from `origin/HEAD`, so an agent never sees your unmerged branch. The mod creates every worktree itself, from the HEAD of the checkout the session works in (a detached HEAD too).
- **A project can set each worktree up.** Gitignored files listed in `.worktreeinclude` are copied in from the main checkout. If the repo has `.claude/worktree-setup.ps1` (Windows) or `.claude/worktree-setup.sh` (elsewhere), the mod gives the worktree a port slot and runs the script in it. See the contract below.
- **What an agent leaves running is stopped.** When an agent that ran in a worktree stops, and when a worktree is removed, the mod stops every process whose command line names that worktree, and anything listening on its slot's ports.
- **Merged work is removed.** In the background at session start, and on demand with `/tidy`, it removes the worktree, local branch and remote branch of every merged branch, when nothing would be lost. It fast-forwards a stale local default branch, and stops processes left in worktrees that no longer exist. The toast names every branch it deleted. `/tidy dry-run` shows what it would do and changes nothing.

| Setting | Default | What it does |
| --- | --- | --- |
| `readOnlyAgents` | empty | Comma-separated agent types that never edit, added to the built-in list. |
| `portBase` | 4000 | Slot N owns ports `portBase + N*10` to `portBase + N*10 + 9`. |
| `tidyOnStart` | true | Tidies merged branches in the background when a session starts, at most every 10 minutes per repo. |

## How a worktree is made

The mod creates `<main checkout>/.claude/worktrees/<name>` on a new branch `worktree-<name>`, the place and name Claude Code uses. The branch starts at the commit checked out where the session works. **Uncommitted changes in your checkout never reach the agent**: commit before you start an agent that needs them.

If the main checkout has a `.worktreeinclude` file (gitignore syntax), the untracked files it matches that `.gitignore` also ignores are copied into the new worktree. Use it for `.env` and similar local files.

## The `.claude/worktree-setup` contract

Commit the script to the repo. The mod runs it once, right after it creates a worktree, with the worktree as the working directory and these variables set:

| Variable | Value |
| --- | --- |
| `WORKTREE_PATH` | The new worktree, absolute. |
| `WORKTREE_NAME` | Its name, as Claude Code chose it (`agent-…` for an agent). |
| `WORKTREE_SLOT` | Its slot, 1 or higher. Slot 0 is left for the main checkout. |
| `PORT_BASE` | The first of its 10 ports. The worktree owns `PORT_BASE` to `PORT_BASE+9`. |
| `REPO_ROOT` | The main checkout, to copy untracked files from. |

A typical script writes ports from `PORT_BASE` into `.env` and installs dependencies. It may take up to 10 minutes. If it fails, the worktree is kept, you get a toast, and the agent works in it anyway.

Slots are recorded in `<git common dir>/claude-worktrees/slots.json`, written under a lock directory beside it so parallel sessions never draw the same slot. A slot is freed when its worktree is removed, or once its folder is gone.

## Relays and dependent agents

When one agent continues another's work, or needs your unmerged work:

1. Work on a feature branch in the main session.
2. Commit before starting agents that need your changes. Uncommitted changes never reach them.
3. Each editing agent commits before it hands back, including a WIP commit when it stops with `CHECKPOINT:`.
4. Between legs, fast-forward your branch to the agent's: `git merge --ff-only worktree-<name>`. Then start the next leg, which branches from there.

## Safety rules

- It never stops a Claude Code process, the Claude process the mod runs in, or a process whose tree holds either. A shell started in the worktree that runs another Claude session is left alone.
- It matches a worktree path with separators and, on Windows, case normalised, and only whole path names: `agent-a1` never matches `agent-a12`.
- It never matches the main checkout. It stops processes only for a worktree being removed, an agent's worktree under `.claude/worktrees/`, or a worktree folder that no longer exists.
- A branch is removed only when all of these hold:
  - It is merged: `gh pr list --state merged --head <branch>` finds a merged PR (squash merges included), or its tip is already in `origin/<default>`.
  - It is not the default branch, `main`, `master`, or checked out in the main checkout or this session.
  - Its worktree has no uncommitted or untracked changes, is not locked (Claude Code locks an agent's worktree while the agent runs), and its agent has stopped. A worktree the mod created counts as in use until its agent stops, or for 24 hours.
  - Every commit on it is on a remote branch, in the merged PR's head, or in `origin/<default>`.
- Worktrees are removed with `git worktree remove`, never `--force`. `git branch -d` comes first; `-D` only for a branch shown merged as above.
- The remote branch is deleted only when everything on it is in the merged PR or in `origin/<default>`. Otherwise it is left and reported.
- The local default branch is fast-forwarded only when it is strictly behind `origin/<default>` and its checkout has no uncommitted changes, with `git merge --ff-only` or, when nothing has it checked out, `git update-ref`.
- Anything skipped is reported with the reason. `/tidy` prints them; at session start they go to the debug log, and the toast counts them.

## Testing

```bash
claude plugin validate plugins/worktrees
claude plugin test plugins/worktrees
```
