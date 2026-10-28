import { expect } from 'claude-code/testing'

import * as R from '../hooks/register.ts'
import { agent, handBack, ROOT, startSession, test, world } from './harness'

// Contract test for foundry ADR-0004 "Seams" 2 and 5 (section 9 names are binding): the pure gates of the
// bounded repair loop, the head guard, the scope-bounded claims and the main-session effort rules, plus the
// handler behaviour the ADR fixes (spent-budget line, spawn gate, main-session refusal).
// Written before the producer exists. It imports the hooks as a namespace and checks `typeof` inside each
// test, so on old code a test fails on "R.x is not a function", never on an import error.
// Literals pinned verbatim (ADR-0004 section 3): `Head: `, `Patch: `, `## Examined`, `## Not examined`,
// `- UNSCOPED: `, `BLOCKED: repair budget spent`.

const MARK = '[foundry]'
const HEAD_LINE = 'Head: '
const PATCH_LINE = 'Patch: '
const EXAMINED = '## Examined'
const NOT_EXAMINED = '## Not examined'
const UNSCOPED = '- UNSCOPED: '
const BUDGET_BLOCKED = 'BLOCKED: repair budget spent'
const PATCH_COMMAND = 'git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable'

const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const P1 = '1'.repeat(40)
const P2 = '2'.repeat(40)
const APPROVED = '2026-10-17T11:00:00Z'
const SINCE = Date.parse(APPROVED)

// pull one export out of the namespace; a missing one fails on this assertion
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = (name: string): any => {
  const v = (R as Record<string, unknown>)[name]
  expect(typeof v === 'function' ? 'function' : `R.${name} is not a function`).toBe('function')
  return v
}
const constant = (name: string): unknown => (R as Record<string, unknown>)[name]

const plan = (version: unknown, extra: Record<string, unknown> = {}) => ({ version, goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, repairBudget: 2, crews: [], ...extra }) as never
const V1 = plan(1)
const V2 = plan(2)
const V3 = plan(3)

const jf = (name: string, text: string, mtimeMs = SINCE + 1000) => ({ name, text, mtimeMs })
const ruling = (over: Record<string, unknown> = {}) => ({ verdict: 'PASS', head: H1, patch: P1, unscoped: 0, ...over }) as never

test('section 3: every literal constant equals the ADR string', () => {
  expect(constant('HEAD_LINE')).toBe(HEAD_LINE)
  expect(constant('PATCH_LINE')).toBe(PATCH_LINE)
  expect(constant('EXAMINED')).toBe(EXAMINED)
  expect(constant('NOT_EXAMINED')).toBe(NOT_EXAMINED)
  expect(constant('UNSCOPED')).toBe(UNSCOPED)
  expect(constant('BUDGET_BLOCKED')).toBe(BUDGET_BLOCKED)
  expect(constant('BUDGET_SPENT_EVENT')).toBe('budget-spent')
  expect(constant('PATCH_COMMAND')).toBe(PATCH_COMMAND)
})

test('section 9: reasons and refusals are the ADR strings', () => {
  expect(constant('BUDGET_REFUSAL')).toBe(`${MARK} Refused: repair budget spent:`)
  expect(constant('NO_PASS_REASON')).toBe(
    `${MARK} Not done yet: the crew's latest judge file this run is not a clean VERDICT: PASS. Send your final report only after a judge's PASS with no UNSCOPED finding, or start your final message with BLOCKED: or CHECKPOINT:.`,
  )
  expect(constant('NO_HEAD_REASON')).toBe(
    `${MARK} Not done yet: the crew's latest judge PASS has no "Head:" and "Patch:" lines under ## Proof checked, so no hook can tell which head it ruled on. Start a fresh judge under the next unused name.`,
  )
  expect(constant('HEAD_MOVED')).toBe(`${MARK} Not done yet: the head moved:`)
  expect(constant('EXAMINED_REASON')).toBe(
    `${MARK} Not done yet: on this plan your final report also needs the sections "## Examined" (what the crew checked, each with its scope) and "## Not examined" (what nobody checked, or None.), each a heading of its own.`,
  )
  expect(constant('MAIN_MODEL_REFUSAL')).toBe(
    `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`model\`: "opus" or "sonnet". Call Agent again with model set.`,
  )
  expect(constant('MAIN_EFFORT_REFUSAL')).toBe(
    `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`effort\` to "low", "medium", "high" or "xhigh": "medium" by default, "high" or "xhigh" only on the owner's call. Call Agent again with effort set.`,
  )
})

