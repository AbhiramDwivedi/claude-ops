# ADR-0004: scope-bounded claims, a bounded repair loop, a patch-bound head guard, and the hooks' half of the effort ladder

Status: accepted, 2026-10-28
Accepted on the owner's approval of the foundry run-3 plan (`plan.json` `approvedAt` 2026-10-28T00:31:42Z). Proposed by run 3's design crew (wave 0), for foundry 0.5.0. The effort-ladder principle itself (who runs at which effort) is recorded in the repo's [ADR-0011](../../../../docs/adr/0011-agents-pin-their-model.md) amendment; this ADR records what foundry's hooks, prompts and retro do about it.

Amended 2026-10-28 by repo [ADR-0015](../../../../docs/adr/0015-agent-worktree-cleanup.md), item 11, accepted with the run-4 plan (`approvedAt` 2026-10-28T15:11:50Z), for foundry 0.6.0: leads merge the target into the crew branch instead of rebasing, so `<base>` (section 6) is the target head last merged in, and the patch-id carry applies across that merge. The passages that said "rebase" now say so; the context below still describes 0.4.3 as it was.

## Context

Run 3's goal items 2, 3 and 7 (`plan.json` `goal`) need four things foundry 0.4.3 can't express:

- **Scope.** A lead's report says what was checked, but nothing says what wasn't. A claim like "no other caller" or "every call site updated" passes the judge with no record of where anyone looked.
- **A bounded repair loop.** After a judge FAIL the lead starts `<crew>-judge-2`, `-3` and so on with no limit (`agents/lead.md:101-105`). Nothing stops a crew from looping, and nothing records that it ran out of tries.
- **The head a PASS belongs to.** The judge states the SHA it ruled on somewhere in free text under `## Proof checked` (`agents/judge.md:72`, `agents/lead.md:103`). No hook can read it. The foreman compares it by eye (`skills/run/SKILL.md:281`, `:288`). After a rebase the head always moves, so every rebase needs a fresh judge (`agents/lead.md:155`), even when the crew's change is byte-for-byte the same.
- **Calls with no model or effort from the main session.** `agentVerdict` and `effortVerdict` (`hooks/register.ts:232`, `:243`) return early outside a crew, so the architect, cynic, lead and integration judge the foreman starts get their frontmatter's effort unless the call sets one.

The interfaces that can't take the work:

- `plan.schema.json` is closed (`additionalProperties: false`) and pins `version` to `const: 1` (`:18-20`), so a plan can't carry a repair budget.
- The judge's report has no fixed line a hook can parse for the head or the patch, which breaks repo P23 for any code that would read them.
- The lead's report format (`agents/lead.md:158-185`) and the lead stop gate (`leadStopPasses`, `register.ts:373`) know only the six sections.
- `.claude/foundry.json` has no key for the budget (`foundry-config.schema.json`).
- retro's top-level and per-run keys are a pinned contract (`tests/test_contract_retro.py:23-24`), and it has no count of spent budgets.

There's also a fact about run scope. In this repo's session dir `40816bb1`, `reports/design/` holds `design-judge.md` to `design-judge-7.md`, and `reports/protocol/` holds `protocol-judge.md` to `-4.md`, all from earlier runs that used the same crew names (`ls` of that dir, 2026-10-27). Counting a crew's judge files by name alone would start run 3's `design` and `protocol` crews with their budgets already spent. "The highest-numbered judge file" would also name a stale file. ADR-0003 flagged this as open.

## Decision

### 1. Plan v2

`plan.schema.json` describes versions 1 and 2. A v1 plan is still valid, and the edeb6ef `plan.example.json` is valid byte for byte.

- `title` becomes `foundry plan.json, versions 1 and 2`.
- `version` becomes `{"enum": [1, 2]}`. Its description: the plan file format version; it goes up whenever a field is added; readers gate on `version >= 2`, never `=== 2`, so a later version inherits every v2 rule.
- New top-level property `repairBudget`: `{"type": "integer", "minimum": 0}`. It is how many fresh judges a crew may start after judge FAILs in this run (section 5). The architect copies it from `.claude/foundry.json` `repairBudget`, or writes 2 when the key is absent.
- `required` is unchanged: it still lists v1's eight keys. Two `allOf` entries are added:
  - `if {"properties": {"version": {"const": 2}}, "required": ["version"]} then {"required": ["repairBudget"]}`;
  - `if {"properties": {"version": {"const": 1}}, "required": ["version"]} then {"not": {"required": ["repairBudget"]}}`.
