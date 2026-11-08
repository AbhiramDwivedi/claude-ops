# worktrees

Keeps agents from stepping on each other's files, and cleans up after them.

- **Every agent that can edit gets a git worktree.** When an Agent call leaves `isolation` unset and the session is in a git repo, the mod sets `isolation: "worktree"`. Read-only agent types run in the session's checkout: `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `scout`, `reviewer` (also with a plugin prefix, such as `kit:scout`), plus any you list in `noIsolateAgents`, plus any that kit's manifest declares read-only. A call that already chose `worktree` or `remote` is left alone.
- **A plugin can declare its own agents read-only through kit.** On each Agent call that would get a worktree, the mod reads `.claude/kit/manifest.json` in the main checkout and skips the worktree for every agent listed there with `readOnly: true` ([ADR-0014](../../docs/adr/0014-worktrees-declared-read-only-agents.md)). The name must match in full, ignoring ASCII case: a declared `foundry:judge` covers `foundry:judge`, not `judge` or `other:judge`. The manifest only adds to the list; `readOnly: false` takes nothing out of it. A missing manifest changes nothing, and one the mod can't read or parse is ignored, with a line in the debug log. The mod ignores a manifest entry that declares one of these editing types read-only: `general-purpose`, `kit:builder`, `kit:test-writer`, `foundry:architect`, `foundry:devops`, `foundry:lead`, `foundry:writer`, `truss:foreman`, `truss:design-engineer`, `truss:commissioning-engineer`, `truss:planning-engineer`, `truss:writer`. Their calls still get a worktree, and each Agent call that reads such a manifest writes `worktrees: kit manifest declares editing types read-only, ignoring them: <names>` to the debug log. Your own `noIsolateAgents` can still list any type (0.7.0). Without kit, list the types yourself in `noIsolateAgents`, such as `foundry:judge,foundry:cynic`.
- **A workspace of nested repos keeps its agents in the main checkout.** When the repo's ignored directories hold their own git repos (a workspace with service repos checked out inside it, each in `.gitignore`), a worktree of the outer repo would contain none of their code. Unless the repo has a setup script, the mod then leaves `isolation` unset and shows one toast per session saying why. See [Workspaces of nested repos](#workspaces-of-nested-repos).
- **The worktree starts from your current commit.** Claude Code's default worktree starts from `origin/HEAD`, so an agent never sees your unmerged branch. The mod creates every worktree itself, from the HEAD of the checkout the session works in (a detached HEAD too).
- **A project can set each worktree up.** Gitignored files listed in `.worktreeinclude` are copied in from the main checkout. If the repo has `.claude/worktree-setup.ps1` (Windows) or `.claude/worktree-setup.sh` (elsewhere), the mod gives the worktree a port slot and runs the script in it. See the contract below.
- **It stops only what it started.** When an agent that ran in a worktree stops, and when a worktree is removed, the mod stops the processes the worktree's setup script declared in `WORKTREE_PIDFILE` (see the contract below), and no others. From 0.10.0 it never lists, scans or matches the host's processes (no `ps`, `lsof`, `/proc`, `netstat` or port lookup): such a scan could hit another Claude session's children. An agent's own background shells and monitors are the Claude session's to stop with TaskStop, which the next point asks the agent to do.
- **An agent can't finish while its background work runs.** When an agent stops with a background shell or Monitor it started still running, the mod refuses the stop and tells it to end each one with TaskStop, or to say why it should outlive the agent. The agent's report is already delivered by then. A task counts as the agent's when its id appears in the agent's transcript. The agent's second stop always goes through, and the mod cleans up only after a stop it allows.
- **Agents commit their work.** Work moves between worktrees only once it is committed. An agent that starts in a worktree is told its branch and asked to commit on it before it finishes. An agent that stops with uncommitted changes (tracked edits, or untracked files `.gitignore` doesn't cover) is sent back once to commit them, in the same message as any background work. If its second stop still leaves changes, the mod commits them for it with `git add -A` and `git commit --no-verify -m "WIP: uncommitted changes left by <type> <id>"`, logs it and shows a toast. `--no-verify` is there so a failing pre-commit hook can't leave the work behind; review the WIP commit before merging it. The mod commits only in an agent's worktree, never in your checkout.
- **The main session is told to merge.** At session start the main thread hears that agents work on `worktree-*` branches, that it should review and merge one (`git merge --ff-only` for a relay leg) before relying on it, and that it should leave other worktrees alone.
- **A merge cleans up the agents' worktrees, even after a restart.** After a Bash or PowerShell command that runs `git merge` (the subcommand itself, after any `-C <dir>` or `-c k=v` options; `git merge-base`, `gh pr merge` and the word `merge` in a commit message or heredoc don't count), the mod sweeps in the background every worktree at `<main checkout>/.claude/worktrees/agent-<id>` or `.claude/worktrees/wf_<run>-<n>` that `git worktree list` shows. That covers native `isolation: "worktree"` agents, the ones this mod isolates and, from 0.8.4, the Workflow tool's agents, and it doesn't depend on what the session remembers, so worktrees left by an earlier or crashed session are swept too. Worktrees under other names (`claude --worktree <name>`) are `/tidy`'s. It removes one when all of these hold:
  - it is on a `worktree-*` branch and not locked;
  - its agent isn't live. An agent counts as live for 24 hours after its worktree was made, unless its meta file (`<session dir>/subagents/agent-<id>.meta.json`, found from the event's `transcript_path`) says `"finished": true`, which retires it at once. A missing or unreadable meta leaves the agent live. A lead is also live while any of its members is: another meta in that directory has `parentAgentId` equal to the lead's id and no `"finished": true`, whatever the lead's own meta says. If the directory can't be listed, there is no `transcript_path`, or any meta there doesn't parse, every candidate is kept; a Workflow agent's `wf_<run>-<n>` worktree counts as live for the same 24 hours unless its run file (`<session dir>/workflows/<run>.json`, in this session or another of the project's) has an end `status` such as `completed` or `failed`;
  - `git status --porcelain` is empty;
  - its branch is merged into the HEAD of the main checkout (a local ref, never `origin/...`). No agent worktree's HEAD counts, not even the crew's lead, so a member merged only into its lead's branch is kept, with the debug line `worktrees: self-clean kept <path>: <branch> is not in the main checkout's HEAD yet`, until the lead's branch reaches main (`git merge --ff-only <crew branch>`) and the next sweep runs. Merged means, in this order: an ancestor of it; `git merge-tree --write-tree HEAD <branch>` gives HEAD's own tree; or `git cherry HEAD <branch>` prints only `-` lines (every commit has a patch-equivalent in HEAD, which a squash or rebase leaves). The cherry check runs only for a worktree that is otherwise ready to go.

  It stops the processes the worktree's setup script recorded and frees its slot, removes the worktree, then deletes its branch: `git branch -d` after an ancestor, `-D` after the tree or cherry check, since `-d` refuses those and the content is already in HEAD. The tree and cherry checks earn nothing while the main checkout is itself on a `worktree-*` branch. The sweep keeps everything while the main checkout is on no branch (a detached HEAD, or one it can't read). A branch delete that git refuses is logged and named in the toast. A toast names what it removed. One write of `slots.json` then drops the `active` entries whose agent finished, whose folder is gone and unregistered, or that are 24 hours old. The sweep never fetches, pulls, pushes or merges, and never touches a remote branch.

  A merged worktree with uncommitted changes, or locked, is kept and reported: a debug-log line `worktrees: self-clean kept <path>: uncommitted changes` or `...: locked (<reason>)`, and one toast per sweep naming each kept path. Nothing is forced. A dirty or locked worktree is reported as kept only when its branch is merged, because "kept" means the sweep would have removed it; an unmerged worktree is not removed anyway, so it is not reported.

  The `isolation skipped` and `isolating` lines this mod writes also go to the debug log, which shows only with Claude Code's debug logging on.
- **`/tidy` cleans up everything else, on demand.** It removes the worktree, local branch and remote branch of every merged branch, when nothing would be lost. It fast-forwards a stale local default branch, and releases the slots of worktrees that no longer exist. From 0.10.0 `/tidy` touches no process: it looks only at worktrees and branches, and names the recorded setup pids of a worktree it removed as `left running: …`. It names every branch it deleted, and every agent branch nobody merged, as `unmerged agent work: <branch> (<n> commits)`, with `; <k> of <n> lines it adds are not in the default branch` when the line check below ran; those are never deleted. From 0.8.5, a branch deleted on weaker evidence than a merged PR or an agent tip in `origin/<default>` (the reflog rule, and checks 3 and 5 below) keeps its tip at `refs/tidy-archive/<branch>`, and the report says once how to use them: `git for-each-ref refs/tidy-archive` lists them, `git branch <name> refs/tidy-archive/<name>` restores one, `git update-ref -d refs/tidy-archive/<name>` drops one. From 0.9.0 it also clears two kinds of agent branch it used to leave forever (checks 6 and 7 below). One whose tip is kept under an archive ref is reported as `removed <branch>: tip archived at <ref>`. One that is superseded, an old version of files the default branch rewrote since, has its tip saved at `refs/archive/tidy/<YYYY-MM-DD>/<branch>` (the date of the run) before the delete, and is reported as `archived+removed <branch>: superseded (<missing>/<total> lines, last commit <date>)`. The report then says once how to list (`git for-each-ref refs/archive/tidy`), restore and drop those refs. `/tidy dry-run` shows what it would do and changes nothing. Nothing runs it at session start.

| Setting | Default | What it does |
| --- | --- | --- |
| `noIsolateAgents` | empty | Comma-separated agent types that never get a worktree, added to the built-in read-only list and to the types kit's manifest declares (`.claude/kit/manifest.json`, `readOnly: true`). Without kit, this is where `foundry:judge,foundry:cynic` go. |
| `readOnlyAgents` | empty | Deprecated name for `noIsolateAgents`. Still read; the types in both are used. |
| `isolateNestedRepos` | false | Give agents worktrees even in a repo with ignored nested repos and no setup script. |
| `portBase` | 4000 | Slot N owns ports `portBase + N*10` to `portBase + N*10 + 9`. |
| `tidySuperseded` | true | Let `/tidy` archive and delete superseded agent branches (check 7). |
| `tidySupersededDays` | 3 | Days since a branch's last commit before check 7 may call it superseded. |
| `tidyArchiveRefs` | `refs/truss/archive/,refs/archive/` | Comma-separated ref prefixes for check 6. |

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
| `WORKTREE_PIDFILE` | A file to name, one pid a line, each process the script leaves running (a dev server, a watcher). These are the only processes the mod ever stops: when the worktree's agent stops, and when the worktree is removed. On Windows it runs `taskkill /T /F /PID <pid>`; elsewhere `kill -TERM` to the pid and its process group, then `-KILL` after 1.5 seconds. |

A typical script writes ports from `PORT_BASE` into `.env` and installs dependencies. One that starts a server in the background writes its pid: `npm run dev & echo $! >> "$WORKTREE_PIDFILE"` (in PowerShell, `(Start-Process npm 'run dev' -PassThru).Id | Add-Content $env:WORKTREE_PIDFILE`). The mod reads the file once the script ends and keeps the pids in `slots.json` under `spawned`. It may take up to 10 minutes. If it fails, the worktree is kept, you get a toast, and the agent works in it anyway.

Slots are recorded in `<git common dir>/claude-worktrees/slots.json`, written under a lock directory beside it so parallel sessions never draw the same slot. A slot is freed when its worktree is removed, or once its folder is gone. A `slots.json` that does not parse is never overwritten: slots, self-clean and `/tidy` pause and a toast says so, and the fix is to repair the file, or delete it once no agents are running.

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

- It stops only pids its own setup script recorded, never a process it found by looking. It never runs `ps`, `lsof`, `ss`, `netstat`, `Get-CimInstance Win32_Process` or `Get-NetTCPConnection`, and never reads `/proc`. A recorded pid is forgotten once it is stopped.
- It never acts for the main checkout. It stops recorded processes only for a worktree being removed, or an agent's worktree under `.claude/worktrees/` when the agent stops.
- A branch is removed only when all of these hold:
  - It is merged: `gh pr list --state merged --head <branch>` finds a merged PR (squash merges included). Another branch whose tip is in `origin/<default>` counts as merged only when `git reflog show <branch>` has an entry starting `commit`, `merge`, `cherry-pick`, `rebase`, `am` or `pull`: one you just made with `git branch foo` sits in `origin/<default>` too, but its reflog holds only its creation (and maybe a reset or rename), so it is kept as a bookmark. A `worktree-*` branch also counts as merged, checked in this order:
    1. its tip is in `origin/<default>`;
    2. merging it would change nothing: `git merge-tree --write-tree origin/<default> <branch>` gives `origin/<default>`'s own tree. This catches squash, cherry-pick and rebase;
    3. on a conflict or a different tree: every line it adds since its merge base (8 characters or more, trimmed) is a whole line of `origin/<default>`'s version of the same file, as when the default branch took the work and edited it later. A file the default branch lacks at that path counts as not there; binary files are left out; a diff of more than 200 files or 5000 added lines is not checked and stays not merged. Otherwise it is not merged, and the reason says how many lines are missing;
    4. only when check 2 can't run (git before 2.38): its tip is in the head commit of one of the last 100 merged PRs, as when its feature branch was squash-merged. Heads missing locally are skipped;
    5. its tip is strictly inside another local branch's tip, as a Workflow relay leg merged into the next leg or a crew member merged into its crew branch: deleting it loses nothing, even while that branch is unmerged. Branches with the same tip don't count.
    6. its tip is in the history of a ref under one of the `tidyArchiveRefs` prefixes (by default `refs/truss/archive/` and `refs/archive/`): the work is kept there. Only `worktree-*` branches count; a branch of your own is never deleted for this.
    7. it is superseded: merging it would change files (check 2), and all of these hold: its last commit is at least `tidySupersededDays` old; every file it touches since its merge base has commits on `origin/<default>` after that merge base; and every file it added is in `origin/<default>`. The line count of check 3 goes in the report; it doesn't decide (when the diff is over check 3's caps it is counted again up to 2000 files and 250000 lines, or reported as `lines not counted`). Its tip is saved at `refs/archive/tidy/<YYYY-MM-DD>/<branch>` first; if that fails, the branch stays. A branch too recent, or with a file the default branch never changed or doesn't have, stays not merged, as before.
  - It is not the default branch, `main`, `master`, or checked out in the main checkout or this session.
  - Its worktree has no uncommitted or untracked changes (the reason names how many and the first), is not locked (Claude Code locks an agent's worktree while the agent runs), and its agent has stopped. A worktree the mod created counts as in use until its agent stops, or for 24 hours. From 0.9.0, an untracked symlink that leads into the main checkout, and not into the worktree itself (a `ui/node_modules` link a setup made, which an ignore line `node_modules/` doesn't match), is not counted as a change: `/tidy` unlinks it, the link only, before `git worktree remove`, and the report names it. Any other untracked file still keeps the worktree.
  - Every commit on it is on a remote branch, in the merged PR's head, or in `origin/<default>`, unless check 2, 3, 5, 6 or 7 showed nothing would be lost.
- Worktrees are removed with `git worktree remove`, never `--force`. In `/tidy`, `git branch -d` comes first; `-D` only for a branch shown merged as above. The cleanup after a merge uses `-d` after an ancestor and `-D` only after the tree or cherry check against the main checkout's HEAD.
- On Windows, `git worktree remove` runs with `-c core.longpaths=true`. Without it, an ignored path past 260 characters (deep `node_modules`) makes the remove fail with `Filename too long` or `Directory not empty`, after git has already unregistered the worktree and deleted its tracked files. If a remove still fails and git no longer lists the worktree, what is left is ignored files git was deleting: the mod deletes the folder (`rd /s /q "\\?\<path>"` on Windows, `rm -rf` elsewhere), runs `git worktree prune`, and notes it in the debug log. If git still lists the worktree, the failure is reported and nothing is deleted.
- The remote branch is deleted only when everything on it is in the merged PR or in `origin/<default>`, in the local branch whose content checks 2 or 3 found merged, or in the branch that contains it (check 5), in the archive ref (check 6), or in the tip check 7 archived. Otherwise it is left and reported.
- The local default branch is fast-forwarded only when it is strictly behind `origin/<default>` and its checkout has no uncommitted changes, with `git merge --ff-only` or, when nothing has it checked out, `git update-ref`.
- Anything skipped is reported with the reason. `/tidy` prints them; the cleanup after a merge writes them to the debug log.

## Testing

```bash
claude plugin validate plugins/worktrees
claude plugin test plugins/worktrees
```
