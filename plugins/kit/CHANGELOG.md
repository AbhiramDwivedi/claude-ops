# kit changelog

Before 0.5.0 the "From x.y" lines in the root README were kit's log.

## 0.5.0

- `/kit:init` identifies the industry and domain the project serves, from the README, docs, code names and data models. It states them, with the files it read, at the top of its proposal, and asks the person only when the repo can't tell.
- `/kit:init` proposes one persona per stack-area the code has, and says which area it leaves out and why.
- The `product-owner` persona is written for that industry: users and buyers, the regulations and compliance rules that bind the product (each tied to repo evidence or marked as an inference), domain invariants and vocabulary, the failures users care most about, and acceptance checks in their terms. Generic product-owner text is forbidden. `kit:persona` gives an example.
- `kit:persona` requires stack- and area-specific Standards that cite repo files, adds Spring Boot, TypeScript and FastAPI examples, and adds two self-check items (swap the stack; the product owner's industry).
- New `scripts/kit_scan.py` lists a repo's stack-areas (stack, framework, area, manifest, files to cite) and industry signals as JSON. `/kit:init` runs it in its scan. Tests run it against three fixture repos under `tests/fixtures/stacks`: a Spring Boot backend, a React and Vite frontend and a FastAPI service.
- `kit:builder` and `kit:test-writer` state in their descriptions and bodies that they are the fallback when no project persona covers the area. When they start in a repo with no persona for the area, the first line of their report is `Missing persona: ...` with a `/kit:init` recommendation, or `/kit:revise` when `.claude/kit` exists. `/kit:revise` proposes a persona for such an area.
- The manifest's `kit` field now records 0.5.0.
