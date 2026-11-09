---
name: persona
description: Teaches how to write, review or amend a project persona, a project agent type specialised by tech stack and area (for example spring-webflux-backend, nextjs-frontend, postgres-migrations) that carries the checkable standards a senior in that stack holds, plus read-only judges such as product-owner. Use when asked to write, review or amend a persona or project agent for a stack or area, or when kit:init, kit:revise or kit:reviewer need one.
---

# kit persona

A persona is a project agent type, `.claude/agents/<name>.md`, that knows one stack in one area of this repo and holds the standards a senior in that stack would hold. A generic builder copies nearby code and passes review with generic work. A persona makes the bar explicit, so it can be briefed once and checked item by item.

A persona holds **stack invariants** and **pointers to where the truth lives**. It never holds a count, version or command that a script, `CLAUDE.md` or `AGENTS.md` already owns, because those rot.

## 1. Name it

By stack and area, kebab-case: `spring-webflux-backend`, `nextjs-frontend`, `postgres-migrations`, `fastapi-ai-service`. Never by pipeline step (`builder`, `tester`, `fixer`): a step has no stack, so it has no standards.

## 2. The file

Frontmatter:

- `name`: the file name without `.md`.
- `description`: one or two sentences. Name the stack, the directories it owns and when to use it. No example blocks.
- `model`: `opus` for judgment (design-heavy areas, judges), `sonnet` for well-specified work.
- `effort`: `low`, `medium` or `high`.
- `tools`: omit for an editing persona, or list Write and Edit explicitly. A judge or investigate-only persona lists only read tools (`Read, Grep, Glob, Bash`), with no `Write`, `Edit` or `NotebookEdit`. Open its body with "You are read-only: investigate, never edit or write files", and keep the `tools` line as well: the line enforces the rule, the sentence only states it. A persona with no write tool is also what lets kit's manifest mark it read-only.

Body sections, in this order:

1. **Area.** The directories and file kinds it owns. The areas it must not touch (another persona's, generated code, applied migrations).
2. **Stack.** The frameworks and libraries as this repo uses them, each with where it is configured (`pom.xml`, `next.config.*`, `pyproject.toml`). Say which it uses and which it does not (R2DBC, not JPA). No versions.
3. **Standards.** Numbered. Each one is checkable from a diff, stack-idiomatic, and short. See section 3.
4. **Proving it works.** Which project script or doc owns test, lint and run: a pointer, not a copied command. Run tests through the project's wrapper or workspace test script, never a raw tool command, because the wrapper knows things the raw command does not (which worktree is active, which services to start). If the project has tiers of tests, point at the doc that lists them and say which tier proves which kind of change. Then say what evidence to report: the check that ran, its result, the screen or response seen.
5. **Skills.** Skills to load when the session lists them (a design skill for a UI persona, a framework skill for its stack). Say "if listed".
6. **Review checklist.** The Standards restated as anti-patterns a judge can scan for, by area, so a slip is caught twice. Add any fixed-shape check the area needs, such as the table below.

Two optional sections, when they apply:

- **Start from a known-good artifact.** When a format has many hidden rules (a migration, a CI workflow, a Helm chart, a workflow definition), name a working example in the repo and say: clone it and change it step by step, never write it from scratch.
- **Done means.** The evidence the persona must see before it reports done, in order: it ran, the output was checked, the result was rendered or read back. Never "the API said ok".

A fixed-shape check works well because every empty cell is a finding. Example for config:

| var | in code (file:line) | in config | in deploy values | in `.env.example` | secret? |
|---|---|---|---|---|---|

Define severities once if you use one (blocker: breaks at runtime; major: breaks in one environment; minor: docs only).

## 3. Write Standards that a reviewer can rule on

Each Standard names something a reviewer can see in a diff and answer yes or no. "Controllers return `Mono`/`Flux`; never `.block()`" is a Standard. "Write clean, maintainable code" is not.

Use the ecosystem's real practice. These show the range; they are illustrations, not a list to paste. Take only what this repo does, or what it has no habit on yet and the ecosystem settles.

| Ecosystem | Idiomatic, checkable items |
|---|---|
| Maven / Gradle | Dependency versions pinned or managed by a BOM or version catalog, no open ranges; no `SNAPSHOT` in a release build. |
| npm / pnpm / yarn | Caret ranges in `package.json`; the lockfile is committed and changes with it; one package manager. |
| Python | Dependencies added through the project's tool (`uv`, `poetry`, `pip-tools`) so the lockfile changes with the manifest; all I/O in async code is awaited. |
| Go | `go.mod` and `go.sum` tidy after a dependency change; errors wrapped with context, not dropped. |
| Reactive (WebFlux, Reactor, RxJS) | Handlers return the reactive type; nothing blocks inside the pipeline. |
| Data access | One access layer (R2DBC, not JPA, if that is the repo's choice); an applied migration is never edited, a new one is added. |
| Frontend | All API calls go through the one client module; no direct `fetch`; styling through the design system's tokens, not ad-hoc values. |
| Contracts | An API change updates the contract artifact (OpenAPI, Postman collection) in the same commit. |
| AI / prompts | Prompts live in the prompts directory, never inline in code. |

Each Standard should cite what the repo does: the file where the pattern lives, in the Stack or in the item. Where the repo has no habit yet, the ecosystem idiom is fine; say so in the item ("repo has no lockfile yet; the ecosystem commits one").

## 4. Judges

A judge is a read-only persona: tools `Read, Grep, Glob, Bash`, no write tools. It advises; it never decides scope, which is for the human or the orchestrator.

- **`product-owner`.** Propose one for every project. Its body holds: who the users are; the domain rules a generic engineer would get wrong; what "done" means for a user; acceptance checks in the user's terms ("a user can ... and sees ..."), not the code's; and pointers to the requirements doc and the README. It is used for user-facing changes. Model `opus`.
- **An architect reviewer.** Optional. Make it mostly the editing personas' Standards restated as anti-patterns per area, so each slip is caught twice. Do not fill it with generic architecture talk (SOLID, layers, "keep it simple").

## 5. Self-check before saving

A persona earns its place by short, concrete, checkable stack rules. Before you save one, check:

- Every path it names exists now. Open each.
- No counts, versions or line numbers ("27 tables", "~2650 lines", "v10"), and no command that a script or doc owns. Point at the script instead.
- No boilerplate a model already knows: SOLID, DRY, "comprehensive tests", accessibility or performance platitudes, "consider Redux or Zustand".
- No deliverables list of documents nobody reads.
- Every Standard is checkable from a diff.
- Nothing the repo cannot follow: no unit tests with a library the repo has no setup for, no tool it does not use.
- Read-only personas have a `tools` line without write tools.

If an item fails, cut or fix it. A short persona that is all true beats a long one that is half stale.

## 6. Amend

When a path a persona names is gone, or the code contradicts a Standard, amend the persona in the same change that caused it, and cite the evidence (the commit, file or finding). A recurring review finding that a linter cannot catch becomes a Standard and a Review checklist line. Remove a Standard the team has dropped; do not leave it to be ignored.
