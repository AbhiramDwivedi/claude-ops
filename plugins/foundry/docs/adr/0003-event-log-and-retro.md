# ADR-0003: an event log, a decision-log grammar, and a retro script that counts them

Status: proposed
Proposed on 2026-10-26 by foundry run 2's design crew, for foundry 0.4.0. It applies repo [ADR-0012](../../../../docs/adr/0012-extension-framework.md) and is accepted or sent back with it.

## Context

`foundry retro` should say how a run went: how many decisions, how the cynic's advice was followed, which models and efforts the crews used, how often agents stalled and leads escalated, how many judges failed. Today:

- Stalls, idle-lead wakes and lead tags live only in the hooks' memory, toasts and prompts (module doc, "On disk"). Spawn models are in memory too (`agent.spawn`, `hooks/register.ts:1059`).
- `decisions.md` has no declared grammar. This repo's session log holds three runs in one file with no markers between them, in at least six line forms: `- 2026-10-26 | dec | reason | — | —`, free-form `- 2026-10-26 hooks: ...`, `- 14:10 | ... | cynic: n/a`, the literal `- HH:MM | ...`, `- 2026-10-26T09:20:20Z king: ...`, and indented sub-bullets. The intel run's log uses `- HH:MM | ... | cynic: none | followed`, with 18 `- 09:10 | cynic-1 RECOMMEND answer: ... | followed` lines.
- The stamp hook's `DECISION_TIME` (`/^- (\d{1,2}:\d{2}) \|/`, `register.ts:399`) doesn't match the literal `HH:MM` the run skill tells the foreman to write, so those lines kept no time.

The interface that can't take the work: the foundry dir holds no record of these events, and `decisions.md` is a file only the foreman reads, with no shape code can rely on.

## Decision

### 1. `<foundry dir>/events.jsonl`

The hooks append one JSON line per event, under [`events.schema.json`](../events.schema.json). Every line carries `{"v": 1, "ts", "event", "crew", "agent"}`, plus:

| `event` | Written when | Extra fields |
| --- | --- | --- |
| `spawn` | the `tool.call` handler on `Agent` (`register.ts:1109`), after `next(e)` returns without a deny, for a call from inside a crew or one that starts a lead: the same calls that get the report note | `agentId` (or null), `type` (`subagent_type`, else `general-purpose`), `model` and `effort` as the call asked (or null), `by` (`main`, or the caller's spawn name) |
| `stall` | each stall wake and idle-lead wake, as its prompt goes out | `kind` (`agent` or `idle-lead`), `minutes` |
| `tag` | a lead's message to `main` that sets a tag | `tag` (`QUESTION`, `BLOCKED` or `PROPOSAL`) |
| `report` | a final report written to a report file (not an `.interim.md`) | `marker`: `VERDICT: PASS`, `VERDICT: FAIL`, `REDTEAM`, `CHECKPOINT`, `BLOCKED`, `QUESTION`, `PROPOSAL`, from the start of its first non-empty line, or null |

No line holds message, prompt or report text (P8). Appends go through one in-module promise chain, as `appendMessage` does (`register.ts:718`), because `$.fs` has no append. At 3 MiB (`ROLL_BYTES`) the next append first copies the log to `events.<n>.jsonl` at the first free `n`. A failed append is logged as `foundry: event log failed, letting the call through: <error>` and changes nothing else: the call, its note and its refusal behave as without the log (P5). The exact `crew` for a spawn is the caller's crew, or the lead's own name when the call starts a lead.

### 2. The `decisions.md` grammar, from 0.4.0

```
# <optional title>
## Run <RFC 3339 start, from `date -u +%Y-%m-%dT%H:%M:%SZ`> | <goal, one line>
- HH:MM | <decision> | <reason> | <cynic> | <outcome>
- HH:MM | cynic-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>
  <two-space continuation of the line above>
```

- The foreman writes a `## Run` heading when a run starts, before its first decision line. A session dir that holds several runs has one heading each.
- `<outcome>` is `followed`, `followed (deferred)` or `overruled: <reason>`.
- The foreman still writes the literal `HH:MM`. The stamp hook replaces it with the clock's local time: `DECISION_TIME` becomes `/^- (\d{1,2}:\d{2}|HH:MM) \|/`. A literal `HH:MM` is always stamped, even when the replaced text has one, since it marks no time.

### 3. `scripts/retro.py`

`python scripts/retro.py <foundry dir>` (Python 3.9+, standard library, P19; ADR-0004's pattern: the script counts, the skill judges). It reads `decisions.md`, `events*.jsonl`, `messages*.jsonl`, `reports/**` and `plan.json`, and writes nothing. It strips a UTF-8 BOM and `\r`. It prints one JSON object on stdout and exits 0. With no such dir it exits 2 with `retro: NO_FOUNDRY_DIR: <path>` on stderr.

**Reading `decisions.md`.**

- Only lines starting `- ` at column 0 count. Indented lines, headings other than `## Run` and blank lines are skipped.
- A **structured** line matches `^- (<time>) \| ` with `<time>` one of: a clock time `\d{1,2}:\d{2}`, the literal `HH:MM`, a date `\d{4}-\d{2}-\d{2}`, or an RFC 3339 date-time. Any other `- ` line is **free-form**.
- A structured line whose first field after the time matches `^cynic-\d+ RECOMMEND (answer|defer|pass)\b` is a **recommendation**. Every other structured line is a **decision**.
- A decision's time is `clock` (a clock time or a date-time), `dateOnly` (a date) or `notRecorded` (`HH:MM`).
- A decision's outcome is its last field: `followed` (exactly `followed` or `followed (deferred)`), `overruled` (starts `overruled`), or `other`.

**Splitting runs.**

- Each `## Run <start> | <goal>` heading starts a run. `started` is `<start>` when it parses as RFC 3339, else `"not recorded"`.
- Lines before the first heading form one more run, first in the list, with `started` and `goal` `"not recorded"`.
- With no heading the dir is one run and `split` is `"not recorded"`: retro can't split it. That is the case for every pre-0.4.0 dir, this repo's three-run log included. With headings, `split` is `"headings"`.
- Events and messages go to the run whose `started` is the latest one at or before their `ts`. Messages before the first heading go to the pre-heading run. Events before the first heading count in `eventsOutsideRuns`.
- The event-derived categories (`spawns`, `stalls`, `escalations`, `judges`) are `"not recorded"` for a run without a heading, and for every run when no `events*.jsonl` exists. So a pre-0.4.0 log reports `"not recorded"` for them rather than zero.

**Output.**

```
{
  "retro": 1,
  "dir": "<path>",
  "split": "headings" | "not recorded",
  "runs": [{
    "started": "<RFC 3339>" | "not recorded",
    "goal": "<text>" | "not recorded",
    "decisions": {"total", "clock", "dateOnly", "notRecorded", "followed", "overruled", "other"},
    "freeform": <n>,
    "recommendations": {"total", "answer", "defer", "pass"},
    "messages": <n>,
    "spawns": {"total", "byModelEffort": {"<model>/<effort>": <n>}} | "not recorded",
    "stalls": {"agent", "idleLead"} | "not recorded",
    "escalations": {"QUESTION", "BLOCKED", "PROPOSAL"} | "not recorded",
    "judges": {"pass", "fail"} | "not recorded"
  }],
  "judgeFiles": {"files", "pass", "fail", "other"},
  "plan": {"crews", "waves", "estAgents", "agentCap", "status": {"<status>": <n>}} | "not recorded",
  "eventsSkipped": <n>,
  "eventsOutsideRuns": <n>
}
```

- In `byModelEffort`, a null model or effort is `unset`.
- `judges` counts `report` events from agents named `<crew>-judge` or `<crew>-judge-<n>`.
- `judgeFiles` covers the whole dir: every `reports/*/*-judge.md` and `*-judge-<n>.md` (not `.interim.md`), sorted by its first line into `VERDICT: PASS`, `VERDICT: FAIL` or other. Report files are overwritten by name, so they can't be split by run.
- `plan` describes `plan.json`, which only the last run's plan survives in.
- `eventsSkipped` counts lines that aren't JSON or have a `v` other than 1.

### 4. The `foundry:retro` skill

`skills/retro/SKILL.md` runs the script, shows the counts, and proposes changes to `.claude/foundry.json` keys and to prompt-override files (foundry ADR-0002). It writes only what the owner approves. It hands repeated-work findings to `kit:revise` through the Skill tool when that skill is listed, and otherwise says so. It reads the script's output, never the raw logs (P24).

## Seams

1. **Event log.** `plugins/foundry/tests/contract.test.ts` drives `register.ts` through the harness in `tests/harness.ts`, whose foundry dir is `C:/r/.git/foundry/s1`, and reads `w.files.get('C:/r/.git/foundry/s1/events.jsonl')`. It imports only what exists today.
   - A crew member's `Agent` call with `model: "sonnet", effort: "medium"` appends exactly one line, `event: "spawn"`, with that model and effort, `v: 1`, and an ISO `ts`.
   - A call the hooks refuse (no `model`) appends nothing.
   - A crew agent idle past `STALL_MS` appends one `stall` line with `kind: "agent"`, once.
   - Every line parses as JSON and has `v`, `ts`, `event`, `crew` and `agent`.
   - With `fs.write` failing for `events.jsonl`, the `Agent` call still goes through with its report note.
2. **Retro counts.** `plugins/foundry/tests/test_contract_retro.py` runs `python plugins/foundry/scripts/retro.py <fixture dir>` as a subprocess, on synthetic dirs under `plugins/foundry/tests/fixtures/` (P8). One is shaped like both pre-0.4.0 logs: date, clock and `HH:MM` lines, free-form lines, sub-bullets, `RECOMMEND` lines, judge files, `messages.jsonl`, no headings and no events. One is a 0.4.0 dir with two `## Run` headings and an `events.jsonl`.
   - The counts for each category equal numbers written in the test.
   - On the pre-0.4.0 fixture, `split`, `spawns`, `stalls`, `escalations` and `judges` are `"not recorded"`, and its `HH:MM` lines count as `notRecorded`.
   - A missing dir exits 2 with `retro: NO_FOUNDRY_DIR:`.
3. **Stamp hook.** In `contract.test.ts`, a `Write` of `decisions.md` holding a new `- HH:MM | x | y | z | followed` line reaches disk with a clock time instead of `HH:MM`.

## Consequences

- From 0.4.0 retro can answer per run. Before it, it answers per dir and says what wasn't recorded.
- `events.jsonl` is a stored shape another plugin could read, so it is public surface (P15): a field rename bumps `v`.
- One more file write per crew `Agent` call, report, tag and stall, serialized behind the message log's chain.
- Open: report files are named per crew, so a later run in the same session dir that reuses a crew name, as this run's `design` does after 0.3.0's, overwrites that crew's `reports/<crew>/*-judge.md`. A stale higher-numbered judge file (0.3.0's `design-judge-2.md`) can outlive a newer `design-judge.md`, and the merge gate's "highest-numbered judge file" then reads the stale one. The `## Proof checked` SHA check stops a wrong merge. A per-run report folder would fix it; not decided here.