- **No per-crew override.** Nothing in this run sets different budgets per crew, so a crew field would have no caller (repo P11). The budget is the same for every crew. A per-crew budget, like readiness, waits for a later version.
- From 0.5.0 the architect writes `version: 2` with `repairBudget`. `plan.example.json` becomes a v2 plan with `"repairBudget": 2`. `tests/fixtures/contract-050/plan-v1.json` is a byte copy of `git show edeb6ef:plugins/foundry/docs/plan.example.json`.

**What the hooks read.** `Plan` (`register.ts:250`) gains two fields, `version: unknown` and `repairBudget: unknown`. `parsePlan` copies both unchecked from the parsed object, as it does the other fields. It accepts every value of `version`, missing included: v1, v2, v3 or a string. Every rule this ADR adds asks `planAtLeastV2` first (section 8). That helper is true only when `version` is an integer of 2 or more, so it holds for v3 plans, and v1 plans, plans with no version and plans with a non-integer version fail open to 0.4.3 behaviour. The 0.3.0 plan gates don't look at `version` at all.

### 2. `.claude/foundry.json` gains `repairBudget`

`foundry-config.schema.json` gets the property `repairBudget`: `{"type": "integer", "minimum": 0}`, with the description `How many fresh judges a crew may start after judge FAILs in one run, copied into a v2 plan.json. Default 2.` The schema states defaults in descriptions, as it did for `agentCap` (retired in 0.7.0, see ADR-0001). The default is 2; it is written by the owner, or by `foundry:init` on approval, which proposes it with the 0.4.0 keys. A rejected value is reported and unset, as ADR-0002 rules for every key, so the architect falls back to 2.

### 3. The literals

Each literal below is written once, here. The prompts (`agents/judge.md`, `agents/lead.md`, `skills/run/SKILL.md`) and the hooks use exactly these strings. `tests/gates.check.ts` asserts the prompts carry them, and `tests/contract-gates.test.ts` asserts the hooks' constants equal them. The constant name is the export from `hooks/register.ts`.

| Constant | Literal | Who writes it, and where |
| --- | --- | --- |
| `HEAD_LINE` | `Head: ` | The judge, under `## Proof checked`: one line, the literal and then the 40 lowercase hex digits of `git rev-parse <crew branch>` at the head it ruled on. |
| `PATCH_LINE` | `Patch: ` | The judge, under `## Proof checked`: one line, the literal and then the first field (40 lowercase hex digits) that `PATCH_COMMAND` prints. |
| `EXAMINED` | `## Examined` | The lead, as a heading of its final report: what the crew checked, each item with its scope. |
| `NOT_EXAMINED` | `## Not examined` | The lead, as a heading of its final report: what nobody checked, or `None.` |
| `UNSCOPED` | `- UNSCOPED: ` | The judge, as a line under `## Findings`: an absence or completeness claim that states no scope. |
| `BUDGET_BLOCKED` | `BLOCKED: repair budget spent` | The lead: the start of its message to `main` (and of its report) when the crew's budget is spent. It starts with `BLOCKED:`, so the 0.4.0 tag rules apply to it unchanged. |
| `BUDGET_SPENT_EVENT` | `budget-spent` | The hooks: the `event` value of the `events.jsonl` line that records a spent budget (section 5). retro counts these lines. |

`PATCH_COMMAND`, the one command both the judge and the hooks use to compute a patch id:

```
git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable
```

`<base>` is the commit the crew's change is measured from: the target head last merged in: the base commit in the lead's brief until the lead first runs `git merge <target>` into the crew branch, then the target head of its latest such merge (amended 2026-10-28 by repo [ADR-0015](../../../../docs/adr/0015-agent-worktree-cleanup.md), item 11: leads merge the target in and never rebase). Because the crew branch then contains `<base>`, `<base>...<head>` is the crew's net change on top of the target. The flags pin the diff text against the user's git config (colour, external diff tools, rename detection, `diff.noprefix`), so the judge's shell and the hook's argv produce the same id. Each line is matched in full: the literal at column 0, then exactly 40 characters of `[0-9a-f]`, then nothing but spaces or tabs. A judge that writes uppercase hex, a short SHA or a 64-digit SHA-256 id gets no match (section 6 says what follows).

