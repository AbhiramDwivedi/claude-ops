---
name: retro
description: Counts what a foundry session recorded (escalations, cynic recommendations and overrules, stalls, spawns by model and effort, judge rejections, decision timing, the plan) and proposes changes to .claude/foundry.json and the prompt-override files from them. Use when the person runs /foundry:retro, or asks how a foundry run went, what to change in foundry's setup, or why crews stalled or got rejected.
---

# foundry retro

You report what a foundry session dir recorded and propose setup changes from it. A script does the counting; you judge. You never read the raw logs (P24) and you never print message, prompt or report text, except the judge files' `VERDICT:` and finding lines that section 3 quotes as evidence.

The person who ran `/foundry:retro` is the owner.

## 1. Find the dir and run the script

The session's foundry dir is `<repo>/.git/foundry/<session id>/`. Use the current session's, or the one the owner names. Resolve `<repo>` with `git rev-parse --git-common-dir`, which also works from a worktree.

Find the script: `${CLAUDE_PLUGIN_ROOT}/scripts/retro.py` when that variable is set, else `scripts/retro.py` two directories above this skill's own folder. Then run:

```
python <plugin root>/scripts/retro.py <foundry dir>
```

Exit 2 with `retro: NO_FOUNDRY_DIR:` means the dir is wrong: say so, show the path, ask the owner for the right one, and stop. Any other failure: show the error and stop.

For the counts, read only the JSON it prints. Section 3 adds a few bounded reads of its own.

## 2. Report the counts

Per run (`runs`), then the dir-wide keys. Be brief; a table or short list per run.

- **Escalations** (`escalations`): QUESTION, BLOCKED, PROPOSAL.
- **Cynic** (`recommendations`): answer, defer, pass. With `decisions.overruled`, say how often the foreman overruled.
- **Stalls** (`stalls`): agent and idle-lead.
- **Spawns** (`spawns`): total, and `byModelEffort`. `unset` means the call named no model or effort.
- **Owner interruptions**: `escalations.QUESTION` and `escalations.BLOCKED` are what leads sent the foreman that could reach the owner; the foreman took only some to the owner, so call these an upper bound. `messages` counts lead-to-lead messages, not owner interruptions; report it separately as crew collisions.
- **Judge rejections**: `judges.fail` per run, and `judgeFiles` for the whole dir (its files can't be split by run).
- **Spent budgets** (`budgetsSpent`, per run): how many distinct crews spent their repair budget. `"not recorded"` means the log can't back a number, as on a pre-0.5.0 log or a run that spent none; say so and never write 0. `retro` stays 1.
- **Fetches** (`fetches`, per run): `total` and `perAgent`, the web fetches and searches the agents logged (0.8.0 and later logs). `"not recorded"` means the run is not placed in the event log, or the whole log has no fetch line, as on a pre-0.8.0 log; say so and never write 0. A log with fetch lines but none in this run gives `total` 0.
- **Extend passes** (`extendPasses`, per run): commits in the run's window (from its start to the next run's start) whose subject starts `docs(arch): extend ` or is `docs(arch): adopt learned items`. 0 means git was read and none matched. `"not recorded"` means the dir isn't `<repo>/.git/foundry/<session>`, git couldn't run, or the run has no parsed start.
- **Default decisions** (`defaultDecisions`): how many ADRs in the `adr` dir of `.claude/foundry.json` still hold the line `Decided by: default`. It is the repo's state now, so every run shows the same number. `"not recorded"` means no repo root, no readable config, no `adr` key, or no such dir.
- **Open owner actions** (`openOwnerActions`): how many `- [ ] ` lines sit under an `Owner actions` heading in the file named by the `architecture` key. Also the repo's state now. `"not recorded"` means no repo root, config, key or file. Report the four keys above as counts and propose no rule deletion from them; what evidence justifies deleting a domain rule is still open (foundry ADR-0005, Consequences, "Open: pruning evidence").
- **Opus-high share**: the share of the run's spawns on Opus at `high` or `xhigh`. The numerator is the sum of the `byModelEffort` counts whose model contains `opus` (case-folded) and whose effort is `high` or `xhigh`; the denominator is `spawns.total`. The target is 0, unless a line in `decisions.md` records the owner's call for `high` or `xhigh`. Report any other non-zero share as over target. The script prints no key for it; you compute it.
- **Decision timing** (`decisions`): `clock`, `dateOnly`, `notRecorded`. Also `freeform` lines the script couldn't read as decisions.
- **Leftovers** (`leftovers`): this session's agents whose `worktree-agent-<id>` branch or `.claude/worktrees/agent-<id>` folder is still present, read from git and the disk. Report `count` and the names. `"not recorded"` means the dir isn't `<git common dir>/foundry/<session>`, there's no event log, or git couldn't run; say so and never write 0.
- **Leftover details** (`leftoverDetails`): one entry per leftover. Per entry, report its `id`, `head`, `dirty`, `inMain` and `skip`; write a `null` value as none. When the key is `"not recorded"`, say "not recorded".
- **Plan** (`plan`): crews, waves, the `estAgents` total, and `status` counts. `agentCap` is retired (0.7.0); an old plan.json may still carry it, and when it does not the script says "not recorded". Mention it only if it is a number. It describes the last run only.

