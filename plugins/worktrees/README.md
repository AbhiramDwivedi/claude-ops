# worktrees

Keeps agents from stepping on each other's files, and cleans up after them.

- **Every agent that can edit gets a git worktree.** When an Agent call leaves `isolation` unset and the session is in a git repo, the mod sets `isolation: "worktree"`. Read-only agent types run in the session's checkout: `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `scout`, `reviewer`, plus any you list in `readOnlyAgents`. A call that already chose `worktree` or `remote` is left alone.
- **A project can set each worktree up.** If the repo has `.claude/worktree-setup.ps1` (Windows) or `.claude/worktree-setup.sh` (elsewhere), the mod creates the worktree itself, gives it a port slot, and runs the script in it. See the contract below.
- **What an agent leaves running is stopped.** When an agent that ran in a worktree stops, and when a worktree is removed, the mod stops every process whose command line names that worktree, and anything listening on its slot's ports.
- **Merged work is removed.** In the background at session start, and on demand with `/tidy`, it removes the worktree, local branch and remote branch of every branch whose PR has merged, when nothing would be lost. It also stops processes left behind in worktrees that no longer exist. `/tidy dry-run` shows what it would do and changes nothing.

| Setting | Default | What it does |
| --- | --- | --- |
| `readOnlyAgents` | empty | Comma-separated agent types that never edit, added to the built-in list. |
| `portBase` | 4000 | Slot N owns ports `portBase + N*10` to `portBase + N*10 + 9`. |
| `tidyOnStart` | true | Tidies merged branches in the background when a session starts, at most every 10 minutes per repo. |

## The `.claude/worktree-setup` contract

Commit the script to the repo. The mod runs it once, right after it creates a worktree, with the worktree as the working directory and these variables set:

| Variable | Value |
| --- | --- |
| `WORKTREE_PATH` | The new worktree, absolute. |
| `WORKTREE_NAME` | Its name, as Claude Code chose it (`agent-…` for an agent). |
| `WORKTREE_SLOT` | Its slot, 1 or higher. Slot 0 is left for the main checkout. |
| `PORT_BASE` | The first of its 10 ports. The worktree owns `PORT_BASE` to `PORT_BASE+9`. |
| `REPO_ROOT` | The main checkout, to copy untracked files like `.env` from. |

A typical script copies `.env` from `REPO_ROOT`, writes ports from `PORT_BASE` into it, and installs dependencies. It may take up to 10 minutes. If it fails, the worktree is kept, you get a toast, and the agent works in it anyway.

The mod creates the worktree where Claude Code would: `<repo>/.claude/worktrees/<name>`, on branch `worktree-<name>`, from `origin/HEAD` (or `HEAD` when there is none). Without a setup script it leaves creation to Claude Code. Slots are recorded in `<git common dir>/claude-worktrees/slots.json`. A slot is freed when its worktree is removed, or once its folder is gone.

## Safety rules

- It never stops a Claude Code process, the Claude process the mod runs in, or a process whose tree holds either. A shell started in the worktree that runs another Claude session is left alone.
- It matches a worktree path with separators and, on Windows, case normalised, and only whole path names: `agent-a1` never matches `agent-a12`.
- It never matches the main checkout. It stops processes only for a worktree being removed, an agent's worktree under `.claude/worktrees/`, or a worktree folder that no longer exists.
- A branch is removed only when all of these hold:
  - `gh pr list --state merged --head <branch>` finds a merged PR. Without `gh`, `git branch --merged origin/<default>` decides instead, and `git branch -D` is never used.
  - It is not the default branch, `main`, `master`, or checked out in the main checkout or this session.
  - Its worktree has no uncommitted or untracked changes and is not locked. Claude Code locks an agent's worktree while the agent runs.
  - Every commit on it is on a remote branch or in the merged PR's head.
- Worktrees are removed with `git worktree remove`, never `--force`. `git branch -d` comes first; `-D` only after `gh` confirmed the merge, for squash merges.
- The remote branch is deleted only when everything on it is in the merged PR. Otherwise it is left and reported.
- Anything skipped is reported with the reason. `/tidy` prints them; at session start they go to the debug log, and the toast counts them.

## Testing

```bash
claude plugin validate plugins/worktrees
claude plugin test plugins/worktrees
```