### 4. Scope-bounded claims

- **Lead.** On a v2 or later plan, the lead's final report has two more sections, `EXAMINED` and `NOT_EXAMINED`, after `## Checks run` and before `## Open questions`. Under the first, each line is `- <what>: <scope>`, where the scope names the paths or globs and the command or search that covered it (for example `` - callers of planVerdict: `grep -rn planVerdict plugins/` ``). Under the second goes what no one checked, or `None.`.
- **Judge.** Every claim of absence or completeness ("no other caller", "all call sites updated", "nothing else reads it") in the lead's report or a member's proof must state its scope, inside `EXAMINED` or beside the claim. One that doesn't gets a finding line made of `UNSCOPED`, then the claim and where it appears, and the verdict is FAIL. A PASS that carries such a finding is inconsistent, and the head guard (section 6) treats it as no PASS.
- **Hook: yes, the lead stop gate checks both headings.** On a v2 or later plan, a lead's untagged stop text that would pass by its `## Proof` section is sent back unless it has both headings. A heading counts only at the start of a line, matched in full: the literal, then nothing but spaces or tabs. The gate checks that the headings are present, not their content or order. Tagged stops (`CHECKPOINT:`, `BLOCKED:`, `QUESTION:`, `PROPOSAL:`) are exempt, as before.

### 5. The bounded repair loop

**What the budget counts.** `repairBudget` is the number of fresh judges a crew may start after judge FAILs. A crew's FAIL count is the number of its **this-run judge files** whose first non-empty line starts `VERDICT: FAIL` (`judgeRuling`, which strips a BOM and `\r` and then applies `markerOf`). A this-run judge file is one that meets all of these:

- it sits in `reports/<crew>/`, where `<crew>` is the hooks' crew name (the lead's name, so a successor `auth-2` has its own folder and its own count);
- it is a judge file by `isJudgeFile` and isn't an interim file;
- its modification time is at or after the plan's `approvedAt` (`runStart`).

The time filter is what keeps the stale files from earlier runs (see Context) out of the count. Red-team files (`<crew>-redteam*`) never count.

The budget is **spent** when the FAIL count is greater than `repairBudget`. With the default of 2: a FAIL, then `-judge-2` FAILs, then `-judge-3` may still start (2 FAILs, budget 2); if it FAILs too, the budget is spent. With 0, the first FAIL spends it. Run 3's own "one fresh judge, then BLOCKED" corresponds to 1.

**The spawn gate.** On a v2 or later plan with a valid budget, an `Agent` call from inside a crew whose `name` is a judge name of the caller's crew (`isJudgeName`) is refused once the budget is spent. A refused call appends no `spawn` line, as with every refusal (ADR-0003). A judge started without a name isn't gated: its report lands on an id-named file, which is never a merge-gate file. A spent budget never moves anyone up an effort level (ADR-0011 amendment).

**The spent-budget record.** It is written in two places, and has two literals:

1. **events.jsonl, by the hooks.** When a judge report is saved for a crew (`writeReport`, after its `report` line), on a v2 or later plan with a valid budget, the hooks recount. If the report's marker is `VERDICT: FAIL` and the crew's FAIL count after the write leaves the budget spent, they append one line:

   ```
   {"v": 1, "ts": "<ISO time>", "event": "<BUDGET_SPENT_EVENT>", "crew": "<crew>", "agent": "<that judge's spawn name>"}
   ```

   The line carries those five keys and no others. `v` stays 1, because ADR-0003 bumps `v` only for a renamed or retyped field, and this is a new event kind. `events.schema.json` adds the value to `event`'s enum, with an `if`/`then` branch whose `additionalProperties: false` allows only the five keys. A crew may get the line more than once: a later FAIL past the budget, or the same report saved twice, would add another. Readers count distinct crews, not lines. A failed append behaves as in ADR-0003, section 1.