test('planAtLeastV2: true for integer versions 2 and 3; false for 1, missing, "2", non-integers and no plan', () => {
  const f = fn('planAtLeastV2')
  expect(f(V2)).toBe(true)
  expect(f(V3)).toBe(true)
  expect(f(plan(10))).toBe(true)
  expect(f(V1)).toBe(false)
  expect(f(plan(undefined))).toBe(false)
  expect(f(plan('2'))).toBe(false)
  expect(f(plan(2.5))).toBe(false)
  expect(f(plan(null))).toBe(false)
  expect(f(undefined)).toBe(false)
})

test('repairBudgetOf: the integer budget on a v>=2 plan; undefined otherwise', () => {
  const f = fn('repairBudgetOf')
  expect(f(plan(2, { repairBudget: 0 }))).toBe(0)
  expect(f(plan(2, { repairBudget: 3 }))).toBe(3)
  expect(f(plan(3, { repairBudget: 1 }))).toBe(1)
  expect(f(plan(1, { repairBudget: 2 }))).toBeUndefined()
  expect(f(plan(2, { repairBudget: undefined }))).toBeUndefined()
  expect(f(plan(2, { repairBudget: -1 }))).toBeUndefined()
  expect(f(plan(2, { repairBudget: 1.5 }))).toBeUndefined()
  expect(f(plan(2, { repairBudget: '2' }))).toBeUndefined()
  expect(f(undefined)).toBeUndefined()
})

test('runStart: Date.parse(approvedAt) when it parses; else undefined', () => {
  const f = fn('runStart')
  expect(f(plan(2))).toBe(SINCE)
  expect(f(plan(2, { approvedAt: null }))).toBeUndefined()
  expect(f(plan(2, { approvedAt: 'yesterday-ish' }))).toBeUndefined()
  expect(f(plan(2, { approvedAt: 12345 }))).toBeUndefined()
  expect(f(undefined)).toBeUndefined()
})

test("isJudgeName: only the crew's own judge names", () => {
  const f = fn('isJudgeName')
  expect(f('auth', 'auth-judge')).toBe(true)
  expect(f('auth', 'auth-judge-2')).toBe(true)
  expect(f('auth', 'auth-judge-12')).toBe(true)
  expect(f('auth', 'auth-redteam')).toBe(false)
  expect(f('auth', 'auth-judge-x')).toBe(false)
  expect(f('auth', 'billing-judge')).toBe(false)
  expect(f('auth', 'auth-builder')).toBe(false)
  expect(f('auth', '')).toBe(false)
  expect(f('auth', undefined)).toBe(false)
  expect(f('auth', 42)).toBe(false)
})

test('judgeFails: counts this-run FAIL judge files only; stale, red-team, interim, PASS and other crews do not count', () => {
  const f = fn('judgeFails')
  const files = [
    jf('auth-judge.md', 'VERDICT: FAIL\nx'),
    jf('auth-judge-2.md', '﻿VERDICT: FAIL\r\nx'),
    jf('auth-judge-3.md', 'VERDICT: PASS\nx'),
    jf('auth-judge-4.md', 'VERDICT: FAIL', SINCE - 1),
    jf('auth-judge-5.interim.md', 'VERDICT: FAIL'),
    jf('auth-redteam.md', 'VERDICT: FAIL'),
    jf('auth-redteam-2.md', 'REDTEAM\nVERDICT: FAIL'),
    jf('billing-judge.md', 'VERDICT: FAIL'),
    jf('auth-builder.md', 'VERDICT: FAIL'),
  ]
  expect(f('auth', files, SINCE)).toBe(2)
  expect(f('auth', [], SINCE)).toBe(0)
  expect(f('auth', files, SINCE + 5000)).toBe(0)
  expect(f('auth', files, SINCE - 10)).toBe(3)
})

