# worktrees

Keeps agents from stepping on each other's files, and cleans up after them.

- **Every agent that can edit gets a git worktree.** When an Agent call leaves `isolation` unset and the session is in a git repo, the mod sets `isolation: "worktree"`. Read-only agent types run in the session's checkout: `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `scout`, `reviewer` (also with a plugin prefix, such as `kit:scout`), plus any you list in `noIsolateAgents`, plus any that kit's manifest declares read-only. A call that already chose `worktree` or `remote` is left alone.
- **A plugin can declare its own agents read-only through kit.** On each Agent call that would get a worktree, the mod reads `.claude/kit/manifest.json` in the main checkout and skips the worktree for every agent listed there with `readOnly: true` ([ADR-0014](../../docs/adr/0014-worktrees-declared-read-only-agents.md)). The name must match in full, ignoring ASCII case: a declared `foundry:judge` covers `foundry:judge`, not `judge` or `other:judge`. The manifest only adds to the list; `readOnly: false` takes nothing out of it. A missing manifest changes nothing, and one the mod can't read or parse is ignored, with a line in the debug log. The mod ignores a manifest entry that declares one of these editing types read-only: `general-purpose`, `kit:builder`, `kit:test-writer`, `foundry:architect`, `foundry:devops`, `foundry:lead`, `foundry:writer`. Their calls still get a worktree, and each Agent call that reads such a manifest writes `worktrees: kit manifest declares editing types read-only, ignoring them: <names>` to the debug log. Your own `noIsolateAgents` can still list any type (0.7.0). Without kit, list the types yourself in `noIsolateAgents`, such as `foundry:judge,foundry:cynic`.
- **A workspace of nested repos keeps its agents in the main checkout.** When the repo's ignored directories hold their own git repos (a workspace with service repos checked out inside it, each in `.gitignore`), a worktree of the outer repo would contain none of their code. Unless the repo has a setup script, the mod then leaves `isolation` unset and shows one toast per session saying why. See [Workspaces of nested repos](#workspaces-of-nested-repos).
- **The worktree starts from your current commit.** Claude Code's default worktree starts from `origin/HEAD`, so an agent never sees your unmerged branch. The mod creates every worktree itself, from the HEAD of the checkout the session works in (a detached HEAD too).
- **A project can set each worktree up.** Gitignored files listed in `.worktreeinclude` are copied in from the main checkout. If the repo has `.claude/worktree-setup.ps1` (Windows) or `.claude/worktree-setup.sh` (elsewhere), the mod gives the worktree a port slot and runs the script in it. See the contract below.
- **What an agent leaves running is stopped.** When an agent that ran in a worktree stops, and when a worktree is removed, the mod stops every process whose command line names that worktree, and anything listening on its slot's ports.
- **An agent can't finish while its background work runs.** When an agent stops with a background shell or Monitor it started still running, the mod refuses the stop and tells it to end each one with TaskStop, or to say why it should outlive the agent. The agent's report is already delivered by then. A task counts as the agent's when its id appears in the agent's transcript. The agent's second stop always goes through, and the mod cleans up only after a stop it allows.
- **Agents commit their work.** Work moves between worktrees only once it is committed. An agent that starts in a worktree is told its branch and asked to commit on it before it finishes. An agent that stops with uncommitted changes (tracked edits, or untracked files `.gitignore` doesn't cover) is sent back once to commit them, in the same message as any background work. If its second stop still leaves changes, the mod commits them for it with `git add -A` and `git commit --no-verify -m "WIP: uncommitted changes left by <type> <id>"`, logs it and shows a toast. `--no-verify` is there so a failing pre-commit hook can't leave the work behind; review the WIP commit before merging it. The mod commits only in an agent's worktree, never in your checkout.
- **The main session is told to merge.** At session start the main thread hears that agents work on `worktree-*` branches, that it should review and merge one (`git merge --ff-only` for a relay leg) before relying on it, and that it should leave other worktrees alone.
- **A merge cleans up the agents' worktrees, even after a restart.** After a Bash or PowerShell command with the word `merge` in it (`git merge`, `gh pr merge`), the mod sweeps in the background every worktree at `<main checkout>/.claude/worktrees/agent-<id>` that `git worktree list` shows. That covers native `isolation: "worktree"` agents and the ones this mod isolates, and it doesn't depend on what the session remembers, so worktrees left by an earlier or crashed session are swept too. Worktrees under other names (`claude --worktree <name>`) are `/tidy`'s. It removes one when all of these hold:
  - it is on a `worktree-*` branch and not locked;
  - its agent isn't live. An agent counts as live for 24 hours after its worktree was made, unless its meta file (`<session dir>/subagents/agent-<id>.meta.json`, found from the event's `transcript_path`) says `"finished": true`, which retires it at once. A missing or unreadable meta leaves the agent live;
  - `git status --porcelain` is empty;
  - its branch is merged into the HEAD of the checkout the merge ran in, or into the HEAD of the main checkout (a local ref, never `origin/...`). Merged means, in this order: an ancestor of it; `git merge-tree --write-tree HEAD <branch>` gives HEAD's own tree; or `git cherry HEAD <branch>` prints only `-` lines (every commit has a patch-equivalent in HEAD, which a squash or rebase leaves). The cherry check runs only for a worktree that is otherwise ready to go.

  It stops the worktree's processes and frees its slot, removes the worktree, then deletes its branch: `git branch -d` after an ancestor, `-D` after the tree or cherry check, since `-d` refuses those and the content is already in HEAD. A toast names what it removed. One write of `slots.json` then drops the `active` entries whose agent finished, whose folder is gone and unregistered, or that are 24 hours old. The sweep never fetches, pulls, pushes or merges, and never touches a remote branch.

  A merged worktree with uncommitted changes, or locked, is kept and reported: a debug-log line `worktrees: self-clean kept <path>: uncommitted changes` or `...: locked (<reason>)`, and one toast per sweep naming each kept path. Nothing is forced.

  The `isolation skipped` and `isolating` lines this mod writes also go to the debug log, which shows only with Claude Code's debug logging on.
