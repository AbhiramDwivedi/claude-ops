# ADR-0004: standard-library Python scripts summarise transcripts; the model reads the summary

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

Three plugins learn from the user's Claude Code transcripts under `~/.claude/projects/`: workflow-audit (`/workflow-audit`), kit (`/kit:revise`) and subagent-limits (`scripts/ctx_study.py`). The transcripts are large, contain personal data, and change format between Claude Code releases (`plugins/workflow-audit/CONTRACT.md`, "Transcript facts").

## Decision

- A script does the reading; the model reads only its output. `kit:revise` says "Never open the raw transcripts"; `kit_mine.py` says "The model never reads raw transcripts; it reads what this prints". `audit.py run` writes `metrics.json` (aimed under 60 KB) and short sample excerpts for the skill to read.
- Scripts use the Python 3.9+ standard library only and run on Windows, macOS and Linux. The skills pick the first of `python3`, `python`, `py -3` that reports 3.9 or newer, and stop with a plain message when none does.
- Scripts treat transcripts as read-only and redact before printing (`wa_common.redact`, used by `kit_mine.py`).
- Each script's output has a written contract: `metrics.json`, `experiments.json`, `catalog/prices.json` and `catalog/practices.json` in `plugins/workflow-audit/CONTRACT.md`, with a metrics version number (7 at this commit) and a parse-cache version (3); `kit_mine.py`'s top-level keys in its docstring and in `skills/revise/SKILL.md`, section 2.
- Tests run on small synthetic transcripts in `tests/fixtures/`, never real ones.

## Consequences

- The skill prompt and the script share a stored shape. Renaming a `metrics.json` field means changing `CONTRACT.md`, the script, the skill and its tests together, and bumping the metrics version.
- A user without Python 3.9 can't use these three features; the mods still work.
- workflow-audit's parse cache lives in `~/.claude/workflow-audit/cache/`, keyed on file size and mtime, so a rerun over unchanged transcripts parses nothing again.
