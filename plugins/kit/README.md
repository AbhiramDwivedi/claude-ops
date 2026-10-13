# kit

Gives a project the agents, quality gates and review checklist it needs, inferred from its code, and revises them later from how its sessions went.

## Agent types

Each agent's model is fixed in its file, so picking the agent picks the model.

| Agent | Model | Does |
|---|---|---|
| `kit:builder` | Sonnet | Implements a well-specified change in the project's own style, and runs its checks before reporting done. |
| `kit:reviewer` | Opus | Reviews a diff against `.claude/kit/review-checklist.md` and for correctness. Read-only; reports, doesn't fix. Give it the diff, not your reasoning. |
| `kit:test-writer` | Sonnet | Writes tests from the spec before reading the implementation, so the tests don't encode its bugs. |
| `kit:scout` | Haiku | Searches and summarises code. Read-only. |

There is no architect or product-owner agent. A persona with the same context, model and tools as the main session adds cost, not quality. For a large change, use plan mode or the built-in Plan agent.

## `/kit:init`

Scans the repo (languages, frameworks, scripts, CI, lint/typecheck/test commands, services and ports) and proposes:

- a conventions section for `CLAUDE.md`, drawn from the code with file references;
- quality-gate hooks in `.claude/settings.json`: lint or typecheck after each edit, tests before an agent stops;
- `.claude/kit/review-checklist.md`, specific to the repo;
- project agents, skills or commands, only where the repo clearly needs one;
- `.claude/worktree-setup.sh`/`.ps1`, only for repos that run several services needing their own ports (used by the `worktrees` plugin).

If the repo has no linter or typechecker, it says so first: adding one is worth more than any agent. Nothing is written until you approve the proposal.

## `/kit:revise`

Reads the last 30 days of this project's transcripts and proposes changes: repeated command sequences or prompts become skills, repeated subagent briefs become agent types, recurring review findings become lint rules or checklist items, and unused items get deleted. Writes only what you approve.

A Python script (`scripts/kit_mine.py`) does the reading and prints a summary of a few KB, so the model never loads the raw transcripts. Its parser is copied from `workflow-audit`.

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