2. **The lead's message to main.** Once the judge's FAIL report leaves the budget spent, the lead starts no more judges. It sends `main` a message that starts with `BUDGET_BLOCKED`, followed by `: <crew>, <n> judge FAILs, repairBudget <b>`, then the last judge's findings, and stops with the same text. The foreman takes it to the owner or re-plans (a successor lead starts a fresh count, and the foreman logs that decision). It never raises the judge's effort to get past the limit.

retro counts only the events line (section 7), because events lines hold no report text (repo P8).

### 6. The head guard and a patch-bound PASS

**The judge** writes `HEAD_LINE` and `PATCH_LINE` under `## Proof checked`, first in that section, on every ruling, in every merge mode, the integration judge's included. `<base>` for `PATCH_COMMAND` comes from the lead's brief. With an empty diff, `git patch-id` prints nothing, so there is no patch line, and the guard treats the ruling as having no head lines.

**The lead's Branch line.** The first non-empty line under `## Branch` keeps the 0.4.3 form, `<crew branch> at <commit>, based on <base commit>.`. Each of the three may be wrapped in single backticks. `<base commit>` is the target head last merged in: the brief's base until the lead first merges the target into the crew branch, then the target head of its latest `git merge <target>` (repo ADR-0015, item 11; it was "the target head the branch was rebased onto" before leads stopped rebasing). `branchOf` reads the branch and the base from it. Neither may start with `-`, so neither can reach git as an option.

**The guard**, in the lead stop gate, applies on a v2 or later plan to an untagged stop text that would pass by its `## Proof` section and has both of section 4's headings. It reads the crew's **latest this-run judge file** (`latestJudge`: the newest modification time at or after `runStart`, ties going to the higher `-judge-<k>`) and parses it with `judgeRuling`. When `branchOf` reads the lead's Branch line, the hook runs, with `cwd` the session's working directory and `timeoutMs: 15_000` on each call:

- `git rev-parse --verify --quiet <branch>^{commit}` to get the head;
- only when that head differs from the judge's `HEAD_LINE` value, the two halves of `PATCH_COMMAND` with `<head>` set to `<branch>`: `git diff …` with its stdout passed as `stdin` to `git patch-id --stable`, with `patchIdOf` taking the id.

A non-zero exit, a timeout or an unparsable output gives `undefined`. The verdict is `headVerdict`:

| Case | Result |
| --- | --- |
| no this-run judge file, its verdict isn't PASS, or it carries an `UNSCOPED` finding | sent back with `NO_PASS_REASON` |
| PASS without both a head line and a patch line | sent back with `NO_HEAD_REASON` |
| head unknown (no Branch line, or git failed) | goes through (fail open) |
| head equals the judged head | goes through |
| head moved, patch id unknown | goes through (fail open) |
| head moved, patch id equals the judged patch | goes through: the PASS survives the merge of the target |
| head moved, patch id differs | sent back with `headMovedReason(judged head, head)` |

These send-backs count in the same streak as `LEAD_STOP_REASON`, so after `LEAD_STOP_BLOCKS` (2) in a row the next stop goes through, as in 0.4.3. An unanswered tag doesn't excuse them: the text is a final report, not a question. If reading the judge folder throws, or anything else in the step does, the step is skipped and the stop goes through (`safely`).

**A patch-bound PASS across a merge of the target.** (Amended 2026-10-28 by repo ADR-0015, item 11: leads make a branch ready with `git merge <target>` into the crew branch, a real merge, never a rebase or cherry-pick, and the foreman still runs `git merge --ff-only`.) The patch-id carry stays. The judge's `PATCH_LINE` is computed with `<base>` from the Branch line it was given; after the lead merges the target in, the Branch line's `<base>` is the new target head, and `PATCH_COMMAND` measures the crew's net change against it. A merge that touched none of the crew's hunks gives the same id. A PASS stands for the merged head when `PATCH_COMMAND` gives the same id the judge wrote, and the checks from the brief pass again on the merged head, listed under `## Checks run`. Then no fresh judge is needed. Otherwise the merged head needs a fresh judge, as in 0.4.3. The hook can see the patch id but can't run checks, so the lead (section 12 of its prompt) and the foreman's merge gate both require the re-run. **The foreman's merge gate** (`skills/run/SKILL.md`, merge section) uses the same file and the same rule. The file is the crew's newest judge file modified at or after `approvedAt`, which replaces "highest-numbered" and closes ADR-0003's open item for the gate. The ruling must be a PASS with no `UNSCOPED` line. Its `HEAD_LINE` value must equal `git rev-parse <crew branch>`, or its `PATCH_LINE` value must equal `PATCH_COMMAND`'s id with the lead's checks re-run green after the merge of the target.

