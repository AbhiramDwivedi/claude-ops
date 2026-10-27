# ADR-0002: foundry init builds on kit's manifest, and foundry.json describes jobs

Status: accepted, 2026-10-27
Proposed on 2026-10-26 by foundry run 2's design crew, for foundry 0.4.0. It applies repo [ADR-0012](../../../../docs/adr/0012-extension-framework.md) and was accepted with it on 2026-10-27.

## Context

foundry init (`skills/init/SKILL.md`) only checks for the architecture doc and has the architect write one. It takes nothing from kit: the run skill lists agent types by hand each run (section 3), and `.claude/foundry.json` holds only `architecture`, `adr` and four owner keys (module doc, config table). Four things a project would set once are re-decided every run or not at all: which agent type does which job, how the project deploys, which writing skill the writer uses, and owner additions to a role's prompt. And the architect invents a port range per crew in `plan.md` (`agents/architect.md:72`) that nothing ties to worktrees' `PORT_BASE` slots (repo ADR-0005).

The interfaces that can't take the work: the config table has no keys for these, init has no input from kit, and the run skill's inventory step has nothing stored to start from.

## Decision

### 1. foundry init reads kit's manifest; kit stays a soft dependency

After step 1 (the doc check), init looks at `<repo>/.claude/kit/manifest.json` (contract: `plugins/kit/docs/manifest.schema.json`, repo [ADR-0013](../../../../docs/adr/0013-kit-manifest.md)). There is no plugin.json `dependencies` entry (repo ADR-0012, rule 5).

| What init finds | What it does |
| --- | --- |
| A valid manifest at `version` 1 that marks `foundry:judge` and `foundry:cynic` read-only | Uses it (below). |
| A valid manifest without those declarations, and `kit:init` listed among the session's skills | Runs `kit:init` through the Skill tool with args `declare read-only: foundry:judge, foundry:cynic`. kit shows the owner the declaration and writes it on approval. |
| No manifest, and `kit:init` listed | Runs `kit:init` through the Skill tool with the same args, so kit sets the project up and records the declaration in one approval. |
| `kit:init` not listed | Says `kit is not installed; foundry init carries on without a kit manifest (0.3.0 behaviour)` and carries on. |
| A manifest that isn't JSON, fails the schema or has another `version` | Says `kit manifest unreadable, carrying on without it: <reason>` and carries on as if there were none. It doesn't rerun `kit:init` over it. |

The rows don't overlap, because init decides on the manifest before it looks at the skill list. The first and last rows depend on the manifest alone. A valid manifest that already holds both declarations means there is nothing to do, whatever kit's install state: init uses it and says nothing about kit, even when `kit:init` isn't listed. An unreadable manifest gets the `unreadable` line, listed or not. Only when the manifest is absent, or valid but without the declarations, does the skill list decide: `kit:init` listed means the second or third row, and not listed means the `kit is not installed` line.

The judge and cynic are the declared types because both are `tools: Read, Grep, Glob, Bash`. The writer, devops, lead and architect edit files and stay isolated. Once kit records them, worktrees gives them no worktree (repo [ADR-0014](../../../../docs/adr/0014-worktrees-declared-read-only-agents.md)) and kit's stop gate skips them.

### 2. New foundry.json keys

The contract is [`foundry-config.schema.json`](../foundry-config.schema.json), which also declares the 0.3.0 keys. Every new key is optional, and leaving it out keeps 0.3.0 behaviour (P9). The file has no `version`: its keys are only ever added. A reader reports an undeclared key, at any depth, to the owner and ignores it, and treats a value that fails the schema as unset (below).