test('latestJudge: newest mtime at or after since; ties go to the higher -judge-<k>; red-team, interim and stale ignored', () => {
  const f = fn('latestJudge')
  const t = SINCE + 1000
  expect(f('auth', [], SINCE)).toBeUndefined()
  expect(f('auth', [jf('auth-judge.md', 'a', SINCE - 1)], SINCE)).toBeUndefined()
  expect(f('auth', [jf('auth-judge.md', 'a', t), jf('auth-judge-2.md', 'b', t + 5)], SINCE)?.name).toBe('auth-judge-2.md')
  expect(f('auth', [jf('auth-judge-2.md', 'b', t), jf('auth-judge.md', 'a', t + 5)], SINCE)?.name).toBe('auth-judge.md')
  // tie: bare name counts as 1
  expect(f('auth', [jf('auth-judge-2.md', 'b', t), jf('auth-judge.md', 'a', t)], SINCE)?.name).toBe('auth-judge-2.md')
  expect(f('auth', [jf('auth-judge.md', 'a', t), jf('auth-judge-10.md', 'b', t), jf('auth-judge-9.md', 'c', t)], SINCE)?.name).toBe('auth-judge-10.md')
  expect(f('auth', [jf('auth-judge.md', 'a', t), jf('auth-judge.interim.md', 'i', t + 9), jf('auth-redteam.md', 'r', t + 9), jf('billing-judge.md', 'z', t + 9)], SINCE)?.name).toBe('auth-judge.md')
})

test('budgetSpent: false at fails equal to the budget, true at one more, false with no budget rule', () => {
  const f = fn('budgetSpent')
  expect(f(V2, 2)).toBe(false)
  expect(f(V2, 3)).toBe(true)
  expect(f(plan(2, { repairBudget: 0 }), 0)).toBe(false)
  expect(f(plan(2, { repairBudget: 0 }), 1)).toBe(true)
  expect(f(V3, 3)).toBe(true)
  expect(f(V1, 99)).toBe(false)
  expect(f(plan(2, { repairBudget: undefined }), 99)).toBe(false)
  expect(f(undefined, 99)).toBe(false)
})

test('budgetRefusal and judgeBudgetVerdict: BUDGET_REFUSAL prefix, only for a judge name of the crew', () => {
  const refusal = fn('budgetRefusal')
  const text = `${MARK} Refused: repair budget spent: auth has 3 judge FAILs this run and repairBudget is 2. Start no more judges: send main a message that starts with "${BUDGET_BLOCKED}", with the last judge's findings.`
  expect(refusal('auth', 3, 2)).toBe(text)
  const f = fn('judgeBudgetVerdict')
  expect(f(V2, 'auth', 'auth-judge-4', 3)).toEqual({ deny: text })
  expect(f(V3, 'auth', 'auth-judge-4', 3)).toEqual({ deny: text })
  expect(f(V2, 'auth', 'auth-judge-4', 2)).toBeUndefined()
  expect(f(V2, 'auth', 'auth-builder', 3)).toBeUndefined()
  expect(f(V2, 'auth', 'auth-redteam', 3)).toBeUndefined()
  expect(f(V2, 'auth', undefined, 3)).toBeUndefined()
  expect(f(V1, 'auth', 'auth-judge-4', 99)).toBeUndefined()
  expect(f(undefined, 'auth', 'auth-judge-4', 99)).toBeUndefined()
})

const REPORT = (proof: string, findings: string) => `VERDICT: PASS\n\n## Proof checked\n${proof}\n\n## Findings\n${findings}\n\n## Other\n`