Wherever the JSON says `"not recorded"`, write "not recorded". Never turn it into zero, and never guess a number. If `split` is `"not recorded"`, say the dir couldn't be split into runs: the counts are for the whole dir, and the event-derived ones (spawns, stalls, escalations, judges) weren't recorded. If `eventsSkipped` is above 0, say how many event lines were skipped; `eventsOutsideRuns` events fell before the first run heading.

## 3. Find the causes

Give each anomaly one line, exactly `CAUSE: <anomaly> | <evidence> | <fix location>`. There are five kinds. `<anomaly>` starts with the kind's name, then names the item, for example `leftover a0123456789abcdef` or `judge fail auth-judge-2`.

- `leftover`: each `leftoverDetails` entry.
- `judge fail`: each judge file (`reports/<crew>/<name>-judge.md` or `<name>-judge-<n>.md` in the foundry dir) whose first line starts `VERDICT: FAIL`.
- `stall`: per run, a non-zero `stalls.agent` or `stalls.idleLead`.
- `overrule`: per run, a non-zero `decisions.overruled`.
- `spent budget`: per run, a non-zero `budgetsSpent`.

Spawns over estAgents are not an anomaly; give them no CAUSE line.

`<evidence>` is a fact from an allowed source, such as the entry's `skip` string or a judge finding line (a line under the judge file's `## Findings` heading that starts `- `). `<fix location>` is a file and a key, line or section. When the allowed sources don't show a cause, write `CAUSE: <anomaly> | not found | none`. Don't guess.

Its only sources are git, the disk, decisions.md, the judge files' VERDICT: and finding lines, and the plugin's own files. It never reads message, prompt or report bodies (P24). The judge files' `VERDICT:` and finding lines are the only report text it reads. Use at most 3 reads per anomaly; a git command, a file read and a grep each count as one.

A leftover whose `skip` is `passes every check retro can see` may still be kept by a check retro can't see: the session's own checkout, an agent that hasn't stopped, a crew member still running, or the checkout the last merge ran in. Say so in the evidence; don't pick one.

When the fix belongs in a file of the foundry plugin, not of the project, start `<fix location>` with `plugin: `. Plugin-level causes go to the owner as plugin findings and are never written (ADR-0005 section 1). Only project files (`.claude/foundry.json`, prompt-override files) can become section 4 proposals.

## 4. Propose changes

Propose a change only when a count or a section 3 `CAUSE:` line supports it, and say which. Each proposal names a file and a key or path, the current value (read the file; it is the owner's config, not a log), the new value, and why.

- `.claude/foundry.json`: `roles` (a job's agent type, for example a job whose judge rejections or stalls cluster on one model), `deploy`, `writingSkill`, `promptOverrides`. Keep to keys the schema declares (`foundry-config.schema.json`).
- `.claude/foundry/prompts/<role>.md` for the roles `lead`, `judge`, `cynic`, `writer`, `devops`, `architect`: a line a role keeps missing, and the `promptOverrides` entry that points to the file. A prompt file adds to the role's prompt; it never replaces it.

If the counts support nothing, say so and stop. Don't invent changes.

## 5. Write only what the owner approves

Show the proposals as a list. Write only the ones the owner approves, keep every key and value already in the file, and don't edit anything else. Then show what changed.

Repeated work the counts point to, such as the same command sequence or the same brief written again, is `kit:revise`'s job. When `kit:revise` is in the skills list, hand it the finding through the Skill tool. Otherwise say `kit:revise` isn't installed.
