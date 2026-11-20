# kit changelog

Before 0.5.0 the "From x.y" lines in the root README were kit's log.

## Unreleased

- `kit:persona` and `/kit:init` add a required docs step: read each framework's major version from the lockfile, fetch the official docs or upgrade guide for it with the session's web tool, and write two to five Standards from them, marked `ecosystem idiom` with the source URL. With no web tool the proposal says so and marks them from memory, unverified.
- A repo habit that the official docs advise against, or that is a defect pattern (swallowed errors, copy-pasted logic, untyped escape hatches, tests that assert nothing), is no longer written down as a Standard: the persona states the right practice and the proposal lists the habit as existing debt. `kit:builder` writes new code to the Standard and names the divergence, without refactoring old code outside the task.
- `kit:persona` adds an engineering baseline every editing persona states in its stack's terms (one responsibility per unit, no second copy, dependency direction, errors, input validation, test design), and a size limit of eight to fifteen Standards.
- `/kit:init` proposes the stack's standard static-analysis set (formatter check, type check, linter with complexity limits, duplication check, dependency audit, secret scan), one standard tool per job, each its own item with its cost.
- `kit:test-writer` gets test-quality rules (behaviour through public entry points, mocks only at edges, every test can fail, named by behaviour, not ticket or release), and `kit:reviewer` checks them.

## 0.5.0

- `/kit:init` identifies the industry and domain the project serves, from the README, docs, code names and data models. It states them, with the files it read, at the top of its proposal, and asks the person only when the repo can't tell.
- `/kit:init` proposes one persona per stack-area the code has, and says which area it leaves out and why.
- The `product-owner` persona is written for that industry: users and buyers, the regulations and compliance rules that bind the product (each tied to repo evidence or marked as an inference), domain invariants and vocabulary, the failures users care most about, and acceptance checks in their terms. Generic product-owner text is forbidden. `kit:persona` gives an example.
- `kit:persona` requires stack- and area-specific Standards that cite repo files, adds Spring Boot, TypeScript and FastAPI examples, and adds two self-check items (swap the stack; the product owner's industry).
- New `scripts/kit_scan.py` lists a repo's stack-areas (stack, framework, area, manifest, files to cite) and the evidence for its industry as JSON: README titles and first paragraphs, entity and table names from declarations, and the most frequent domain nouns, each with its file. It names no industry; `/kit:init` reads the evidence and names it, or asks the person. A `package.json` without TypeScript is `javascript`, and the framework comes from dependency keys.
- New `scripts/kit_persona_check.py` checks persona drafts: each Standard cites an existing path, is not copied into another persona and names an idiom of its stack (a stack outside its table skips only the idiom check); a `product-owner` has its six parts, with each regulation tied to evidence or marked as an inference. `/kit:init` and `kit:persona` run it before showing a persona.
- Tests run both scripts against four fixture repos under `tests/fixtures/stacks` (a Spring Boot backend, a React and Vite frontend, a FastAPI service and a build-tool CLI with no industry) and against golden personas drafted for the first three.
- `kit:builder` and `kit:test-writer` state in their descriptions and bodies that they are the fallback when no project persona covers the area. When they start in a repo with no persona for the area, the first line of their report is `Missing persona: ...` with a `/kit:init` recommendation, or `/kit:revise` when `.claude/kit` exists. `/kit:revise` proposes a persona for such an area.
- The manifest's `kit` field now records 0.5.0.
