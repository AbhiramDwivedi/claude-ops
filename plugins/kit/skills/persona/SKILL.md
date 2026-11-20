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

Use the ecosystem's real practice. These show the range; they are illustrations, not a list to paste.

| Ecosystem | Idiomatic, checkable items |
|---|---|
| Maven / Gradle | Dependency versions pinned or managed by a BOM or version catalog, no open ranges; no `SNAPSHOT` in a release build. |
| npm / pnpm / yarn | Caret ranges in `package.json`; the lockfile is committed and changes with it; one package manager. |
| Python | Dependencies added through the project's tool (`uv`, `poetry`, `pip-tools`) so the lockfile changes with the manifest; all I/O in async code is awaited. |
| Go | `go.mod` and `go.sum` tidy after a dependency change; errors wrapped with context, not dropped. |
| Spring Boot (JVM) | Controllers depend on the repository or service through constructor injection, not field `@Autowired`; entities are never returned from a controller, a DTO is; schema changes go through the project's migration tool. |
| TypeScript | `strict` stays on in `tsconfig.json`; no `any` or `as` casts at an API boundary, the response type comes from the shared types module; props and API results are typed, not inferred from `{}`. |
| FastAPI (Python) | Request and response bodies are Pydantic models, not dicts; route handlers are `async` and await every I/O call; one `HTTPException` shape for errors; money is `Decimal`, never `float`. |
| Reactive (WebFlux, Reactor, RxJS) | Handlers return the reactive type; nothing blocks inside the pipeline. |
| Data access | One access layer (R2DBC, not JPA, if that is the repo's choice); an applied migration is never edited, a new one is added. |
| Frontend | All API calls go through the one client module; no direct `fetch`; styling through the design system's tokens, not ad-hoc values. |
| Contracts | An API change updates the contract artifact (OpenAPI, Postman collection) in the same commit. |
| AI / prompts | Prompts live in the prompts directory, never inline in code. |

### Where Standards come from

- **The repo, for style, layout and naming.** Follow what the code does and cite the file where the pattern lives, in the Stack or in the item.
- **The official docs of the version the repo uses.** This step is required for every editing persona. Read each framework's major version from the lockfile (the manifest when there is none). Fetch the official docs or the upgrade guide for that major version with whatever web tool the session has (a fetch or search tool, or a docs server). From them write a few Standards, two to five, on what that version recommends or deprecates. Mark each `ecosystem idiom` and end it with its source URL. With no web tool, say so in the proposal and mark each such Standard `ecosystem idiom, from memory, unverified`. Where the repo has no habit yet, the same marking applies ("repo has no lockfile yet; the ecosystem commits one").
- **The engineering baseline** below, in this stack's terms.

The lookup uses the real version, but the Standard names none: a version in a Standard goes stale on the next upgrade. The source URL may name it, since it records where the rule came from.

**A habit is not a Standard when it is a defect.** When the official docs advise against a habit, or it is a defect pattern (a swallowed error, copy-pasted logic, an untyped escape hatch such as `any` or a blanket ignore comment, a test that asserts nothing), don't write it down. Write the right practice as the Standard, and list the habit in the proposal as existing debt, with a file that shows it, so the person sees it. New code follows the Standard; old code is changed only by a task that asks for it.

### Engineering baseline

Every editing persona states each of these as a Standard in its stack's own terms: the concrete form in this stack and repo, with a path where the repo already does it right. Never the slogan (SOLID, DRY, "clean code"); what a reviewer sees in a diff. If one cannot apply to the area (a migrations directory has no layers), leave it out and say why in the proposal.

| Principle | Written as, for example |
|---|---|
| One responsibility per unit | In the stack's natural unit: "a route handler parses the request, calls one service function and maps the result; business rules live in the service layer." |
| No second copy of existing logic | "Date formatting goes through the shared format module; new code that repeats logic already in the repo extracts it there and reuses it." |
| Dependency direction | "The domain package imports nothing from the web or persistence packages." |
| Errors typed or named, never swallowed | "Errors are subclasses of the app's base error; an `except` re-raises, or translates to the one error response at the route; never `except: pass`." |
| Inputs validated at the boundary | "Request bodies are parsed into a schema model at the route; code below it never re-checks raw input." |
| Tests assert behaviour | "Tests call the public endpoint or exported function and assert on its result; mocks only at process or network edges (HTTP, the database server, the clock)." |

### How many

Eight to fifteen Standards is right; past about twenty an agent skims and drops some. Merge or cut the weakest first, starting with anything a linter already enforces.

A persona is specific to its stack and its area. A Standard that fits any stack is generic ("handle errors", "write tests", "keep functions small"): cut it. A JVM backend persona and a TypeScript frontend persona in the same repo must share almost no Standards, because each holds what is true only for its stack and the directories it owns. At least most Standards cite a repo file, and each persona's Stack section names its manifest and the files `kit_scan.py` listed for its area.

## 4. Judges

A judge is a read-only persona: tools `Read, Grep, Glob, Bash`, no write tools. It advises; it never decides scope, which is for the human or the orchestrator.

- **`product-owner`.** Propose one for every project. It is an industry-specific judge: it thinks as a product owner in the industry kit:init stated for this project, never a generic product owner. Its body holds:
  - **Industry and domain**, one sentence, as kit:init stated it, with the files that show it.
  - **Users and buyers.** Who uses the product, who pays for it, and where they differ (a clinician uses it, a hospital buys it).
  - **Regulations and compliance rules that bind this product**, each tied to evidence in the repo (a file, a field, a README line) or marked as an inference. Name only rules that apply to what this product does; do not list every law of the industry.
  - **Domain invariants and vocabulary.** The rules a generic engineer would get wrong, and the industry's own words, used the way its people use them.
  - **The failures users in that industry care most about**, in their terms (a double-booked patient, a charge posted twice), so the judge knows what to catch first.
  - **Acceptance checks in the user's terms** ("a patient can ... and sees ..."), not the code's, covering those failures.
  - Pointers to the requirements doc and the README. It is used for user-facing changes. Model `opus`.

  Write the six parts as `##` headings named `Users and buyers`, `Regulations and compliance`, `Domain invariants`, `Vocabulary`, `Failures users care about` and `Acceptance checks`, so the checker finds them. Put each regulation as one list item that ends with a repo path in backticks or the word "inference".

  Forbidden: generic product-owner text ("understands user needs", "prioritises value", "ensures quality"), and any regulation, invariant or term the repo gives no sign of and that is not marked as an inference. If a sentence would fit a product owner in any industry, cut it.

  Example (healthcare, an outpatient appointment API): "Users: front-desk staff and clinicians; patients book through a portal; the clinic is the buyer. HIPAA binds this service: it stores patient identifiers (`Appointment.patientId`), so access is audit-logged (README) and no diagnosis is stored on an appointment. Invariants: a clinician has at most one `BOOKED` appointment per slot; a cancelled slot is bookable again; times are the clinic's local time. Failures that matter: a double-booked clinician, a patient seeing another patient's visit, a lost cancellation. Acceptance: a patient who cancels sees the slot free in the clinician's schedule at once; a front-desk user cannot read a diagnosis."
- **An architect reviewer.** Optional. Make it mostly the editing personas' Standards restated as anti-patterns per area, so each slip is caught twice. Do not fill it with generic architecture talk (SOLID, layers, "keep it simple"): those ideas enter as the engineering baseline, in checkable form.

## 5. Self-check before saving

A persona earns its place by short, concrete, checkable stack rules. Before you save one, check:

- Every path it names exists now. Open each.
- No counts, versions or line numbers ("27 tables", "~2650 lines", "v10"), and no command that a script or doc owns. Point at the script instead.
- No boilerplate a model already knows: SOLID, DRY, "comprehensive tests", accessibility or performance platitudes, "consider Redux or Zustand". The engineering baseline appears only in its checkable, stack-specific form.
- Each baseline principle is a Standard, or the proposal says why it does not apply.
- Each docs Standard is marked `ecosystem idiom` with its source URL, or as from memory, unverified.
- No Standard writes down a defect habit; the proposal lists it as debt.
- Fifteen Standards or fewer, twenty at most.
- No deliverables list of documents nobody reads.
- Every Standard is checkable from a diff.
- Swap the stack: would a Standard read the same in a persona for another language? Then it is generic; cut it or make it specific.
- The product owner states the industry, and each regulation or invariant in it has evidence or is marked as an inference.
- Nothing the repo cannot follow: no unit tests with a library the repo has no setup for, no tool it does not use.
- Read-only personas have a `tools` line without write tools.

Then run the checker on the draft, after the items above: `<python> <checker> --repo <project root> <draft> [<other persona drafts>]`, where the checker is `scripts/kit_persona_check.py` in this plugin (from this skill's base directory, `../../scripts/kit_persona_check.py`). Pass every persona you drafted in one run, so it can see a Standard copied between stacks. It prints `OK:` or one `ERROR: <file>: <reason>` per problem. Fix each one and run it again before you show or save the persona. It checks what a script can: that each Standard cites a path that exists, is not copied into another persona, and names an idiom of its stack (a stack outside the checker's table skips only the idiom check), and that a product-owner has its six parts. The items above still apply.

If an item fails, cut or fix it. A short persona that is all true beats a long one that is half stale.

## 6. Amend

When a path a persona names is gone, or the code contradicts a Standard, amend the persona in the same change that caused it, and cite the evidence (the commit, file or finding). A recurring review finding that a linter cannot catch becomes a Standard and a Review checklist line. Remove a Standard the team has dropped; do not leave it to be ignored. When the repo moves a framework to a new major version, repeat the docs step for that persona's docs Standards.
