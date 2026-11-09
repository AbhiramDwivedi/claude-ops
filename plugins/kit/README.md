# kit

Gives a project the agents, quality gates and review checklist it needs, inferred from its code, and revises them later from how its sessions went.

## Agent types

Each agent's model is fixed in its file, so picking the agent picks the model. `kit:reviewer` also pins `effort: medium`.

| Agent | Model | Does |
|---|---|---|
| `kit:builder` | Sonnet | Implements a well-specified change in the project's own style, and runs its checks before reporting done. |
| `kit:reviewer` | Opus | Reviews a diff against `.claude/kit/review-checklist.md` and for correctness. Read-only; reports, doesn't fix. Give it the diff, not your reasoning. |
| `kit:test-writer` | Sonnet | Writes tests from the spec before reading the implementation, so the tests don't encode its bugs. |
| `kit:scout` | Haiku | Searches and summarises code. Read-only. |

These four are generic. The quality bar lives in **personas**: project agents in `.claude/agents/`, one per stack and area (`spring-webflux-backend`, `nextjs-frontend`, `postgres-migrations`). Each carries numbered Standards a reviewer can rule on from a diff, in the stack's own idiom (pinned versions in a Maven build, caret ranges and a committed lockfile in an npm project), plus pointers to the scripts and docs that own the commands. It holds no counts, versions or commands, so it doesn't rot. `kit:builder` is the fallback for areas no persona covers.

**Judges** are read-only personas, with no write tools. Every project gets a `product-owner`: who the users are, the domain rules a generic engineer would get wrong, what done means to a user. It advises and never decides scope. An architect reviewer is optional, and is mostly the editing personas' Standards restated as anti-patterns. `kit:reviewer` holds a diff to the Standards of every persona whose area it touches.

The `kit:persona` skill says how to write and amend one. `/kit:init` proposes them on day 0; `/kit:revise` amends them from evidence.

## `/kit:init`

Scans the repo (languages, frameworks, scripts, CI, lint/typecheck/test commands, services and ports) and proposes:

- a conventions section for `CLAUDE.md`, drawn from the code with file references;
- quality-gate hooks in `.claude/settings.json`: lint or typecheck after each edit, tests before an agent stops;
- `.claude/kit/review-checklist.md`, specific to the repo;
- one persona per stack and area, plus a `product-owner` judge; on a repo with no code it asks you for the stack first;
- project skills or commands, only where the repo clearly needs one;
- `.claude/worktree-setup.sh`/`.ps1`, only when a fresh worktree can't run the tests without setup, or the repo runs services that need separate ports (used by the `worktrees` plugin).

If the repo has no linter or typechecker, it says so first: adding one is worth more than any persona. Nothing is written until you approve the proposal.

## `/kit:revise`

Reads the last 30 days of this project's transcripts and proposes changes: repeated command sequences or prompts become skills, repeated subagent briefs become agent types, recurring review findings become lint rules or checklist items, personas are amended when a path they name is gone or the code contradicts a rule, and unused items get deleted. Writes only what you approve.

A Python script (`scripts/kit_mine.py`) does the reading and prints a summary of a few KB, so the model never loads the raw transcripts. Its parser is copied from `workflow-audit`.

## Manifest

After you approve the proposal, and never before, `/kit:init` writes `.claude/kit/manifest.json` through `scripts/kit_manifest.py`. It is the one file other tools read to learn what kit set up. The contract is [`docs/manifest.schema.json`](docs/manifest.schema.json); every field is required.

| Field | Holds |
|---|---|
| `version` | The manifest format version, `1`. |
| `kit` | The version of kit that wrote it. |
| `checks` | The project's own checks that kit found and you approved. |
| `agents` | Agent types, each `{name, readOnly, declaredBy}`. `name` is the full type, such as `kit:reviewer`. `declaredBy` is the plugin that declared it, or `project` for a bare name. |
| `riskyPaths` | Paths where a wrong edit is costly, each with a reason. |
| `setupScripts` | The project's `.claude/worktree-setup.sh` and `.ps1`, whichever exist. |

The script has two subcommands:

- `write --repo <dir> --facts <file|->` takes the approved facts and writes the manifest.
- `declare --repo <dir> --by <plugin> --read-only <names>` marks agent types read-only in an existing manifest. The names are comma-separated. Each is `<plugin>:<name>` with the prefix equal to `--by`, or, with `--by project`, a bare name for one of the project's own agents. Foundry uses it to mark its own agent types.

Both subcommands refuse to mark an editing type read-only: a `readOnly: true` entry (or a `declare --read-only` name) that case-folds to `general-purpose`, `kit:builder`, `kit:test-writer`, `foundry:architect`, `foundry:devops`, `foundry:lead`, `foundry:writer`, `truss:foreman`, `truss:design-engineer`, `truss:commissioning-engineer`, `truss:planning-engineer` or `truss:writer` exits 2 with `READ_ONLY_EDITING_TYPE`, after every other bad-input check. The same name at `readOnly: false` is fine. Reading stays tolerant: an old manifest holding such an entry still loads, and the stop gate never skips those names. When `write` or `declare` would carry such an entry over from the old file, it drops it and prints `kit_manifest: warning: dropped <name> (declaredBy <plugin>): READ_ONLY_EDITING_TYPE` to stderr, one line per entry.

Personas need no manifest change: an editing persona is listed as `{name, readOnly: false, declaredBy: "project"}`, a judge with no write tools as `readOnly: true`.

This is kit 0.3.0: input that 0.2.0 accepted (a refused type at `readOnly: true`) now exits 2.

Two things read the manifest:

- The stop gate (`.claude/kit/stop-gate.sh` and `.ps1`) skips agents whose type is read-only. The script re-renders that skip list between the `# kit:read-only-agents:begin` and `# kit:read-only-agents:end` markers on every `write` and `declare`. With no manifest, the gate keeps the built-in list.
- The `worktrees` plugin skips the worktree for an agent whose full name, case-folded, matches a manifest agent with `readOnly: true`.

## Requirements

Python 3.9 or newer for `/kit:revise`, standard library only.

## Install

```
/plugin marketplace add AbhiramDwivedi/claude-ops
/plugin install kit@claude-ops
```

## Tests

```
python -m unittest discover -s plugins/kit/tests
```