**The hand-back path.** A lead's hand-back is saved as its report only if it passes `leadStopPasses` and `examinedVerdict`. The head guard runs only in the stop gate, since it calls git. A hand-back the guard then sends back stays in the report file until the lead's next stop overwrites it.

### 7. The hooks' half of the effort ladder

On a v2 or later plan, an `Agent` call from the main session (`callerId` undefined) whose `subagent_type` starts with `foundry:` is refused when it sets no `model` (`MAIN_MODEL_REFUSAL`), or when `effort` isn't one of `low`, `medium`, `high`, `xhigh` (`MAIN_EFFORT_REFUSAL`; `max` included). The model check runs first. This check runs before the plan gates. With no foundry dir or no `plan.json` (the plan-mode architect starts before one exists, and so does init's architect), the call goes through, as with every v2 rule. Inside a crew, `agentVerdict` and `effortVerdict` are unchanged. The hooks don't refuse `high` or `xhigh` anywhere, because they can't see whether the owner asked for it. That stays a prompt rule (ADR-0011 amendment), and retro measures it (section 8).

### 8. retro

- **`budgetsSpent`**, a new **per-run** key in `runs[]`, after `judges`. Its value is the number of distinct `crew` values among the run's spent-budget events (section 5), assigned to runs by `ts` like every other event. It is `"not recorded"` when the run's event-derived categories are `"not recorded"` (no `## Run` heading, or no `events*.jsonl`), and also when the run has no such line. A 0.4.x log and a 0.5.0 run that spent no budget look the same in the log, so retro never claims a zero the log can't back up. It is never 0.
- **`retro` stays 1.** Adding a key isn't a rename or a retype; the same rule as events' `v`.
- **Event lines.** Spawn lines gain no keys. They stay `agent, agentId, by, crew, effort, event, model, ts, type, v` (`tests/events.test.ts:67`). The only new line is section 5's, with the keys `agent, crew, event, ts, v`.
- **Target share.** The retro skill computes the share of the run's spawns that ran on Opus at `high` or `xhigh`. The numerator is the sum of the `byModelEffort` counts whose model part contains `opus` (case-folded) and whose effort part is `high` or `xhigh`. The denominator is `spawns.total`. The target is 0, unless a decision line in `decisions.md` records the owner's call for `high` or `xhigh`. The skill reports any other non-zero share as over target. retro's output gains no key for it.

### 9. Exported functions and constants

All are exported from `hooks/register.ts` and are pure: no I/O and no clock. The handlers do the reads, then call them. `tests/contract-gates.test.ts` imports these names; they are binding.

