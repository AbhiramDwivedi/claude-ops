---
name: init
description: Sets up the current project for Claude Code work from what its code actually does - a conventions section in CLAUDE.md, lint and test quality-gate hooks, a review checklist, and project agents or skills only where the repo clearly needs them. Proposes everything first and writes only after approval. Use when the person runs /kit:init or asks to set up, bootstrap or kit out a project for Claude Code.
---

# kit init

You are setting this project up so that agents working in it follow its real conventions and can't report done with broken lint or tests. Everything you propose must come from this repo's code, not from general best practice. A conventions section that could be pasted into any project is worthless; leave it out.

The kit plugin already ships four agent types with their model pinned: `kit:builder` (Sonnet, implements a brief), `kit:reviewer` (Opus, read-only review against the checklist), `kit:test-writer` (Sonnet, tests from the spec first), `kit:scout` (Haiku, read-only search). Don't recreate them per project.

## 1. Scan

Use `kit:scout` agents or your own searches; read excerpts, not whole trees. Find:

- **Languages and frameworks**, from manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`, `Gemfile`, ...) and file counts.
- **Commands**: package scripts, `Makefile`/`justfile`/`Taskfile` targets, CI workflow steps. Name the exact lint, typecheck, format, test and build commands, and whether each can run on one file. CI is the best evidence of which commands the project really trusts.
- **Services and ports**: `docker-compose*`, `Procfile`, dev scripts that start several processes, hard-coded or env-driven ports.
- **Conventions in use**, each backed by two or more files you can cite: error handling (exceptions vs result types, where errors are logged or wrapped), module and directory layout, naming, how config and secrets are loaded, how tests are organised and what they mock, patterns that recur (repositories, handlers, hooks, DI). Note where the code is inconsistent; say so rather than picking a winner silently.
- **What exists already**: `CLAUDE.md`, `.claude/settings.json`, `.claude/agents|skills|commands`, `.claude/kit/`. You extend these; never discard what is there. If `.claude/kit/` exists, kit has run here before: say so and suggest `/kit:revise` instead, unless the person wants a fresh pass.
- **Checks already in place**: hooks in `.claude/settings.json` or `.claude/hooks/` that already lint, typecheck or test; a gate script; pre-commit tooling (husky, lefthook, pre-commit); CI. A check the project already runs on edit or on stop must not run twice. Propose kit's gates only for what is missing, and say which existing check covers the rest.
- **What a fresh worktree needs before tests pass**: dependency install (pnpm, npm, yarn, uv, poetry, pip), gitignored files the code reads (`.env*`, local config), generated code (Prisma, OpenAPI, protobuf, `.next`), Docker Compose services, a local database, lint/typecheck caches.
- **Tools that scan the whole repo** (`eslint .`, `prettier .`, test runners, file watchers, `tsc` with broad `include`): check that each one's ignore config excludes `.claude/worktrees/`, where agent worktrees live. Otherwise a check run in the main checkout also scans every agent's worktree.

## 2. Propose

Show the person one proposal, grouped by file, with the full text of new files and a diff for changed ones. Include only what the scan supports:

1. **`CLAUDE.md` conventions section.** Short: commands (exact), layout, and the conventions you found, each with a file reference. Under 60 lines; every line loads into every session.
2. **Quality-gate hooks** in `.claude/settings.json` plus small gate scripts in `.claude/kit/`. A lint or typecheck after each edit (PostToolUse on `Edit|Write|MultiEdit`), and the tests before the main agent stops (Stop), and before subagents stop (SubagentStop) when the tests take under about a minute. Use the templates in `hooks-reference.md` in this skill's directory, filled with the commands you found. Merge into existing settings; don't replace other hooks.
3. **If there is no linter or typechecker**, say so first and recommend the standard one for the stack (with its config). It catches more than any agent will, on every edit, for free. Offer to add it; don't add it without a yes.
4. **`.claude/kit/review-checklist.md`**, seeded from the conventions: 5 to 15 checkable items, each specific to this repo ("handlers return `Result`, never throw: see `src/api/users.ts`"), not generic ("code is readable"). Leave out anything the linter already enforces.
5. **Project agents, skills or commands, only where the repo clearly needs one**: a recurring multi-step procedure (release, migration, codegen), a domain that needs a specialist brief. Each with the evidence. Usually the right number is zero; `/kit:revise` adds them later from real use.
6. **`.claude/worktree-setup.sh` and/or `.ps1`, only if a fresh worktree can't run the tests without setup, or the repo runs services that need separate ports.** The `worktrees` plugin runs it in each new worktree with `WORKTREE_PATH`, `WORKTREE_SLOT` and `PORT_BASE` set; slot N owns ports `PORT_BASE` to `PORT_BASE+9`. Use the stub in `hooks-reference.md` and keep only the steps the scan found. The rules behind it: install dependencies per worktree from the shared cache (pnpm store, uv cache), never copy or symlink `node_modules` or a venv (tools resolve the link back to the main checkout; an editable install in a shared venv imports the main checkout's code); copy gitignored config; regenerate generated code rather than copying it; give each slot its own Compose project and database; copy lint/typecheck caches only with a content-based cache strategy. Setup should finish in about 30 seconds, since every editing agent waits for it.
7. **Ignore entries** for `.claude/worktrees/` in any repo-scanning tool's config that lacks one.

End with the list of files you will create or change, and ask whether to write all of it, some of it, or none.

## 3. Write

Write only what the person approved. Then:

- Run each gate script once by hand (pipe it a sample hook input, as in `hooks-reference.md`) and show that it passes on the current tree, or fails for a real reason.
- Make the scripts executable on Unix (`chmod +x`).
- Tell the person what will now happen on edits and on stop, and that `/kit:revise` will suggest changes once there are a few weeks of sessions.

Don't commit unless asked.
