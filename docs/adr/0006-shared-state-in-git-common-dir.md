# ADR-0006: state shared across worktrees lives under the git common dir

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

Agents in different worktrees of one repo, and parallel sessions on it, need one place to write to: foundry's crews each run in their own worktree but share one run, and worktrees must hand out port slots that no two sessions draw twice. A path in the working tree differs per worktree and would show up in `git status`.

## Decision

Both plugins put shared state under `git rev-parse --path-format=absolute --git-common-dir`, which every worktree of a repo shares and git never tracks:

- foundry: `<git common dir>/foundry/<session id>/`, holding `plan.json`, `plan.md`, `decisions.md`, `goals/`, `reports/<crew>/` and `messages.jsonl` (`plugins/foundry/docs/architecture.md`, "On disk"). Outside git it falls back to `$HOME/.claude`.
- worktrees: `<git common dir>/claude-worktrees/slots.json`, written under a lock directory beside it (`plugins/worktrees/hooks/register.ts`, `stateFile`; README, "The `.claude/worktree-setup` contract").

Project configuration that the owner edits and commits stays in the working tree instead: `.claude/foundry.json`, `.claude/worktree-setup.*`, `.claude/kit/`.

## Consequences

- Run state never needs committing and never dirties a checkout; configuration does need committing before crews start, since worktrees see only committed files (`plugins/foundry/skills/init/SKILL.md`, step 4).
- Deleting a clone deletes its run history. Nothing cleans `<git common dir>/foundry/` today.
- `plan.json` and `slots.json` are stored shapes. `plan.json` has a schema, `plugins/foundry/docs/plan.schema.json`; `slots.json` has only the type in `register.ts` (comment "What slots.json holds").
