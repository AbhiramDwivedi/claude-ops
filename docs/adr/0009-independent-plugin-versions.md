# ADR-0009: each plugin carries its own semver version, and every shipped change moves it

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

The marketplace lists seven plugins that install separately (ADR-0001). Users on marketplace auto-update get a change only when the plugin's version moves (`scripts/catalog-refresh/run.sh`: "Users on marketplace auto-update only get the new catalog if the plugin version moves").

## Decision

- The version lives in each plugin's `.claude-plugin/plugin.json` and moves on its own. At this commit: foundry 0.3.0, kit 0.1.1, session-models 0.7.0, subagent-limits 0.3.1, usage-limits 0.3.0, workflow-audit 0.2.2, worktrees 0.5.0. `marketplace.json` lists sources, not versions.
- Versions follow `major.minor.patch`. Commits name the version they ship (`kit 0.1.1: ...`, `foundry: README and version for 0.3.0`). The catalog refresh bumps the patch number on its own.
- A renamed user setting keeps the old name working, marked deprecated, as worktrees does with `readOnlyAgents` beside `noIsolateAgents`.

## Consequences

- A change that spans plugins (ADR-0003's parser copy, a renamed agent type) needs a bump in each plugin it touches.
- There is no changelog file; the version history is the commit log and each plugin's README.
- All plugins are below 1.0, so semver itself promises nothing about breaking changes yet. Which changes count as breaking (a renamed agent, skill, command, setting or project-file contract) is set in the architecture doc's principles, not here.