test('judgeRuling: verdict from the marker; head and patch only under ## Proof checked; UNSCOPED only under ## Findings', () => {
  const f = fn('judgeRuling')
  expect(f(REPORT(`${HEAD_LINE}${H1}\n${PATCH_LINE}${P1}`, 'None.'))).toEqual({ verdict: 'PASS', head: H1, patch: P1, unscoped: 0 })
  expect(f(`﻿VERDICT: FAIL\r\n\r\n## Proof checked\r\n${HEAD_LINE}${H1}\r\n${PATCH_LINE}${P1}\r\n`)).toEqual({ verdict: 'FAIL', head: H1, patch: P1, unscoped: 0 })
  // lines outside the section do not count
  const outside = `VERDICT: PASS\n${HEAD_LINE}${H2}\n\n## Findings\n${HEAD_LINE}${H2}\n\n## Proof checked\n${HEAD_LINE}${H1}\n\n## Later\n${PATCH_LINE}${P2}\n`
  expect(f(outside)).toEqual({ verdict: 'PASS', head: H1, patch: undefined, unscoped: 0 })
  // the first full-line match wins
  expect(f(REPORT(`${HEAD_LINE}${H1}\n${HEAD_LINE}${H2}`, 'None.')).head).toBe(H1)
  // full-line matches only: uppercase, short, 64 digits and trailing junk get none
  for (const bad of ['A'.repeat(40), 'a'.repeat(7), 'a'.repeat(64), `${H1} extra`, `${H1}x`]) {
    expect(f(REPORT(`${HEAD_LINE}${bad}`, 'None.')).head).toBeUndefined()
  }
  expect(f(REPORT(`${HEAD_LINE}${H1}  \t`, 'None.')).head).toBe(H1)
  expect(f(REPORT(`  ${HEAD_LINE}${H1}`, 'None.')).head).toBeUndefined()
  expect(f(REPORT(`${HEAD_LINE}${H1}`, `${UNSCOPED}no other caller (in the lead's report)\n${UNSCOPED}all call sites updated (proof)`)).unscoped).toBe(2)
  expect(f(`VERDICT: PASS\n${UNSCOPED}x\n\n## Proof checked\n${UNSCOPED}y\n\n## Findings\nNone.\n`).unscoped).toBe(0)
  // a heading with trailing spaces or tabs still matches
  expect(f(`VERDICT: PASS\n\n## Proof checked \t\n${HEAD_LINE}${H1}\n`).head).toBe(H1)
  expect(f('no marker here').verdict).toBeUndefined()
})

test('patchIdOf: the first field of the first line when it is 40 lowercase hex', () => {
  const f = fn('patchIdOf')
  expect(f(`${P1} ${H1}\n`)).toBe(P1)
  expect(f(`${P1}\n`)).toBe(P1)
  expect(f(`${P1}\t${H1}\n${P2} ${H2}\n`)).toBe(P1)
  expect(f('')).toBeUndefined()
  expect(f('\n')).toBeUndefined()
  expect(f(`${'A'.repeat(40)} ${H1}`)).toBeUndefined()
  expect(f(`${'1'.repeat(39)} ${H1}`)).toBeUndefined()
  expect(f(`${'1'.repeat(64)} ${H1}`)).toBeUndefined()
  expect(f(`warning: x\n${P1} ${H1}`)).toBeUndefined()
})

test('branchOf: reads branch and base from the first non-empty line under ## Branch', () => {
  const f = fn('branchOf')
  const under = (line: string) => `## Summary\nx\n\n## Branch\n\n${line}\n\n## Checks run\nfoundry/auth at abcdef0, based on other.\n`
  expect(f(under('foundry/auth at abcdef0, based on main.'))).toEqual({ branch: 'foundry/auth', base: 'main' })
  expect(f(under('foundry/auth at abcdef0, based on main'))).toEqual({ branch: 'foundry/auth', base: 'main' })
  expect(f(under('`foundry/auth` at `abcdef0`, based on `main`.'))).toEqual({ branch: 'foundry/auth', base: 'main' })
  expect(f(under(`foundry/auth at ${H1}, based on ${H2}.`))).toEqual({ branch: 'foundry/auth', base: H2 })
  expect(f(under('  foundry/auth at abcdef0, based on main.  '))).toEqual({ branch: 'foundry/auth', base: 'main' })
  expect(f(under('-foundry/auth at abcdef0, based on main.'))).toBeUndefined()
  expect(f(under('foundry/auth at abcdef0, based on -main.'))).toBeUndefined()
  expect(f(under('foundry/auth at abc, based on main.'))).toBeUndefined()
  expect(f(under('the branch is foundry/auth'))).toBeUndefined()
  expect(f('## Summary\nx\n')).toBeUndefined()
})

