# ADR-0001: self-contained plugins that cooperate only through Claude Code and the disk

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

The repo is one marketplace, `claude-ops` (`.claude-plugin/marketplace.json`), with seven plugins under `plugins/<name>/`. A user installs each one on its own (`/plugin install <name>@claude-ops`, root `README.md`, "Install"), so any plugin may run without any other. Several plugins still need to work together: worktrees isolates the agents that foundry and kit start, kit writes the setup script worktrees runs, and foundry's leads delegate to kit's agents.

## Decision

Each plugin is self-contained: its own manifest, hooks module, skills, agents, scripts and tests under `plugins/<name>/`. No plugin imports or reads code from another plugin's directory at run time. The one place shared code is needed, kit copies it instead (ADR-0003).

Plugins cooperate only through these channels:

1. **Agent-type names.** worktrees lists the bare names `scout` and `reviewer` in `READ_ONLY_AGENTS` (`plugins/worktrees/hooks/register.ts`, line 8) and matches `plugin:name` by its bare name (`needsWorktree`). kit's stop-gate template skips `kit:scout|kit:reviewer` (`plugins/kit/skills/init/hooks-reference.md`). foundry's run skill discovers agent types at run time, `kit:builder` among them, and falls back to `general-purpose` when there are none (`plugins/foundry/skills/run/SKILL.md`, section 3).
2. **Files in the project.** kit writes `.claude/worktree-setup.sh|.ps1`; worktrees runs it (ADR-0005). kit writes `.claude/kit/review-checklist.md`; kit's own builder and reviewer read it.
3. **Claude Code events, composed through the middleware chain.** Several plugins handle the same event and each calls `next`: worktrees sets `isolation` on `Agent` calls (`classic.PreToolUse`), subagent-limits appends its context contract to every spawned prompt (`agent.spawn`), foundry gates `Agent` calls and adds a report-path note to the result (`tool.call`).
4. **Skills by name.** foundry's lead loads `subagent-limits:split-work` if it is available (`plugins/foundry/agents/lead.md`, line 36).

Every channel degrades when the other plugin is missing: a name that matches nothing, a file nobody reads, a skill that isn't listed.

## Consequences

- Any plugin installs, updates and versions on its own (ADR-0009).
- Renaming an agent type, a skill or a project file another plugin names is a cross-plugin change, even though no import breaks. Nothing checks those names today except tests that use them as sample data (`plugins/worktrees/tests/logic.test.ts` uses `kit:scout`, `kit:reviewer`, `kit:builder`).
- The handlers that share one event must not rely on running in a given order. Which order Claude Code runs different plugins' handlers in is not pinned anywhere in this repo. TODO: confirm the mod API's ordering across plugins.
- There is no machine-readable contract between plugins yet. foundry learns what kit set up only by listing agent types; it doesn't read `.claude/kit/`. foundry's backlog, "Run 2", plans the first such contract: a manifest kit writes and foundry reads.