```ts
export type JudgeFile = { name: string; text: string; mtimeMs: number }
export type JudgeRuling = { verdict: 'PASS' | 'FAIL' | undefined; head: string | undefined; patch: string | undefined; unscoped: number }

// true when plan.version is an integer >= 2; false for undefined, v1, missing or non-integer versions
export function planAtLeastV2(plan: Plan | undefined): boolean
// plan.repairBudget when planAtLeastV2 and it is an integer >= 0; else undefined (no budget rule)
export function repairBudgetOf(plan: Plan | undefined): number | undefined
// Date.parse(plan.approvedAt) when it is a string that parses to a finite number; else undefined
export function runStart(plan: Plan | undefined): number | undefined
// name is a non-empty string and isJudgeFile(crew, `${safeName(name)}.md`)
export function isJudgeName(crew: string, name: unknown): boolean
// files with isJudgeFile(crew, f.name), !isInterimFile(f.name), f.mtimeMs >= since, judgeRuling(f.text).verdict === 'FAIL'
export function judgeFails(crew: string, files: readonly JudgeFile[], since: number): number
// among files with isJudgeFile, not interim, mtimeMs >= since: the greatest mtimeMs, ties to the higher -judge-<k> (bare = 1)
export function latestJudge(crew: string, files: readonly JudgeFile[], since: number): JudgeFile | undefined
// repairBudgetOf(plan) !== undefined && fails > repairBudgetOf(plan)
export function budgetSpent(plan: Plan | undefined, fails: number): boolean
// { deny: budgetRefusal(crew, fails, budget) } when isJudgeName(crew, name) && budgetSpent(plan, fails); else undefined
export function judgeBudgetVerdict(plan: Plan | undefined, crew: string, name: unknown, fails: number): { deny: string } | undefined
export function budgetRefusal(crew: string, fails: number, budget: number): string
// BOM and \r stripped. verdict from markerOf; head and patch: the first full-line match of HEAD_LINE / PATCH_LINE
// (section 3) between the "## Proof checked" line and the next line starting "## "; unscoped: lines starting
// UNSCOPED between the "## Findings" line and the next line starting "## "
export function judgeRuling(text: string): JudgeRuling
// the first whitespace-separated field of the first line when it is 40 [0-9a-f]; else undefined
export function patchIdOf(stdout: string): string | undefined
// the first non-empty line under "## Branch", as section 6 reads it; undefined when it doesn't match
export function branchOf(report: string): { branch: string; base: string } | undefined
// { block: EXAMINED_REASON } on a v>=2 plan when the untagged text lacks either heading (section 4); else undefined
export function examinedVerdict(plan: Plan | undefined, text: string): { block: string } | undefined
// section 6's table; undefined (goes through) whenever !planAtLeastV2(plan)
export function headVerdict(plan: Plan | undefined, judge: JudgeRuling | undefined, head: string | undefined, patch: string | undefined): { block: string } | undefined
export function headMovedReason(judged: string, head: string): string
// section 7; undefined unless planAtLeastV2(plan), callerId === undefined and type is a string starting "foundry:"
export function mainCallVerdict(plan: Plan | undefined, callerId: string | undefined, type: unknown, model: unknown, effort: unknown): { deny: string } | undefined
```

In `judgeRuling`, a section heading line is matched after trailing spaces and tabs are trimmed. `examinedVerdict`'s untagged test is the same as `leadStopPasses`'s tag list: the trimmed text starts with none of `CHECKPOINT:`, `BLOCKED:`, `QUESTION:`, `PROPOSAL:`. `branchOf`'s pattern, applied to the trimmed line:

```
^`?([^\s`-][^\s`]*)`? at `?[0-9a-f]{7,40}`?, based on `?([^\s`-][^\s`]*?)`?\.?$
```

The reasons and refusals. Constants are exact strings; functions are templates over the constants and their arguments:

```ts
export const PATCH_COMMAND = 'git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable'
export const BUDGET_REFUSAL = `${MARK} Refused: repair budget spent:`
// budgetRefusal(crew, fails, budget) =
//   `${BUDGET_REFUSAL} ${crew} has ${fails} judge FAILs this run and repairBudget is ${budget}. Start no more judges: send main a message that starts with "${BUDGET_BLOCKED}", with the last judge's findings.`
export const NO_PASS_REASON = `${MARK} Not done yet: the crew's latest judge file this run is not a clean VERDICT: PASS. Send your final report only after a judge's PASS with no UNSCOPED finding, or start your final message with BLOCKED: or CHECKPOINT:.`
export const NO_HEAD_REASON = `${MARK} Not done yet: the crew's latest judge PASS has no "${HEAD_LINE.trim()}" and "${PATCH_LINE.trim()}" lines under ## Proof checked, so no hook can tell which head it ruled on. Start a fresh judge under the next unused name.`
export const HEAD_MOVED = `${MARK} Not done yet: the head moved:`
// headMovedReason(judged, head) =
//   `${HEAD_MOVED} the judge ruled on ${judged}, the branch is at ${head}, and its patch id differs. Start a fresh judge under the next unused name on ${head}, and send your final report on its PASS.`
export const EXAMINED_REASON = `${MARK} Not done yet: on this plan your final report also needs the sections "${EXAMINED}" (what the crew checked, each with its scope) and "${NOT_EXAMINED}" (what nobody checked, or None.), each a heading of its own.`
export const MAIN_MODEL_REFUSAL = `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`model\`: "opus" or "sonnet". Call Agent again with model set.`
export const MAIN_EFFORT_REFUSAL = `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`effort\` to "low", "medium", "high" or "xhigh": "medium" by default, "high" or "xhigh" only on the owner's call. Call Agent again with effort set.`
```

The `FoundryEvent` union gains the spent-budget member `{ event: typeof BUDGET_SPENT_EVENT; crew: string; agent: string }`. Each refusal or send-back logs one debug line under `foundry:` that names the rule and the crew or agent type, never report text (repo P7, P8).

## Seams

The contract tests read only `plugins/foundry/tests/fixtures/contract-050/**` or data built inline, and they import `tests/harness.ts`, which the design crew owns.

1. **The plan schema.** `ajv` (draft 2020, `ajv-formats`) validates `docs/plan.example.json` (v2, integer `repairBudget`) and `tests/fixtures/contract-050/plan-v1.json` (a byte copy of the edeb6ef example) against `docs/plan.schema.json`. A v1 plan with `repairBudget` and a v2 plan without it both fail.
2. **Pure gates**, in `tests/contract-gates.test.ts`, which imports the names in section 9:
   - Each literal constant in section 3 equals its string there.
   - `planAtLeastV2` is true for versions 2 and 3, and false for 1, a missing version and `"2"`. Each rule below returns `undefined` on a v1 plan built inline, and gives the same result on a v3 plan as on a v2 one.
   - `judgeFails` and `latestJudge` ignore files older than `since`, red-team files and interim files. `budgetSpent` is false at fails equal to the budget and true at one more. `judgeBudgetVerdict` denies with `BUDGET_REFUSAL` as its prefix only for a judge name.
   - `judgeRuling` reads the head and patch lines only under `## Proof checked`, and counts `UNSCOPED` lines only under `## Findings`.
   - `headVerdict` covers every row of section 6's table.
   - `examinedVerdict` blocks a final report missing either heading and passes tagged stops.
   - `mainCallVerdict` refuses a `foundry:judge` call with no model or no effort from the main session, and lets the same call from inside a crew, a non-`foundry:` type, or a call with no plan go through.
3. **Prompts**, in `tests/gates.check.ts`. `agents/judge.md` carries `HEAD_LINE`, `PATCH_LINE` and `UNSCOPED`. `agents/lead.md` carries `EXAMINED`, `NOT_EXAMINED` and `BUDGET_BLOCKED`. `skills/run/SKILL.md` carries the head and patch merge-gate rule. `agents/writer.md` pins a model and an effort of `low` or `medium`.
4. **retro**, in `tests/test_contract_retro_050.py`, on a fixture under `contract-050/` that has a `## Run` heading and spent-budget lines for two crews, one of them twice. Its `budgetsSpent` is 2. A run with events but no such line gives `"not recorded"`. `tests/test_contract_retro.py` adds `budgetsSpent` to `RUN_KEYS`, and `retro` stays 1.
5. **Spawn line keys.** `tests/events.test.ts:67` is unchanged; this ADR adds no spawn key.

## Consequences

- One merge of the target no longer costs one judge when the crew's patch doesn't change. A merge that resolves a conflict in the crew's hunks changes the patch id and still needs a fresh judge. (Written for rebases in run 3; amended for real merges by repo ADR-0015.)
- A crew stops at `repairBudget + 1` FAILs and goes to the foreman, instead of looping. A successor lead gets a fresh count. The foreman's decision to start one is the extra spend, and it is logged.
- The guard and the budget trust file modification times against `approvedAt`. A re-approval that rewrites `approvedAt` mid-run resets every count. A clock that runs behind the file system would hide this run's files and fail open, not closed.
- The judge's file can't prove the patch line was computed from the right base. The guard only compares ids. A judge that used the wrong base gets a mismatch, and the lead a send-back, never a wrong merge.
- Every main-session `foundry:*` call on a v2 plan pays one `plan.json` read. A judge-named spawn inside a crew, and each lead final report, pay one directory listing and the reads of this run's judge files. A lead final report whose head moved also pays up to three git calls.
- `events.jsonl` gains a new event kind with `v` still 1. A 0.4.x retro reading a 0.5.0 log ignores the event kind it doesn't know.
- Open: hosts whose git uses SHA-256 object ids write 64-digit heads. The literals' 40-digit rule fails those, and the guard sends the lead back twice and then lets it through. Not decided here.
