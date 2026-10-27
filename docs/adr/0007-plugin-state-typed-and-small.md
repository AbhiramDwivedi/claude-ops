# ADR-0007: mod memory by default; only small, typed slots in plugin state

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

A mod's module is reloaded on save during development and on update. Module variables don't survive a reload; Claude Code's plugin state (`$.state`, or an `atom`) does.

## Decision

- Mods keep their working state in module memory and accept that a reload or `/clear` starts it over. The READMEs say so: the agent counts "survive a mod reload but not a restart"; subagent-limits "keeps its counts inside the mod, so a reload starts them over" (root `README.md`, "Limitations").
- A value goes into plugin state only when losing it on reload would do harm, and its shape is declared by augmenting `PluginState` in the plugin's `types/index.d.ts`:
  - foundry: `foundry.limitReset`, `{ resetsAt: string; fired: boolean }`, so a reload doesn't lose or repeat the limit-reset wake;
  - session-models: `'session-models'.agents`, `Record<string, AgentSeen>` (model, context, effort), through `atom({ plugin: 'session-models', key: 'agents' })`.
- Readers treat what they find as possibly stale or from an older version: `AgentSeen.model` is "absent in state from before 0.5.0"; foundry treats unreadable state as "no".

## Consequences

- These two types are stored shapes: a field change must keep reading the old shape, as `AgentSeen` does.
- worktrees, subagent-limits and usage-limits keep nothing in plugin state; anything that must outlive the session goes to disk instead (ADR-0006).