test('examinedVerdict: blocks an untagged v>=2 report missing either heading; tagged stops, v1 and no plan pass', () => {
  const f = fn('examinedVerdict')
  const both = `Summary\n\n## Checks run\nx\n\n${EXAMINED}\n- callers: \`grep -rn x plugins/\`\n\n${NOT_EXAMINED}\nNone.\n\n## Open questions\nNone.\n`
  const reason = `${MARK} Not done yet: on this plan your final report also needs the sections "## Examined" (what the crew checked, each with its scope) and "## Not examined" (what nobody checked, or None.), each a heading of its own.`
  expect(f(V2, both)).toBeUndefined()
  expect(f(V3, both)).toBeUndefined()
  expect(f(V2, `${EXAMINED} \t\nx\n${NOT_EXAMINED}\t\nNone.`)).toBeUndefined()
  expect(f(V2, `Summary\n${EXAMINED}\nx\n`)).toEqual({ block: reason })
  expect(f(V3, `Summary\n${NOT_EXAMINED}\nNone.\n`)).toEqual({ block: reason })
  expect(f(V2, 'Summary\n\n## Proof\nran it')).toEqual({ block: reason })
  // a heading counts only at the start of a line, in full
  expect(f(V2, `see ${EXAMINED} and ${NOT_EXAMINED}`)).toEqual({ block: reason })
  expect(f(V2, ` ${EXAMINED}\nx\n ${NOT_EXAMINED}\nNone.`)).toEqual({ block: reason })
  for (const tag of ['CHECKPOINT:', 'BLOCKED:', 'QUESTION:', 'PROPOSAL:']) {
    expect(f(V2, `${tag} nothing else`)).toBeUndefined()
    expect(f(V2, `  \n ${tag} padded`)).toBeUndefined()
  }
  expect(f(V1, 'Summary\n\n## Proof\nran it')).toBeUndefined()
  expect(f(plan(undefined), 'Summary')).toBeUndefined()
  expect(f(undefined, 'Summary')).toBeUndefined()
})

test('headMovedReason: the template over HEAD_MOVED', () => {
  const f = fn('headMovedReason')
  expect(f(H1, H2)).toBe(
    `${MARK} Not done yet: the head moved: the judge ruled on ${H1}, the branch is at ${H2}, and its patch id differs. Start a fresh judge under the next unused name on ${H2}, and send your final report on its PASS.`,
  )
})