| Key | Shape | Default | Read by |
| --- | --- | --- | --- |
| `roles` | job (`build`, `test`, `review`, `search`, `docs`, `deploy`) to a full agent type | inventory, as 0.3.0 | the foreman's inventory and member choices (run skill, sections 3 and 4) |
| `deploy` | `{target, command, production}` | none: devops asks its lead | the devops member's brief; `production: true` always goes to the owner first |
| `writingSkill` | a skill name, such as `technical-writer` | none | the writer's brief: load it when listed, else say so |
| `promptOverrides` | foundry role (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`) to `.claude/foundry/prompts/<name>.md` | none | briefs (below) |

init proposes these from the manifest and the repo. `roles` comes from the manifest's agents, for example `build: kit:builder`, `test: kit:test-writer`, `review: kit:reviewer`, `search: kit:scout`; `deploy` from what the repo shows. init shows the owner the proposed keys and writes only the approved ones. It writes only keys the schema declares and keeps every key and value already in the file, at any depth.

**Validation, and what init does with errors it didn't cause.** The schema is closed at the top level and inside `roles`, `deploy` and `promptOverrides` (`additionalProperties: false`), and its enums and patterns also apply to keys the owner wrote by hand. So a file can fail validation for reasons init had no part in: a stray key at any depth, or a bad owner value such as an out-of-enum `merge`. init builds the file it would write (the current file plus the approved values) as a candidate outside the repo, `<foundry dir>/scratch/foundry.candidate.json`, and validates the candidate with `npx -y -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats --all-errors --errors=json -s <foundry-config.schema.json> -d <candidate>`, as the architect does for `plan.json`. It then sorts each error by its path: the error's `instancePath`, plus `/<params.additionalProperty>` for an `additionalProperties` error or `/<params.missingProperty>` for a `required` one. So a hand-written `roles.judge` is `/roles/judge`, and a `deploy` without `production` is `/deploy/production`.

- **An error at a path init did not write in this run** (owner-written, at any depth) is not fatal. init reports it to the owner by path (for example `/merge: must be equal to one of the allowed values` or `/roles/judge: undeclared, ignored`), keeps it unchanged, and carries on: it still writes its approved values. It never deletes, rewrites or "fixes" what the owner wrote.
- **An error at a path init is writing in this run**, or inside one, stops the write. init writes nothing, `.claude/foundry.json` stays exactly as it was, and init reports the error with its path.

Readers (the run skill, the foreman's briefs) treat the file the same way. An undeclared key, at any depth, is reported once and ignored. A declared key whose value fails the schema is reported once and treated as unset, so its default applies.

### 3. Prompt overrides name files, and the briefs carry them

`promptOverrides` stores paths, never prompt text (P21). The files are the owner's, committed in the project. They add to a role's prompt and never replace it: no `skill.prompt` hook, no re-registered agent type (repo ADR-0012, rule 4). The foreman writes a `Prompt overrides:` line in each goal file, naming the role and file for every configured role. Each lead's brief names the lead's file. The lead puts the right line into each judge, writer and devops brief: "Read `<path>` before you start; it adds to your instructions. Your report format and the hooks' rules still hold." The foreman does the same for the cynic and the architect. A missing file is reported and skipped.

### 4. Ports come from worktrees

foundry stops inventing port ranges. The architect's resource slice in `plan.md` names ports only as one of these two lines:

- `ports: the crew's worktree slot (PORT_BASE to PORT_BASE+9, from .claude/worktree-setup.*)`, when the repo has a setup script;
- `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)`, when it doesn't.

A crew that needs a port in a repo without a setup script raises a `QUESTION:`. The run skill's example table drops its `ports 4100-4109`. There is no `ports` key: nothing about it is the project's to choose.

### 5. Diagrams

The architect's prompt asks for mermaid diagrams in `init` and `design` mode (a context or container `flowchart`, and a `sequenceDiagram` for a flow across modules), each with at most about 12 nodes, a caption, and the source files it traces to.

foundry goes to 0.4.0 (P16).

## Seams

`plugins/foundry/tests/contract.check.ts`, run by `node --test` like `packs.check.ts`, reads the prompt files and the schema as text. It pins:

1. `skills/init/SKILL.md` names `.claude/kit/manifest.json`, `kit:init`, the args `declare read-only: foundry:judge, foundry:cynic`, and the sentence `kit is not installed; foundry init carries on without a kit manifest (0.3.0 behaviour)`.
2. `skills/init/SKILL.md` names `foundry-config.schema.json` and each new key the schema declares (`roles`, `deploy`, `writingSkill`, `promptOverrides`).
3. `skills/run/SKILL.md` names `PORT_BASE`, `Prompt overrides:` and `roles`, and no longer holds `4100-4109`.
4. `agents/architect.md` asks for `mermaid` diagrams, holds `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)`, and no longer holds `port range`.
5. `docs/foundry-config.schema.json` parses as JSON, has `additionalProperties: false`, and each `promptOverrides` value pattern accepts `.claude/foundry/prompts/judge.md` and rejects `../judge.md` and `.claude/foundry/prompts/a/b.md` (checked with `new RegExp`).

## Consequences

- A project without kit gets 0.3.0 behaviour plus the new keys, and its judges and cynics still get worktrees unless the owner sets worktrees' `noIsolateAgents`.
- foundry init can now start a second skill that writes into the project. Each write still goes through that skill's own approval step.
- Port slices stop overlapping, because worktrees' slot lock allocates them (repo ADR-0006). A repo with no setup script gets no ports, and has to say what it needs.
- `.claude/foundry.json` has no `version`, which departs from P29 (stored shapes are declared and versioned). The departure dates from 0.3.0, and this ADR widens it by adding keys. Keys that are only added and optional keep every older reader working, and the closed schema declares each one. The file gets a `version` key, and the schema a matching `const`, on the first change of meaning: a key renamed, removed, or read differently. This ADR adds no `version` now. It is foundry's own config, not an extension point (repo ADR-0012, "Extension points declared by this run").
- Prompt overrides are text the owner wrote and the base's tests never see. They only add instructions, and the hooks still enforce what code can (repo ADR-0008).
