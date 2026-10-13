---
name: revise
description: Revises the project's Claude Code setup from how its recent sessions actually went - repeated command sequences become skills, repeated subagent briefs become agent types, recurring review findings become checklist items or lint rules, and unused kit items get deleted. Proposes a diff and writes only after approval. Use when the person runs /kit:revise or asks to update, prune or improve the project's agents, skills, commands or checklist.
allowed-tools: Bash(python3 *), Bash(python *), Bash(py *)
---

# kit revise

You are adjusting this project's agents, skills, commands, hooks and review checklist to fit how work in it really goes. The evidence comes from a script that reads the project's transcripts. Never open the raw transcripts (`~/.claude/projects/...jsonl`): they are huge, and the script has already extracted what matters.

## 1. Run the miner

The script is `scripts/kit_mine.py` in this plugin: from this skill's base directory, `../../scripts/kit_mine.py`. Resolve it to an absolute path. Use the first of `python3`, `python`, `py -3` that prints Python 3.9 or newer for `--version` (on Windows, `python` can be the Microsoft Store placeholder; treat that as missing). If none works, say "kit revise needs Python 3.9+" and stop.

Run it from the project root: `<python> <script> --days 30`. It prints one JSON object (a few KB). It covers this project's sessions and those of its worktrees under `.claude/worktrees/`. If `window.sessions` is under 5, say there is too little history to revise from, and stop.

## 2. Read the summary

- `commands`: shell command sequences agents ran in two or more sessions, normalised to their leading words, with run and session counts.
- `prompts.repeated`: near-identical prompts the person typed three or more times. `prompts.slash_commands`: commands they ran.
- `briefs`: clusters of similar subagent briefs, with the agent types and models used and a redacted sample.
- `findings`: lines that recur across two or more reviewer reports.
- `kit`: every agent, skill and command in the project's `.claude/` and in kit itself, with its use count in the window.

## 3. Decide

For each signal, decide whether it earns a change. Fewer, better changes beat a long list. Read the project's existing `.claude/` files and `CLAUDE.md` before proposing, so you extend rather than duplicate.

- **A repeated command sequence becomes a skill or command** when it has a purpose (release, regenerate, reset a database) and ran in three or more sessions. Read-only habits (`git status` then `git log`) and plain commit sequences don't count. A repeated typed prompt is an even stronger sign: the person is doing a skill's job by hand.
- **A repeated brief becomes a project agent type** when the briefs share a role and instructions that each one restated, not just a topic. The new agent's file holds what the briefs repeated, with `model` pinned (sonnet for well-specified work, opus for judgment, haiku for search). If a kit agent already covers the role, suggest briefing that one instead.
- **A recurring review finding becomes a lint rule when a linter can catch it**, and a checklist item in `.claude/kit/review-checklist.md` only when it can't. A rule catches it on every edit; a checklist item needs a reviewer to remember it. Name the rule and its config.
- **A kit item with zero uses gets deleted**, unless it is under a month old or covers a rare but important event (incident, release); say which. For kit's own agents, suggest how to brief them instead of deleting anything.
- Check that the gate hooks in `.claude/settings.json` still name commands that exist in the project.

## 4. Propose, then write

Show one proposal: for each change, the evidence (counts from the summary), the file to create, change or delete, and its full text or diff. Ask whether to apply all, some or none. Write only what is approved, and don't commit unless asked.

When nothing earns a change, say so in two lines. That is a normal result.