test('headVerdict: every row of the section 6 table', () => {
  const f = fn('headVerdict')
  const noPass = { block: `${MARK} Not done yet: the crew's latest judge file this run is not a clean VERDICT: PASS. Send your final report only after a judge's PASS with no UNSCOPED finding, or start your final message with BLOCKED: or CHECKPOINT:.` }
  const noHead = { block: `${MARK} Not done yet: the crew's latest judge PASS has no "Head:" and "Patch:" lines under ## Proof checked, so no hook can tell which head it ruled on. Start a fresh judge under the next unused name.` }
  // row 1: no judge file, not PASS, or an UNSCOPED finding
  expect(f(V2, undefined, H1, P1)).toEqual(noPass)
  expect(f(V2, ruling({ verdict: 'FAIL' }), H1, P1)).toEqual(noPass)
  expect(f(V2, ruling({ verdict: undefined }), H1, P1)).toEqual(noPass)
  expect(f(V2, ruling({ unscoped: 1 }), H1, P1)).toEqual(noPass)
  // row 2: PASS without both lines
  expect(f(V2, ruling({ head: undefined }), H1, P1)).toEqual(noHead)
  expect(f(V2, ruling({ patch: undefined }), H1, P1)).toEqual(noHead)
  expect(f(V2, ruling({ head: undefined, patch: undefined }), undefined, undefined)).toEqual(noHead)
  // row 3: head unknown goes through
  expect(f(V2, ruling(), undefined, undefined)).toBeUndefined()
  expect(f(V2, ruling(), undefined, P2)).toBeUndefined()
  // row 4: head equals the judged head
  expect(f(V2, ruling(), H1, undefined)).toBeUndefined()
  expect(f(V2, ruling(), H1, P2)).toBeUndefined()
  // row 5: head moved, patch unknown
  expect(f(V2, ruling(), H2, undefined)).toBeUndefined()
  // row 6: head moved, same patch
  expect(f(V2, ruling(), H2, P1)).toBeUndefined()
  // row 7: head moved, patch differs
  const moved = { block: fn('headMovedReason')(H1, H2) }
  expect(f(V2, ruling(), H2, P2)).toEqual(moved)
  expect(f(V3, ruling(), H2, P2)).toEqual(moved)
  // v1 and no plan: goes through whatever the judge said
  expect(f(V1, undefined, H2, P2)).toBeUndefined()
  expect(f(V1, ruling({ verdict: 'FAIL' }), H2, P2)).toBeUndefined()
  expect(f(plan(undefined), ruling({ unscoped: 3 }), H2, P2)).toBeUndefined()
  expect(f(plan('2'), undefined, H2, P2)).toBeUndefined()
  expect(f(undefined, undefined, H2, P2)).toBeUndefined()
})

test('mainCallVerdict: refuses a main-session foundry:* call with no model or a bad effort; model check first', () => {
  const f = fn('mainCallVerdict')
  const model = { deny: `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`model\`: "opus" or "sonnet". Call Agent again with model set.` }
  const effort = { deny: `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`effort\` to "low", "medium", "high" or "xhigh": "medium" by default, "high" or "xhigh" only on the owner's call. Call Agent again with effort set.` }
  expect(f(V2, undefined, 'foundry:judge', undefined, 'medium')).toEqual(model)
  expect(f(V2, undefined, 'foundry:judge', undefined, undefined)).toEqual(model)
  expect(f(V2, undefined, 'foundry:judge', 'opus', undefined)).toEqual(effort)
  expect(f(V2, undefined, 'foundry:judge', 'opus', 'max')).toEqual(effort)
  expect(f(V2, undefined, 'foundry:lead', 'sonnet', 'ultra')).toEqual(effort)
  for (const e of ['low', 'medium', 'high', 'xhigh']) expect(f(V2, undefined, 'foundry:judge', 'opus', e)).toBeUndefined()
  expect(f(V3, undefined, 'foundry:judge', undefined, 'medium')).toEqual(model)
  expect(f(V3, undefined, 'foundry:judge', 'opus', 'max')).toEqual(effort)
  // inside a crew, a non-foundry type, no plan, a v1 plan: through
  expect(f(V2, 'A1', 'foundry:judge', undefined, undefined)).toBeUndefined()
  expect(f(V2, undefined, 'kit:builder', undefined, undefined)).toBeUndefined()
  expect(f(V2, undefined, 'general-purpose', undefined, undefined)).toBeUndefined()
  expect(f(V2, undefined, undefined, undefined, undefined)).toBeUndefined()
  expect(f(undefined, undefined, 'foundry:judge', undefined, undefined)).toBeUndefined()
  expect(f(V1, undefined, 'foundry:judge', undefined, undefined)).toBeUndefined()
  expect(f(plan(undefined), undefined, 'foundry:judge', undefined, undefined)).toBeUndefined()
  expect(f(plan('2'), undefined, 'foundry:judge', undefined, undefined)).toBeUndefined()
})

