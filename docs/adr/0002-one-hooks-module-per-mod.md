# ADR-0002: one dependency-free hooks module per mod, with pure decisions exported

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

Five plugins are mods on Claude Code's mod API: usage-limits, session-models, subagent-limits, worktrees and foundry. The API is early access and can change between releases (root `README.md`, "Install"). The mods run inside the user's Claude Code process, are reloaded on save during development, and are tested with `claude plugin test`.

## Decision

- Each mod has exactly one hooks module: `hooks/hooks.json` is `{ "modules": ["./register.ts"] }` (or `register.tsx` for the two that render a line above the prompt), and the module exports `register: Register`.
- The module imports only from `claude-code` (types, and `atom`/`read`/`update` in session-models) and its own `types/` declarations. No npm dependencies, no `package.json`.
- Configuration arrives through the `options` that `register` receives, from the plugin's `userConfig` in `plugin.json`. No module reads `process.env`.
- Decisions are pure functions exported from the module, apart from the handlers that gather facts through `$` and act on them. worktrees states it at the top of the file ("Pure logic: every decision the hooks make, kept apart from the commands that gather facts and act on them"); foundry, subagent-limits, usage-limits and session-models export their decision and formatting functions the same way. Tests import those functions directly (`tests/logic.test.ts`, `tests/format.test.ts`, `tests/v021.test.ts`) and drive the handlers through `claude-code/testing`'s mock engine (`tests/hooks.test.ts`, `tests/render.test.tsx`).
- Each module's `tsconfig.json` extends the types Claude Code lays into `.claude-plugin/types/` at load, which git ignores.

## Consequences

- A mod has nothing to install, so the marketplace install is the whole setup.
- The exported functions are the module's test seam, not a public API: no other plugin imports them (ADR-0001).
- One module per mod makes each `register.ts` large (foundry 1286 lines, worktrees 1405). Splitting it would mean adding modules to `hooks.json`, which no mod has done yet.
- A change to the mod API reaches every mod at once. There is no shared adapter to absorb it, by choice of ADR-0001.
