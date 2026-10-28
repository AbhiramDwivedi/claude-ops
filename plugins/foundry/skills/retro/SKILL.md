---
name: retro
description: Counts what a foundry session recorded (escalations, cynic recommendations and overrules, stalls, spawns by model and effort, judge rejections, decision timing, the plan) and proposes changes to .claude/foundry.json and the prompt-override files from them. Use when the person runs /foundry:retro, or asks how a foundry run went, what to change in foundry's setup, or why crews stalled or got rejected.
---

# foundry retro

You report what a foundry session dir recorded and propose setup changes from it. A script does the counting; you judge. You never read the raw logs (P24) and you never print message, prompt or report text.

The person who ran `/foundry:retro` is the owner.

## 1. Find the dir and run the script

The session's foundry dir is `<repo>/.git/foundry/<session id>/`. Use the current session's, or the one the owner names. Resolve `<repo>` with `git rev-parse --git-common-dir`, which also works from a worktree.

Find the script: `${CLAUDE_PLUGIN_ROOT}/scripts/retro.py` when that variable is set, else `scripts/retro.py` two directories above this skill's own folder. Then run:

```
python <plugin root>/scripts/retro.py <foundry dir>
```

Exit 2 with `retro: NO_FOUNDRY_DIR:` means the dir is wrong: say so, show the path, ask the owner for the right one, and stop. Any other failure: show the error and stop.

Read only the JSON it prints.

## 2. Report the counts

Per run (`runs`), then the dir-wide keys. Be brief; a table or short list per run.

- **Escalations** (`escalations`): QUESTION, BLOCKED, PROPOSAL.
- **Cynic** (`recommendations`): answer, defer, pass. With `decisions.overruled`, say how often the foreman overruled.
- **Stalls** (`stalls`): agent and idle-lead.
- **Spawns** (`spawns`): total, and `byModelEffort`. `unset` means the call named no model or effort.
- **Owner interruptions**: `escalations.QUESTION` and `escalations.BLOCKED` are what leads sent the foreman that could reach the owner; the foreman took only some to the owner, so call these an upper bound. `messages` counts lead-to-lead messages, not owner interruptions; report it separately as crew collisions.
- **Judge rejections**: `judges.fail` per run, and `judgeFiles` for the whole dir (its files can't be split by run).
- **Spent budgets** (`budgetsSpent`, per run): how many distinct crews spent their repair budget. `"not recorded"` means the log can't back a number, as on a pre-0.5.0 log or a run that spent none; say so and never write 0. `retro` stays 1.
- **Opus-high share**: the share of the run's spawns on Opus at `high` or `xhigh`. The numerator is the sum of the `byModelEffort` counts whose model contains `opus` (case-folded) and whose effort is `high` or `xhigh`; the denominator is `spawns.total`. The target is 0, unless a line in `decisions.md` records the owner's call for `high` or `xhigh`. Report any other non-zero share as over target. The script prints no key for it; you compute it.
- **Decision timing** (`decisions`): `clock`, `dateOnly`, `notRecorded`. Also `freeform` lines the script couldn't read as decisions.
- **Leftovers** (`leftovers`): this session's agents whose `worktree-agent-<id>` branch or `.claude/worktrees/agent-<id>` folder is still present, read from git and the disk. Report `count` and the names. `"not recorded"` means the dir isn't `<git common dir>/foundry/<session>`, there's no event log, or git couldn't run; say so and never write 0.
- **Plan** (`plan`): crews, waves, `estAgents` against `agentCap`, and `status` counts. It describes the last run only.

Wherever the JSON says `"not recorded"`, write "not recorded". Never turn it into zero, and never guess a number. If `split` is `"not recorded"`, say the dir couldn't be split into runs: the counts are for the whole dir, and the event-derived ones (spawns, stalls, escalations, judges) weren't recorded. If `eventsSkipped` is above 0, say how many event lines were skipped; `eventsOutsideRuns` events fell before the first run heading.

## 3. Propose changes

Propose a change only when a count supports it, and say which count. Each proposal names a file and a key or path, the current value (read the file; it is the owner's config, not a log), the new value, and why.

- `.claude/foundry.json`: `roles` (a job's agent type, for example a job whose judge rejections or stalls cluster on one model), `deploy`, `writingSkill`, `promptOverrides`. Keep to keys the schema declares (`foundry-config.schema.json`).
- `.claude/foundry/prompts/<role>.md` for the roles `lead`, `judge`, `cynic`, `writer`, `devops`, `architect`: a line a role keeps missing, and the `promptOverrides` entry that points to the file. A prompt file adds to the role's prompt; it never replaces it.

If the counts support nothing, say so and stop. Don't invent changes.

## 4. Write only what the owner approves

Show the proposals as a list. Write only the ones the owner approves, keep every key and value already in the file, and don't edit anything else. Then show what changed.

Repeated work the counts point to, such as the same command sequence or the same brief written again, is `kit:revise`'s job. When `kit:revise` is in the skills list, hand it the finding through the Skill tool. Otherwise say `kit:revise` isn't installed.