test('v3 inherits every v2 gate (version >= 2); v1, missing and "2" fail open on all of them', () => {
  const gates: [string, (p: never) => unknown][] = [
    ['budgetSpent', p => fn('budgetSpent')(p, 5)],
    ['judgeBudgetVerdict', p => fn('judgeBudgetVerdict')(p, 'auth', 'auth-judge-9', 5)],
    ['examinedVerdict', p => fn('examinedVerdict')(p, 'plain report')],
    ['headVerdict', p => fn('headVerdict')(p, undefined, H1, P1)],
    ['mainCallVerdict', p => fn('mainCallVerdict')(p, undefined, 'foundry:judge', undefined, undefined)],
  ]
  for (const [name, run] of gates) {
    const v2 = run(V2)
    expect(v2 === undefined || v2 === false ? `${name}: v2 gate did not engage` : 'engaged').toBe('engaged')
    expect(run(V3)).toEqual(v2)
    for (const off of [V1, plan(undefined), plan('2'), plan(2.5), undefined]) {
      const r = run(off as never)
      expect(r === undefined || r === false ? 'open' : `${name} engaged on a non-v2 plan`).toBe('open')
    }
  }
})

// ---- handler behaviour the ADR fixes ----

type W = ReturnType<typeof world>
const PLAN = `${ROOT}/plan.json`
const AUTH_JUDGE = `${ROOT}/reports/auth/auth-judge.md`
const EVENTS = `${ROOT}/events.jsonl`
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const setPlan = (w: W, version: unknown, repairBudget: unknown = 0) =>
  w.files.set(
    PLAN,
    JSON.stringify({
      version,
      goal: 'g',
      approval: 'auto',
      approvedAt: APPROVED,
      maxParallelCrews: 4,
      repairBudget,
      crews: [{ slug: 'auth', wave: 0, verdict: 'change', status: 'running' }],
    }),
  )