- **`/tidy` cleans up everything else, on demand.** It removes the worktree, local branch and remote branch of every merged branch, when nothing would be lost. It fast-forwards a stale local default branch, and stops processes left in worktrees that no longer exist. It names every branch it deleted, and every agent branch nobody merged, as `unmerged agent work: <branch> (<n> commits)`; those are never deleted. `/tidy dry-run` shows what it would do and changes nothing. Nothing runs it at session start.

| Setting | Default | What it does |
| --- | --- | --- |
| `noIsolateAgents` | empty | Comma-separated agent types that never get a worktree, added to the built-in read-only list and to the types kit's manifest declares (`.claude/kit/manifest.json`, `readOnly: true`). Without kit, this is where `foundry:judge,foundry:cynic` go. |
| `readOnlyAgents` | empty | Deprecated name for `noIsolateAgents`. Still read; the types in both are used. |
| `isolateNestedRepos` | false | Give agents worktrees even in a repo with ignored nested repos and no setup script. |
| `portBase` | 4000 | Slot N owns ports `portBase + N*10` to `portBase + N*10 + 9`. |

A worktree confines where an agent's Edit and Write calls land by default. The mod does not confine Bash: an agent's commands run wherever they `cd` to. Claude Code itself may refuse some commands it can't confirm stay inside the worktree, but don't count on that either way.

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

## Workspaces of nested repos

The mod looks for nested repos once per session: `git ls-files --others --ignored --exclude-standard --directory` lists the ignored directories, and each one with a `.git` entry counts. For a listed directory that is no repo itself, its subdirectories are checked too, one level down: with `services/` ignored as a whole, `services/a/.git` counts. A repo two or more levels below an ignored directory is not seen. At most 200 ignored directories, and 200 subdirectories of each, are checked.

When it finds some, what happens depends on the repo:

- **No setup script**: agents run in the main checkout, and a toast names the nested repos. This is the safe default; an agent in a worktree of the outer repo would find none of the code it was asked to change.
- **A setup script for this platform** (`.claude/worktree-setup.sh`, or `.ps1` on Windows): agents get worktrees as usual. The script is expected to make a worktree of each nested repo inside the new one.
- **`isolateNestedRepos` set**: agents get worktrees whatever the repo holds, and the check doesn't run.

A setup script that gives each nested repo its own worktree on a branch named after the outer one:

```bash
#!/usr/bin/env bash
# .claude/worktree-setup.sh: one worktree per nested repo, inside the agent's worktree
set -euo pipefail
for git_dir in "$REPO_ROOT"/*/.git; do
  repo="$(dirname "$git_dir")"
  name="$(basename "$repo")"
  # only nested repos the outer repo ignores
  git -C "$REPO_ROOT" check-ignore -q "$name" || continue
  git -C "$repo" worktree add -b "worktree-$WORKTREE_NAME" "$WORKTREE_PATH/$name" HEAD
done
```

The mod's commit, merge and cleanup rules see only the outer repo. The agent's commits in a nested worktree, its `worktree-<name>` branch there and the nested worktree's registration are yours to merge and remove: `git -C <nested repo> worktree prune` after the outer worktree is gone, then delete the branch once it is merged.

## Relays and dependent agents

When one agent continues another's work, or needs your unmerged work:

1. Work on a feature branch in the main session.
2. Commit before starting agents that need your changes. Uncommitted changes never reach them.
3. Each editing agent commits before it hands back, including a WIP commit when it stops with `CHECKPOINT:`. The mod sees to this; see above.
4. Between legs, fast-forward your branch to the agent's: `git merge --ff-only worktree-<name>`. Then start the next leg, which branches from there.

## Safety rules

- It never stops a Claude Code process, the Claude process the mod runs in, or a process whose tree holds either. A shell started in the worktree that runs another Claude session is left alone.
- It matches a worktree path with separators and, on Windows, case normalised, and only whole path names: `agent-a1` never matches `agent-a12`.
- It never matches the main checkout. It stops processes only for a worktree being removed, an agent's worktree under `.claude/worktrees/`, or a worktree folder that no longer exists.
- A branch is removed only when all of these hold:
  - It is merged: `gh pr list --state merged --head <branch>` finds a merged PR (squash merges included). Other branches need the PR, since one you just made with `git branch foo` sits in `origin/<default>` too. A `worktree-*` branch also counts as merged, checked in this order:
    1. its tip is in `origin/<default>`;
    2. merging it would change nothing: `git merge-tree --write-tree origin/<default> <branch>` gives `origin/<default>`'s own tree. This catches squash, cherry-pick and rebase. A conflict, or a different tree, means not merged;
    3. only when check 2 can't run (git before 2.38): its tip is in the head commit of one of the last 100 merged PRs, as when its feature branch was squash-merged. Heads missing locally are skipped.
  - It is not the default branch, `main`, `master`, or checked out in the main checkout or this session.
  - Its worktree has no uncommitted or untracked changes, is not locked (Claude Code locks an agent's worktree while the agent runs), and its agent has stopped. A worktree the mod created counts as in use until its agent stops, or for 24 hours.
  - Every commit on it is on a remote branch, in the merged PR's head, or in `origin/<default>`.
- Worktrees are removed with `git worktree remove`, never `--force`. In `/tidy`, `git branch -d` comes first; `-D` only for a branch shown merged as above. The cleanup after a merge uses `-d` after an ancestor and `-D` only after the tree or cherry check.
- On Windows, `git worktree remove` runs with `-c core.longpaths=true`. Without it, an ignored path past 260 characters (deep `node_modules`) makes the remove fail with `Filename too long` or `Directory not empty`, after git has already unregistered the worktree and deleted its tracked files. If a remove still fails and git no longer lists the worktree, what is left is ignored files git was deleting: the mod deletes the folder (`rd /s /q "\\?\<path>"` on Windows, `rm -rf` elsewhere), runs `git worktree prune`, and notes it in the debug log. If git still lists the worktree, the failure is reported and nothing is deleted.
- The remote branch is deleted only when everything on it is in the merged PR or in `origin/<default>`. Otherwise it is left and reported.
- The local default branch is fast-forwarded only when it is strictly behind `origin/<default>` and its checkout has no uncommitted changes, with `git merge --ff-only` or, when nothing has it checked out, `git update-ref`.
- Anything skipped is reported with the reason. `/tidy` prints them; the cleanup after a merge writes them to the debug log.

## Testing

```bash
claude plugin validate plugins/worktrees
claude plugin test plugins/worktrees
```
