# ADR-0005: agent worktrees under `.claude/worktrees/`, set up by the project's script

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

Parallel agents that edit one checkout collide. Claude Code can give an agent a worktree (`isolation: "worktree"`), but its default starts from `origin/HEAD` and misses the session's unmerged work (`plugins/worktrees/hooks/register.ts`, comment on `classic.WorktreeCreate`). A fresh worktree also lacks gitignored config, installed dependencies and its own ports.

## Decision

- worktrees adds `isolation: "worktree"` to every `Agent` call whose type can edit, and creates the worktree itself from the HEAD of the checkout the hook runs in: path `<main checkout>/.claude/worktrees/<name>`, branch `worktree-<name>`.
- It copies the gitignored files that `.worktreeinclude` matches, then runs `.claude/worktree-setup.ps1` on Windows or `.claude/worktree-setup.sh` elsewhere, with the worktree as the working directory and `WORKTREE_PATH`, `WORKTREE_NAME`, `WORKTREE_SLOT`, `PORT_BASE` and `REPO_ROOT` set. Slot N owns ports `portBase + N*10` to `+9`; slot 0 is left for the main checkout (`plugins/worktrees/README.md`, "The `.claude/worktree-setup` contract").
- kit's `/kit:init` writes that script when a fresh worktree can't run the tests, from the stub in `plugins/kit/skills/init/hooks-reference.md`, and adds `.claude/worktrees/` to `.gitignore` and to repo-wide tools' ignore lists.

## Consequences

- The path `.claude/worktrees/` is a seam several modules rely on: kit's init (ignore entries) and `kit_mine.py` (it mines worktree sessions too), workflow-audit's project-name mapping (`CONTRACT.md`, metrics version 3), and foundry's tests (`cwd: 'C:/r/.claude/worktrees/x'`). Moving it touches all of them.
- The setup-script variables are a contract between kit, which writes scripts, and worktrees, which runs them. Adding a variable is safe; renaming one breaks every script already written into user projects.
- foundry's architect proposes a per-crew "resource slice (port range, database or temp directory)" in `plan.md`. Nothing ties that range to worktrees' slots, so the two can overlap. Not decided yet; foundry's backlog, "Run 2", lists port slices as a kit-manifest field.