const eventLines = (w: W) =>
  (w.files.get(EVENTS) ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
const withJudge = (w: W) => w.agents.push(agent('J1', 'foundry:judge', 'auth-judge', 'L1'))

test('handler: a saved judge FAIL that spends the budget appends one budget-spent line with keys agent, crew, event, ts, v', async ($, on) => {
  const w = world($, on)
  setPlan(w, 2, 0)
  withJudge(w)
  await startSession($)
  await handBack($, 'J1', 'VERDICT: FAIL\n\n## Findings\nthe done-check still fails and the diff leaves a caller of planVerdict stale')
  await settle()
  expect(w.files.get(AUTH_JUDGE)?.startsWith('VERDICT: FAIL')).toBe(true)
  const spent = eventLines(w).filter(e => e.event === 'budget-spent')
  expect(spent.length).toBe(1)
  const e = spent[0] ?? {}
  expect(Object.keys(e).sort()).toEqual(['agent', 'crew', 'event', 'ts', 'v'])
  expect([e.v, e.crew, e.agent]).toEqual([1, 'auth', 'auth-judge'])
  expect(typeof e.ts).toBe('string')
})

test('handler: no budget-spent line while the budget is not spent, or on a v1 plan', async ($, on) => {
  const w = world($, on)
  setPlan(w, 2, 2)
  withJudge(w)
  await startSession($)
  await handBack($, 'J1', 'VERDICT: FAIL\n\n## Findings\nthe done-check still fails and the diff leaves a caller of planVerdict stale')
  await settle()
  expect(eventLines(w).some(e => e.event === 'report')).toBe(true)
  expect(eventLines(w).filter(e => e.event === 'budget-spent')).toEqual([])
})

test('handler: a v1 plan with a spent-looking count writes no budget-spent line', async ($, on) => {
  const w = world($, on)
  setPlan(w, 1, 0)
  withJudge(w)
  await startSession($)
  await handBack($, 'J1', 'VERDICT: FAIL\n\n## Findings\nthe done-check still fails and the diff leaves a caller of planVerdict stale')
  await settle()
  expect(eventLines(w).some(e => e.event === 'report')).toBe(true)
  expect(eventLines(w).filter(e => e.event === 'budget-spent')).toEqual([])
})

test("handler: with the budget spent, a crew member's Agent call named as a judge is refused with the budget text and logs no spawn", async ($, on) => {
  const w = world($, on)
  setPlan(w, 2, 1)
  w.files.set(AUTH_JUDGE, 'VERDICT: FAIL\nx')
  w.files.set(`${ROOT}/reports/auth/auth-judge-2.md`, 'VERDICT: FAIL\nx')
  await startSession($)
  const call = (name: string) => w.agentCall('A1', { subagent_type: 'foundry:judge', name, model: 'opus', effort: 'medium' })
  const r = await call('auth-judge-3')
  expect(r.deny ?? 'not denied').toBe(
    `${MARK} Refused: repair budget spent: auth has 2 judge FAILs this run and repairBudget is 1. Start no more judges: send main a message that starts with "${BUDGET_BLOCKED}", with the last judge's findings.`,
  )
  await settle()
  expect(eventLines(w).filter(e => e.event === 'spawn')).toEqual([])
  // not a judge name: through
  expect((await call('auth-helper')).deny).toBeUndefined()
})

test('handler: stale judge FAIL files from before approvedAt do not spend the budget', async ($, on) => {
  const w = world($, on)
  setPlan(w, 2, 0)
  w.files.set(AUTH_JUDGE, 'VERDICT: FAIL\nold run')
  w.mtimes.set(AUTH_JUDGE, SINCE - 86_400_000)
  await startSession($)
  const r = await w.agentCall('A1', { subagent_type: 'foundry:judge', name: 'auth-judge-2', model: 'opus', effort: 'medium' })
  expect(r.deny ?? 'not denied').toBe('not denied')
  // control: the same file, fresh, does spend a budget of 0
  w.mtimes.set(AUTH_JUDGE, SINCE + 1000)
  const again = await w.agentCall('A1', { subagent_type: 'foundry:judge', name: 'auth-judge-3', model: 'opus', effort: 'medium' })
  expect(String(again.deny).startsWith(`${MARK} Refused: repair budget spent:`)).toBe(true)
})

test('handler: a v1 plan never refuses a judge name, whatever the FAIL count', async ($, on) => {
  const w = world($, on)
  setPlan(w, 1, 0)
  w.files.set(AUTH_JUDGE, 'VERDICT: FAIL\nx')
  await startSession($)
  const r = await w.agentCall('A1', { subagent_type: 'foundry:judge', name: 'auth-judge-2', model: 'opus', effort: 'medium' })
  expect(r.deny).toBeUndefined()
})

const mainModelRefusal = `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`model\`: "opus" or "sonnet". Call Agent again with model set.`
const mainEffortRefusal = `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`effort\` to "low", "medium", "high" or "xhigh": "medium" by default, "high" or "xhigh" only on the owner's call. Call Agent again with effort set.`

test("handler: on a v2 plan the main session's foundry:* Agent call without model, without effort, or with effort max is refused and runs nothing", async ($, on) => {
  const w = world($, on)
  setPlan(w, 2, 2)
  await startSession($)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', effort: 'medium' })).deny ?? 'not denied').toBe(mainModelRefusal)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', model: 'opus' })).deny ?? 'not denied').toBe(mainEffortRefusal)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', model: 'opus', effort: 'max' })).deny ?? 'not denied').toBe(mainEffortRefusal)
  expect(w.ran.filter(c => c.tool === 'Agent')).toEqual([])
})

test("handler: on a v3 plan the main session's foundry:* Agent call without model, without effort, or with effort max is refused and runs nothing", async ($, on) => {
  const w = world($, on)
  setPlan(w, 3, 2)
  await startSession($)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', effort: 'medium' })).deny ?? 'not denied').toBe(mainModelRefusal)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', model: 'opus' })).deny ?? 'not denied').toBe(mainEffortRefusal)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', model: 'opus', effort: 'max' })).deny ?? 'not denied').toBe(mainEffortRefusal)
  expect(w.ran.filter(c => c.tool === 'Agent')).toEqual([])
})

test("handler: on a v1 plan the main session's foundry:* Agent call without model or effort goes through", async ($, on) => {
  const w = world($, on)
  setPlan(w, 1, 2)
  await startSession($)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge' })).deny).toBeUndefined()
})

test("handler: with no plan the main session's foundry:* Agent call without model or effort goes through", async ($, on) => {
  const w = world($, on)
  await startSession($)
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:architect', name: 'arch' })).deny).toBeUndefined()
})
