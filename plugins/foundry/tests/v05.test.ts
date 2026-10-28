import { expect } from 'claude-code/testing'

import * as R from '../hooks/register.ts'
import { agent, handBack, quiet, ROOT, startSession, stop, test, world } from './harness'

// Handler-level tests for foundry ADR-0004 sections 3-7 (lead stop gate, bounded repair loop, head guard,
// main-session rule), written from the ADR before the producer exists. The pure functions of section 9 are
// covered by contract-gates.test.ts; this file drives the real hook entry points (Agent tool calls,
// SubagentHandback, lead stops). It imports the hooks as a namespace and checks `typeof` inside each test, so on
// old code a test fails on a missing export or missing behaviour, never on an import error.
//
// The harness registers `process.run` once, and a second registration is an error. To script the head guard's
// git calls, the world is built through a wrapped `on` that puts this file's handler in front of the harness one:
// the git-common-dir lookup is delegated to the harness (it answers C:/r/.git), every other git call is recorded
// in `gitCalls` and answered by the test's `git` script. The same wrapper lets a test make fs.list / fs.read throw.

const MARK = '[foundry]'
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const P1 = '1'.repeat(40)
const P2 = '2'.repeat(40)
const APPROVED = '2026-10-17T11:00:00Z'
const SINCE = Date.parse(APPROVED)
const SENTINEL = 'ZXQ-SENTINEL-7731'
const PLAN = `${ROOT}/plan.json`
const EVENTS = `${ROOT}/events.jsonl`
const REPORTS = `${ROOT}/reports/auth`
const judgePath = (name: string) => `${REPORTS}/${name}.md`

const constant = (name: string): unknown => (R as Record<string, unknown>)[name]
// a string constant of the hooks; a missing one fails here, so a test can never pass by comparing undefined to undefined
const str = (name: string): string => {
  const v = constant(name)
  expect(typeof v === 'string' ? 'string' : `R.${name} is not a string`).toBe('string')
  return v as string
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fn = (name: string): any => {
  const v = constant(name)
  expect(typeof v === 'function' ? 'function' : `R.${name} is not a function`).toBe('function')
  return v
}

type GitResult = { exitCode: number; stdout: string } | 'throw'
type Call = { argv: string[]; init: { cwd?: string; timeoutMs?: number; stdin?: string } }
type Opts = {
  git?: (argv: string[], init: Call['init']) => GitResult
  listThrowsFor?: string
  readThrowsFor?: string
  inRepo?: boolean
}

// a git that behaves: head `head`, diff text 'DIFF', patch id `patch`
const gitAt =
  (head: string, patch: string) =>
  (argv: string[]): GitResult => {
    if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: `${head}\n` }
    if (argv[1] === 'diff') return { exitCode: 0, stdout: 'DIFF-TEXT\n' }
    if (argv[1] === 'patch-id') return { exitCode: 0, stdout: `${patch}  ${head}\n` }
    return { exitCode: 1, stdout: '' }
  }

function build($: never, on: never, o: Opts = {}) {
  const gitCalls: Call[] = []
  const ctl = { git: o.git ?? gitAt(H1, P1) }
  const rawOn = on as unknown as (ev: string, h: (...a: unknown[]) => unknown) => unknown
  const wrapped = ((ev: string, h: (...a: unknown[]) => unknown) => {
    if (ev === 'process.run') {
      return rawOn(ev, async (c: unknown, e: unknown) => {
        const call = e as Call
        if (call.argv.includes('--git-common-dir')) return h(c, e)
        gitCalls.push({ argv: call.argv, init: call.init ?? {} })
        const r = ctl.git(call.argv, call.init ?? {})
        if (r === 'throw') throw new Error('git blew up')
        return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      })
    }
    if (ev === 'fs.list' && o.listThrowsFor !== undefined) {
      return rawOn(ev, async (c: unknown, e: unknown) => {
        if (String((e as { path?: string }).path ?? '').replace(/\\/g, '/').includes(o.listThrowsFor as string)) throw new Error('list is down')
        return h(c, e)
      })
    }
    if (ev === 'fs.read' && o.readThrowsFor !== undefined) {
      return rawOn(ev, async (c: unknown, e: unknown) => {
        if (String((e as { path?: string }).path ?? '').replace(/\\/g, '/').endsWith(o.readThrowsFor as string)) throw new Error('read is down')
        return h(c, e)
      })
    }
    return rawOn(ev, h)
  }) as never
  const wopts: { inRepo?: boolean; listFails?: boolean } = o.inRepo === false ? { inRepo: false } : {}
  const w = quiet(world($ as never, wrapped, wopts))
  return { w, gitCalls, ctl, wopts }
}

// one world per test (the kit refuses a second world()); between cases a test resets what the hooks read
const reset = (b: Built) => {
  for (const k of [...b.w.files.keys()]) if (k.includes('/reports/') || k === EVENTS) b.w.files.delete(k)
  b.w.mtimes.clear()
  b.gitCalls.length = 0
}

type Built = ReturnType<typeof build>
type W = Built['w']

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// a symbol value is dropped by JSON.stringify: passing OMIT leaves the repairBudget key out of the plan
const OMIT = Symbol('omit')
const setPlan = (w: W, version: unknown, repairBudget: unknown = 2, crews: unknown[] = [{ slug: 'auth', wave: 0, verdict: 'change', status: 'running' }]) =>
  w.files.set(PLAN, JSON.stringify({ version, goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, repairBudget, crews }))

const BRANCH_LINE = 'auth-branch at abc1234, based on def5678.'
const EXAM = ['## Examined', '- callers of planVerdict: `grep -rn planVerdict plugins/`', '## Not examined', 'None.']
const report = (o: { branch?: string; extra?: string[]; marker?: string } = {}) =>
  [
    '## Summary',
    `did the work ${o.marker ?? SENTINEL}`,
    '## Branch',
    o.branch ?? BRANCH_LINE,
    '## Changes',
    'a.ts',
    '## Proof',
    'tests pass',
    '## Checks run',
    'bun test',
    ...(o.extra ?? EXAM),
    '## Open questions',
    'None.',
  ].join('\n')
const withoutHeadings = () => report({ extra: [] })

const judgeText = (verdict: 'PASS' | 'FAIL', o: { head?: string | null; patch?: string | null; findings?: string } = {}) =>
  [
    `VERDICT: ${verdict}`,
    '',
    '## Proof checked',
    ...(o.head === null ? [] : [`Head: ${o.head ?? H1}`]),
    ...(o.patch === null ? [] : [`Patch: ${o.patch ?? P1}`]),
    '',
    '## Findings',
    o.findings ?? `nothing wrong ${SENTINEL}`,
  ].join('\n')

const setJudge = (w: W, name: string, text: string, mtimeMs?: number) => {
  w.files.set(judgePath(name), text)
  if (mtimeMs !== undefined) w.mtimes.set(judgePath(name), mtimeMs)
}

const lead = async ($: never, text: string, active = false): Promise<string | undefined> => {
  const r = (await ($ as unknown as { classic: { SubagentStop: (e: never) => Promise<unknown> } }).classic.SubagentStop(stop('L1', text, active))) as { block?: string }
  return r.block
}

const eventLines = (w: W) =>
  (w.files.get(EVENTS) ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
const budgetLines = (w: W) => eventLines(w).filter(e => e.event === 'budget-spent')

const judgeAgent = (w: W, id: string, name: string, parent = 'L1') => w.agents.push(agent(id, 'foundry:judge', name, parent))
const spawnJudge = (w: W, from: string, name: string | undefined) =>
  w.agentCall(from, { subagent_type: 'foundry:judge', ...(name === undefined ? {} : { name }), model: 'opus', effort: 'medium' })

const FAIL_BODY = `VERDICT: FAIL\n\n## Findings\nthe done-check still fails and the diff leaves a stale caller ${SENTINEL}`

// a v2 world with a clean PASS for head H1 and a git whose head is H1: the report with both headings goes through
async function cleanWorld($: never, on: never, o: Opts = {}) {
  const b = build($, on, { git: gitAt(H1, P1), ...o })
  setPlan(b.w, 2, 2)
  setJudge(b.w, 'auth-judge', judgeText('PASS'), SINCE + 1000)
  await startSession($ as never)
  return b
}

// ---------------------------------------------------------------------------------------------
// 1. lead stop gate, section 4
// ---------------------------------------------------------------------------------------------

test('s4: v2 plan, untagged report with the six sections but neither heading, or only one, is sent back with EXAMINED_REASON', async ($, on) => {
  const { w } = await cleanWorld($ as never, on as never)
  const reason = str('EXAMINED_REASON')
  expect(await lead($ as never, withoutHeadings())).toBe(reason)
  expect(await lead($ as never, report({ extra: ['## Examined', '- x: y'] }))).toBe(reason)
  expect(await lead($ as never, report({ extra: ['## Not examined', 'None.'] }))).toBe(reason)
  expect(w.files.size).toBeGreaterThan(0)
})

test('s4: v2 plan, both headings and a clean head guard go through', async ($, on) => {
  await cleanWorld($ as never, on as never)
  str('EXAMINED_REASON')
  expect(await lead($ as never, report())).toBeUndefined()
})

test('s4: a heading counts only at line start, full line (trailing spaces and tabs allowed)', async ($, on) => {
  await cleanWorld($ as never, on as never)
  const reason = str('EXAMINED_REASON')
  const bad: string[][] = [
    ['## Examined stuff', '## Not examined', 'None.'],
    ['## Examined', '## Not examined list', 'None.'],
    ['  ## Examined', '## Not examined'],
    ['## Examined', '\t## Not examined'],
    ['see ## Examined', '## Not examined'],
    ['## Examined', 'and ## Not examined'],
    ['### Examined', '### Not examined'],
  ]
  for (const extra of bad) expect([extra, await lead($ as never, report({ extra }))]).toEqual([extra, reason])
  const good: string[][] = [
    ['## Examined   ', '- x: y', '## Not examined\t', 'None.'],
    ['## Examined\t \t', '## Not examined  '],
  ]
  for (const extra of good) expect([extra, await lead($ as never, report({ extra }))]).toEqual([extra, undefined])
})

test('s4: tagged stops (CHECKPOINT:, BLOCKED:, QUESTION:, PROPOSAL:) are exempt on a v2 plan, with or without a Proof section', async ($, on) => {
  const { w, gitCalls } = await cleanWorld($ as never, on as never)
  str('EXAMINED_REASON')
  w.files.delete(judgePath('auth-judge'))
  for (const tag of ['CHECKPOINT:', 'BLOCKED:', 'QUESTION:', 'PROPOSAL:']) {
    expect([tag, await lead($ as never, `${tag} half done\n${withoutHeadings()}`)]).toEqual([tag, undefined])
    expect([tag, await lead($ as never, `${tag} half done`)]).toEqual([tag, undefined])
  }
  expect(gitCalls).toEqual([])
})

test('s4: a v1 plan, no plan and an unparseable plan.json let the same report through as in 0.4.3, running no git', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never)
  await startSession($ as never)
  for (const setup of ['v1', 'none', 'garbage', 'noversion'] as const) {
    w.files.delete(PLAN)
    if (setup === 'v1') setPlan(w, 1, undefined)
    if (setup === 'garbage') w.files.set(PLAN, '{not json at all')
    if (setup === 'noversion') w.files.set(PLAN, JSON.stringify({ goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, crews: [] }))
    expect([setup, await lead($ as never, withoutHeadings())]).toEqual([setup, undefined])
    expect([setup, gitCalls]).toEqual([setup, []])
  }
})

test('s4: a v3 plan gets the v2 rules', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 3, 2)
  await startSession($ as never)
  expect(await lead($ as never, withoutHeadings())).toBe(str('EXAMINED_REASON'))
})

// ---------------------------------------------------------------------------------------------
// 2. head guard, section 6 table, end to end through a lead stop
// ---------------------------------------------------------------------------------------------

test('s6: no judge file, a FAIL, or a PASS with an UNSCOPED finding is sent back with NO_PASS_REASON', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const b = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(b.w, 2, 2)
  await startSession($ as never)
  for (const [label, text] of [
    ['no file', undefined],
    ['FAIL', judgeText('FAIL')],
    ['PASS with UNSCOPED', judgeText('PASS', { findings: '- UNSCOPED: no other caller, in the lead report' })],
  ] as const) {
    reset(b)
    if (text !== undefined) setJudge(b.w, 'auth-judge', text, SINCE + 1000)
    expect([label, await lead($ as never, report())]).toEqual([label, reason])
  }
})

test('s6: a PASS with no head or no patch line is sent back with NO_HEAD_REASON', async ($, on) => {
  const reason = str('NO_HEAD_REASON')
  const b = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(b.w, 2, 2)
  await startSession($ as never)
  for (const [label, text] of [
    ['neither', judgeText('PASS', { head: null, patch: null })],
    ['no patch', judgeText('PASS', { patch: null })],
    ['no head', judgeText('PASS', { head: null })],
    ['uppercase head', judgeText('PASS', { head: H1.toUpperCase() })],
    ['short head', judgeText('PASS', { head: 'abc1234' })],
    ['lines outside Proof checked', `VERDICT: PASS\n\n## Findings\nHead: ${H1}\nPatch: ${P1}\n`],
  ] as const) {
    reset(b)
    setJudge(b.w, 'auth-judge', text, SINCE + 1000)
    expect([label, await lead($ as never, report())]).toEqual([label, reason])
  }
})

test('s6: git rev-parse failing (non-zero, throwing, garbage stdout) lets the stop through, running no diff', async ($, on) => {
  str('NO_HEAD_REASON')
  const cases: [string, Opts['git']][] = [
    ['non-zero', () => ({ exitCode: 1, stdout: '' })],
    ['throws', () => 'throw'],
    ['garbage', argv => (argv[1] === 'rev-parse' ? { exitCode: 0, stdout: 'not a sha\n' } : { exitCode: 0, stdout: 'x' })],
    ['empty', () => ({ exitCode: 0, stdout: '' })],
  ]
  const { gitCalls, ctl } = await cleanWorld($ as never, on as never)
  for (const [label, git] of cases) {
    ctl.git = git as never
    gitCalls.length = 0
    expect([label, await lead($ as never, report())]).toEqual([label, undefined])
    expect([label, gitCalls.filter(c => c.argv[1] === 'diff' || c.argv[1] === 'patch-id')]).toEqual([label, []])
  }
})

test('s6: head equal to the judged head goes through and runs only rev-parse', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H1, P2) })
  expect(await lead($ as never, report())).toBeUndefined()
  expect(gitCalls.length).toBeGreaterThan(0)
  expect(gitCalls.every(c => c.argv[1] === 'rev-parse')).toBe(true)
})

test('s6: head moved with the same patch id goes through (the PASS survives the rebase)', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P1) })
  expect(await lead($ as never, report())).toBeUndefined()
  expect(gitCalls.map(c => c.argv[1])).toEqual(['rev-parse', 'diff', 'patch-id'])
})

test('s6: head moved with a different patch id is sent back with headMovedReason(judged, head)', async ($, on) => {
  await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  const moved = fn('headMovedReason')(H1, H2)
  expect(typeof moved).toBe('string')
  expect(await lead($ as never, report())).toBe(moved)
  expect(moved).toContain(H1)
  expect(moved).toContain(H2)
})

test('s6: head moved and the patch-id call failing (non-zero, throwing, garbage, diff failing) lets the stop through', async ($, on) => {
  str('NO_HEAD_REASON')
  const cases: [string, Opts['git']][] = [
    ['patch-id non-zero', a => (a[1] === 'patch-id' ? { exitCode: 1, stdout: '' } : gitAt(H2, P2)(a))],
    ['patch-id throws', a => (a[1] === 'patch-id' ? 'throw' : gitAt(H2, P2)(a))],
    ['patch-id garbage', a => (a[1] === 'patch-id' ? { exitCode: 0, stdout: 'zzz  yyy\n' } : gitAt(H2, P2)(a))],
    ['patch-id empty', a => (a[1] === 'patch-id' ? { exitCode: 0, stdout: '' } : gitAt(H2, P2)(a))],
    ['diff fails', a => (a[1] === 'diff' ? { exitCode: 128, stdout: '' } : gitAt(H2, P2)(a))],
    ['diff throws', a => (a[1] === 'diff' ? 'throw' : gitAt(H2, P2)(a))],
  ]
  const { ctl } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  for (const [label, git] of cases) {
    ctl.git = git as never
    expect([label, await lead($ as never, report())]).toEqual([label, undefined])
  }
})

test('s6: the git calls have the exact argv, cwd and timeout the ADR fixes, and the diff output is the patch-id stdin', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P1) })
  expect(await lead($ as never, report())).toBeUndefined()
  expect(gitCalls.map(c => c.argv)).toEqual([
    ['git', 'rev-parse', '--verify', '--quiet', 'auth-branch^{commit}'],
    ['git', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', 'def5678...auth-branch'],
    ['git', 'patch-id', '--stable'],
  ])
  for (const c of gitCalls) expect([c.argv[1], c.init.timeoutMs, c.init.cwd]).toEqual([c.argv[1], 15_000, 'C:/r'])
  expect(gitCalls[2]?.init.stdin).toBe('DIFF-TEXT\n')
})

test('s6: a Branch line wrapped in single backticks reads the same branch and base', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P1) })
  expect(await lead($ as never, report({ branch: '`auth-branch` at `abc1234`, based on `def5678`.' }))).toBeUndefined()
  expect(gitCalls[0]?.argv).toEqual(['git', 'rev-parse', '--verify', '--quiet', 'auth-branch^{commit}'])
  expect(gitCalls[1]?.argv.at(-1)).toBe('def5678...auth-branch')
})

test('s6: a Branch line whose branch or base starts with "-" runs no git at all and fails open', async ($, on) => {
  str('NO_HEAD_REASON')
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  for (const branch of ['-evil at abc1234, based on def5678.', 'auth-branch at abc1234, based on -x.', '`--upload-pack=x` at abc1234, based on def5678.']) {
    gitCalls.length = 0
    expect([branch, await lead($ as never, report({ branch }))]).toEqual([branch, undefined])
    expect([branch, gitCalls]).toEqual([branch, []])
  }
})

test('s6: no readable Branch line means head unknown: the stop goes through, no git run', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  expect(await lead($ as never, report({ branch: 'it is on some branch' }))).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('s6: stale judge files (mtime before approvedAt) are ignored: a stale PASS is not a PASS', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(w, 2, 2)
  setJudge(w, 'auth-judge', judgeText('PASS'), SINCE - 86_400_000)
  await startSession($ as never)
  expect(await lead($ as never, report())).toBe(reason)
  // a stale PASS under a fresh FAIL is still no PASS; a fresh PASS next to a stale FAIL is a PASS
  setJudge(w, 'auth-judge-2', judgeText('FAIL'), SINCE + 1000)
  expect(await lead($ as never, report())).toBe(reason)
  setJudge(w, 'auth-judge', judgeText('FAIL'), SINCE - 86_400_000)
  setJudge(w, 'auth-judge-2', judgeText('PASS'), SINCE + 1000)
  expect(await lead($ as never, report())).toBeUndefined()
})

test('s6: the latest this-run judge file rules: a newer FAIL over an older PASS is no PASS, a newer PASS over an older FAIL is one', async ($, on) => {
  const reason = str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(w, 2, 2)
  setJudge(w, 'auth-judge', judgeText('PASS'), SINCE + 1000)
  setJudge(w, 'auth-judge-2', judgeText('FAIL'), SINCE + 2000)
  await startSession($ as never)
  expect(await lead($ as never, report())).toBe(reason)
  setJudge(w, 'auth-judge', judgeText('FAIL'), SINCE + 1000)
  setJudge(w, 'auth-judge-2', judgeText('PASS'), SINCE + 2000)
  expect(await lead($ as never, report())).toBeUndefined()
})

test('s6: a red-team file is not the latest judge file', async ($, on) => {
  const { w } = await cleanWorld($ as never, on as never)
  w.files.set(`${REPORTS}/auth-redteam.md`, 'REDTEAM: x\nVERDICT: FAIL\n')
  w.mtimes.set(`${REPORTS}/auth-redteam.md`, SINCE + 9000)
  expect(await lead($ as never, report())).toBeUndefined()
})

test('s6: the head guard runs only after the examined check: a missing heading is sent back with EXAMINED_REASON and no git runs', async ($, on) => {
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  expect(await lead($ as never, withoutHeadings())).toBe(str('EXAMINED_REASON'))
  expect(gitCalls).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// 3. streak
// ---------------------------------------------------------------------------------------------

test('streak: examined send-backs share the streak: LEAD_STOP_BLOCKS in a row, then the next stop goes through', async ($, on) => {
  const { w } = await cleanWorld($ as never, on as never)
  expect(R.LEAD_STOP_BLOCKS).toBe(2)
  const reason = str('EXAMINED_REASON')
  expect(await lead($ as never, withoutHeadings(), false)).toBe(reason)
  expect(await lead($ as never, withoutHeadings(), true)).toBe(reason)
  expect(await lead($ as never, withoutHeadings(), true)).toBeUndefined()
  // a fresh streak (stop_hook_active false) blocks again
  expect(await lead($ as never, withoutHeadings(), false)).toBe(reason)
  expect(w.files.size).toBeGreaterThan(0)
})

test('streak: no-PASS send-backs count the same way', async ($, on) => {
  const noPass = str('NO_PASS_REASON')
  const a = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(a.w, 2, 2)
  await startSession($ as never)
  expect(await lead($ as never, report(), false)).toBe(noPass)
  expect(await lead($ as never, report(), true)).toBe(noPass)
  expect(await lead($ as never, report(), true)).toBeUndefined()
})

test('streak: a moved-head send-back counts the same way', async ($, on) => {
  await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  const moved = fn('headMovedReason')(H1, H2)
  expect(await lead($ as never, report(), false)).toBe(moved)
  expect(await lead($ as never, report(), true)).toBe(moved)
  expect(await lead($ as never, report(), true)).toBeUndefined()
})

test('streak: LEAD_STOP_REASON and the new send-backs share one count', async ($, on) => {
  await cleanWorld($ as never, on as never)
  expect(await lead($ as never, 'chatter', false)).toBe(R.LEAD_STOP_REASON)
  expect(await lead($ as never, withoutHeadings(), true)).toBe(str('EXAMINED_REASON'))
  expect(await lead($ as never, withoutHeadings(), true)).toBeUndefined()
})

// ---------------------------------------------------------------------------------------------
// 4. fail open
// ---------------------------------------------------------------------------------------------

test('fail open: listing the judge folder throws -> the stop goes through', async ($, on) => {
  str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { listThrowsFor: '/reports/auth' })
  setPlan(w, 2, 2)
  // a non-judge file makes the folder exist, so the list call is made and throws
  w.files.set(`${REPORTS}/notes.txt`, 'x')
  await startSession($ as never)
  expect(await lead($ as never, report())).toBeUndefined()
})

test('s6: a v2 plan with no reports/<crew> folder at all has no judge file: NO_PASS_REASON', async ($, on) => {
  const { w } = build($ as never, on as never, { git: gitAt(H1, P1) })
  setPlan(w, 2, 2)
  await startSession($ as never)
  expect([...w.files.keys()].some(k => k.includes('/reports/auth/'))).toBe(false)
  expect(await lead($ as never, report())).toBe(str('NO_PASS_REASON'))
})

test('fail open: reading the judge file throws -> the stop goes through', async ($, on) => {
  str('NO_PASS_REASON')
  const { w } = build($ as never, on as never, { readThrowsFor: '/reports/auth/auth-judge.md' })
  setPlan(w, 2, 2)
  setJudge(w, 'auth-judge', judgeText('FAIL'), SINCE + 1000)
  await startSession($ as never)
  expect(await lead($ as never, report())).toBeUndefined()
})

test('fail open: an unreadable plan.json means the 0.4.3 gate: the report without headings goes through', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never, { readThrowsFor: '/plan.json' })
  setPlan(w, 2, 2)
  await startSession($ as never)
  expect(await lead($ as never, withoutHeadings())).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('fail open: a v1 plan never runs the head guard git calls, even with a moved head on disk', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never, { git: gitAt(H2, P2) })
  setPlan(w, 1, undefined)
  setJudge(w, 'auth-judge', judgeText('PASS'), SINCE + 1000)
  await startSession($ as never)
  expect(await lead($ as never, report())).toBeUndefined()
  expect(gitCalls.some(c => c.argv.includes('--verify'))).toBe(false)
  expect(gitCalls).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// 5. hand-back path
// ---------------------------------------------------------------------------------------------

const savedWith = (w: W, marker: string) => [...w.files.entries()].some(([k, v]) => k.includes('/reports/') && v.includes(marker))

test('hand-back: a lead hand-back without the headings on a v2 plan is not saved as the report; with them it is; git is not run', async ($, on) => {
  const { w, gitCalls } = build($ as never, on as never, { git: gitAt(H2, P2) })
  setPlan(w, 2, 2)
  await startSession($ as never)
  str('EXAMINED_REASON')
  await handBack($ as never, 'L1', report({ extra: [], marker: 'HB-NOHEAD' }))
  await settle()
  expect(savedWith(w, 'HB-NOHEAD')).toBe(false)
  await handBack($ as never, 'L1', report({ marker: 'HB-HEADS' }))
  await settle()
  // saved although no judge file exists and the head moved: the guard does not run on hand-back
  expect(savedWith(w, 'HB-HEADS')).toBe(true)
  expect(gitCalls).toEqual([])
})

test('hand-back: a tagged lead hand-back is saved on a v2 plan', async ($, on) => {
  const a = build($ as never, on as never)
  setPlan(a.w, 2, 2)
  await startSession($ as never)
  str('EXAMINED_REASON')
  await handBack($ as never, 'L1', `CHECKPOINT: half done, HB-TAG\n${withoutHeadings()}`)
  await settle()
  expect(savedWith(a.w, 'HB-TAG')).toBe(true)
})

test('hand-back: on a v1 plan the headingless report is saved as in 0.4.3', async ($, on) => {
  const b = build($ as never, on as never)
  setPlan(b.w, 1, undefined)
  await startSession($ as never)
  await handBack($ as never, 'L1', report({ extra: [], marker: 'HB-V1' }))
  await settle()
  expect(savedWith(b.w, 'HB-V1')).toBe(true)
  expect(b.gitCalls).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// 6. budget
// ---------------------------------------------------------------------------------------------

test('s5: budget-spent is appended only when the saved FAIL leaves fails > repairBudget (budgets 0, 1, 2)', async ($, on) => {
  const cases: [number, number, boolean][] = [
    // [repairBudget, FAIL files already on disk, line expected after saving one more FAIL]
    [0, 0, true],
    [1, 0, false],
    [1, 1, true],
    [2, 0, false],
    [2, 1, false],
    [2, 2, true],
  ]
  const b = build($ as never, on as never)
  await startSession($ as never)
  let n = 0
  for (const [budget, prior, expected] of cases) {
    reset(b)
    const { w } = b
    setPlan(w, 2, budget === undefined ? OMIT : budget)
    for (let i = 1; i <= prior; i++) setJudge(w, i === 1 ? 'auth-judge' : `auth-judge-${i}`, 'VERDICT: FAIL\nx', SINCE + i)
    const id = `J${++n}`
    judgeAgent(w, id, prior === 0 ? 'auth-judge' : `auth-judge-${prior + 1}`)
    await handBack($ as never, id, FAIL_BODY)
    await settle()
    expect([budget, prior, budgetLines(w).length]).toEqual([budget, prior, expected ? 1 : 0])
    // the report line itself is always written
    expect(eventLines(w).some(e => e.event === 'report')).toBe(true)
  }
})

test('s5: a PASS saved after the budget is spent adds no budget-spent line', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 1)
  setJudge(w, 'auth-judge', 'VERDICT: FAIL\nx', SINCE + 1)
  setJudge(w, 'auth-judge-2', 'VERDICT: FAIL\nx', SINCE + 2)
  judgeAgent(w, 'J9', 'auth-judge-3')
  await startSession($ as never)
  await handBack($ as never, 'J9', judgeText('PASS'))
  await settle()
  expect(savedWith(w, 'VERDICT: PASS')).toBe(true)
  expect(eventLines(w).some(e => e.event === 'report')).toBe(true)
  expect(budgetLines(w)).toEqual([])
})

test('s5: red-team files never count toward the budget, and a red-team spawn is not gated', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  for (const n of ['auth-redteam', 'auth-redteam-2', 'auth-redteam-3']) setJudge(w, n, 'VERDICT: FAIL\nx', SINCE + 5)
  judgeAgent(w, 'J9', 'auth-judge')
  await startSession($ as never)
  expect((await spawnJudge(w, 'A1', 'auth-judge-2')).deny).toBeUndefined()
  // a judge FAIL of its own with budget 0 spends it; the red-team files add nothing to that
  await handBack($ as never, 'J9', FAIL_BODY)
  await settle()
  expect(budgetLines(w).length).toBe(1)
})

test('s5: a PASS saved beside red-team FAIL files is no spend', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  for (const n of ['auth-redteam', 'auth-redteam-2']) setJudge(w, n, 'VERDICT: FAIL\nx', SINCE + 5)
  judgeAgent(w, 'J9', 'auth-judge')
  await startSession($ as never)
  await handBack($ as never, 'J9', judgeText('PASS'))
  await settle()
  expect(budgetLines(w)).toEqual([])
})

test('s5: a successor lead <crew>-2 has its own folder and its own count', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 1, [
    { slug: 'auth', wave: 0, verdict: 'change', status: 'running' },
  ])
  w.agents.push(agent('L3', R.LEAD_TYPE, 'auth-2'), agent('A3', 'kit:builder', 'auth-2-builder', 'L3'))
  judgeAgent(w, 'J3', 'auth-2-judge', 'L3')
  // crew auth has spent its budget of 1 (two FAILs)
  setJudge(w, 'auth-judge', 'VERDICT: FAIL\nx', SINCE + 1)
  setJudge(w, 'auth-judge-2', 'VERDICT: FAIL\nx', SINCE + 2)
  await startSession($ as never)
  expect(String((await spawnJudge(w, 'A1', 'auth-judge-3')).deny).startsWith(`${MARK} Refused: repair budget spent:`)).toBe(true)
  expect((await spawnJudge(w, 'A3', 'auth-2-judge-2')).deny).toBeUndefined()
  // the successor's first FAIL leaves 1 FAIL, not above 1: no line
  await handBack($ as never, 'J3', FAIL_BODY)
  await settle()
  expect(w.files.get(`${ROOT}/reports/auth-2/auth-2-judge.md`)?.startsWith('VERDICT: FAIL')).toBe(true)
  expect(budgetLines(w)).toEqual([])
})

test('s5 spawn gate: a judge spawn without a name, and a non-judge name even when spent, are not gated', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  setJudge(w, 'auth-judge', 'VERDICT: FAIL\nx', SINCE + 1)
  setJudge(w, 'auth-judge-2', 'VERDICT: FAIL\nx', SINCE + 2)
  await startSession($ as never)
  expect((await spawnJudge(w, 'A1', undefined)).deny).toBeUndefined()
  expect((await spawnJudge(w, 'A1', 'auth-builder-3')).deny).toBeUndefined()
  expect((await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-builder-3', model: 'opus', effort: 'medium' })).deny).toBeUndefined()
  // control: a judge name is refused
  expect(String((await spawnJudge(w, 'A1', 'auth-judge-3')).deny).startsWith(`${MARK} Refused: repair budget spent:`)).toBe(true)
})

test('s5 spawn gate: a refused judge spawn logs no spawn event, an allowed one does', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 0)
  setJudge(w, 'auth-judge', 'VERDICT: FAIL\nx', SINCE + 1)
  await startSession($ as never)
  expect(String((await spawnJudge(w, 'A1', 'auth-judge-2')).deny).startsWith(`${MARK} Refused: repair budget spent:`)).toBe(true)
  await settle()
  expect(eventLines(w).filter(e => e.event === 'spawn')).toEqual([])
  expect((await spawnJudge(w, 'A1', 'auth-helper')).deny).toBeUndefined()
  await settle()
  expect(eventLines(w).filter(e => e.event === 'spawn').length).toBe(1)
})

test('s5: a missing, negative, non-integer or string repairBudget on a v2 plan means no budget rule', async ($, on) => {
  str('BUDGET_REFUSAL')
  const b = build($ as never, on as never)
  const { w } = b
  judgeAgent(w, 'J9', 'auth-judge-5')
  await startSession($ as never)
  for (const budget of [undefined, -1, 1.5, '2', null, 'abc']) {
    reset(b)
    setPlan(w, 2, budget === undefined ? OMIT : budget)
    for (let i = 1; i <= 4; i++) setJudge(w, i === 1 ? 'auth-judge' : `auth-judge-${i}`, 'VERDICT: FAIL\nx', SINCE + i)
    expect([budget, (await spawnJudge(w, 'A1', 'auth-judge-5')).deny]).toEqual([budget, undefined])
    await handBack($ as never, 'J9', FAIL_BODY)
    await settle()
    expect([budget, budgetLines(w)]).toEqual([budget, []])
  }
})

// ---------------------------------------------------------------------------------------------
// 7. main-session rule
// ---------------------------------------------------------------------------------------------

const mainCall = (w: W, input: Record<string, unknown>) => w.agentCall(undefined, { subagent_type: 'foundry:judge', name: 'x-judge', ...input })

test('s7: on a v2 plan the model check runs before the effort check, and effort max is refused', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 2)
  await startSession($ as never)
  const model = str('MAIN_MODEL_REFUSAL')
  const effort = str('MAIN_EFFORT_REFUSAL')
  // neither model nor effort: the model reason
  expect((await mainCall(w, {})).deny).toBe(model)
  // no model and effort max: still the model reason
  expect((await mainCall(w, { effort: 'max' })).deny).toBe(model)
  expect((await mainCall(w, { model: 'opus' })).deny).toBe(effort)
  expect((await mainCall(w, { model: 'opus', effort: 'max' })).deny).toBe(effort)
  expect((await mainCall(w, { model: 'opus', effort: 'ultra' })).deny).toBe(effort)
  for (const e of ['low', 'medium', 'high', 'xhigh']) expect([e, (await mainCall(w, { model: 'sonnet', effort: e })).deny]).toEqual([e, undefined])
})

test('s7: a non-foundry: type from the main session, and a call from inside a crew, are unaffected by the main rule', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 2)
  await startSession($ as never)
  const model = str('MAIN_MODEL_REFUSAL')
  for (const type of ['general-purpose', 'kit:builder', 'Explore']) expect([type, (await w.agentCall(undefined, { subagent_type: type, name: 'q' })).deny]).toEqual([type, undefined])
  // inside a crew the 0.4.0 rules stand: the old refusal, not the main one
  const inside = await w.agentCall('A1', { subagent_type: 'foundry:judge', name: 'auth-helper' })
  expect(inside.deny).toBe(R.MODEL_REFUSAL)
  expect(inside.deny).not.toBe(model)
  expect((await w.agentCall('A1', { subagent_type: 'foundry:judge', name: 'auth-helper', model: 'opus', effort: 'xhigh' })).deny).toBeUndefined()
})

test('s7: outside a repo (no foundry dir) a foundry:* main call with no model goes through', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const a = build($ as never, on as never, { inRepo: false })
  await startSession($ as never)
  expect((await mainCall(a.w, {})).deny).toBeUndefined()
})

test('s7: with no plan.json a foundry:* main call with no model goes through', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const b = build($ as never, on as never)
  await startSession($ as never)
  expect((await mainCall(b.w, {})).deny).toBeUndefined()
  expect((await mainCall(b.w, { subagent_type: 'foundry:architect', name: 'arch' })).deny).toBeUndefined()
})

test('s7: with an unparseable plan.json a foundry:* main call with no model goes through', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const c = build($ as never, on as never)
  c.w.files.set(PLAN, '{nope')
  await startSession($ as never)
  expect((await mainCall(c.w, {})).deny).toBeUndefined()
})

test('s7: the main rule runs before the plan gates: a foundry:lead call with no model whose wave gate would also refuse gets MAIN_MODEL_REFUSAL', async ($, on) => {
  const { w } = build($ as never, on as never)
  setPlan(w, 2, 2, [
    { slug: 'billing-x', wave: 0, verdict: 'change', status: 'running' },
    { slug: 'ship', wave: 1, verdict: 'change', status: 'planned' },
  ])
  await startSession($ as never)
  const model = str('MAIN_MODEL_REFUSAL')
  const lead1 = (extra: Record<string, unknown>) => w.agentCall(undefined, { subagent_type: R.LEAD_TYPE, name: 'ship', ...extra })
  expect((await lead1({})).deny).toBe(model)
  // control: with model and effort set, the wave gate is what refuses
  expect(String((await lead1({ model: 'opus', effort: 'medium' })).deny)).toContain("wave 0 isn't merged yet")
})

// ---------------------------------------------------------------------------------------------
// 8. logs
// ---------------------------------------------------------------------------------------------

const newLogs = (w: W, before: number) => w.logs.slice(before)
const named = (lines: string[], rule: RegExp) => lines.some(l => (l.includes('[foundry]') || l.includes('foundry:')) && rule.test(l))

test('logs: each refusal and send-back adds a [foundry]/foundry: line naming the rule, and no line holds report text', async ($, on) => {
  const { w } = build($ as never, on as never, { git: gitAt(H2, P2) })
  setPlan(w, 2, 0)
  w.agents.push({ ...agent('J9', 'foundry:judge', 'auth-judge', 'L1'), status: 'completed' })
  await startSession($ as never)
  str('EXAMINED_REASON')

  let before = w.logs.length
  await lead($ as never, withoutHeadings())
  expect(named(newLogs(w, before), /examin/i)).toBe(true)

  before = w.logs.length
  await lead($ as never, report())
  expect(named(newLogs(w, before), /judge|pass/i)).toBe(true)

  setJudge(w, 'auth-judge', judgeText('PASS'), SINCE + 1000)
  before = w.logs.length
  await lead($ as never, report())
  expect(named(newLogs(w, before), /head/i)).toBe(true)

  // budget 0 and a PASS on disk: not spent; spend it, then refuse
  setJudge(w, 'auth-judge-2', judgeText('FAIL', { findings: SENTINEL }), SINCE + 2000)
  before = w.logs.length
  expect(String((await spawnJudge(w, 'A1', 'auth-judge-3')).deny).startsWith(`${MARK} Refused: repair budget spent:`)).toBe(true)
  expect(named(newLogs(w, before), /budget/i)).toBe(true)

  before = w.logs.length
  expect((await mainCall(w, { effort: 'medium' })).deny).toBe(str('MAIN_MODEL_REFUSAL'))
  expect(named(newLogs(w, before), /model|main/i)).toBe(true)
  before = w.logs.length
  expect((await mainCall(w, { model: 'opus' })).deny).toBe(str('MAIN_EFFORT_REFUSAL'))
  expect(named(newLogs(w, before), /effort|main/i)).toBe(true)

  // a lead hand-back that is sent back, and a judge FAIL report that spends the budget
  await handBack($ as never, 'L1', report({ extra: [] }))
  await handBack($ as never, 'J9', FAIL_BODY)
  await settle()

  expect(w.logs.join('\n')).not.toContain(SENTINEL)
})

// ---------------------------------------------------------------------------------------------
// 9. regression tests for red-team breaks
// ---------------------------------------------------------------------------------------------

test('regression A: a held-back v2 hand-back is saved when the stop goes through on a failing agent list', async ($, on) => {
  str('EXAMINED_REASON')
  const { w, wopts } = await cleanWorld($ as never, on as never)
  await handBack($ as never, 'L1', report({ extra: [], marker: 'HB-HELD' }))
  await settle()
  expect(savedWith(w, 'HB-HELD')).toBe(false)
  wopts.listFails = true
  expect(await lead($ as never, 'sign-off, no report here')).toBeUndefined()
  await settle()
  expect(savedWith(w, 'HB-HELD')).toBe(true)
})

test('regression B: a Branch name git would read as a revision expression runs no git and goes through', async ($, on) => {
  str('NO_HEAD_REASON')
  const { gitCalls } = await cleanWorld($ as never, on as never, { git: gitAt(H2, P2) })
  for (const name of ['HEAD', '@', 'a@{1}', 'a~1']) {
    gitCalls.length = 0
    const branch = `${name} at abc1234, based on def5678.`
    expect([branch, await lead($ as never, report({ branch }))]).toEqual([branch, undefined])
    expect([branch, gitCalls]).toEqual([branch, []])
  }
})

test('regression C: a hung read of the judge file does not hold a lead stop past the 2000 ms bound', async ($, on) => {
  str('NO_PASS_REASON')
  const { w } = await cleanWorld($ as never, on as never)
  w.holds.set(judgePath('auth-judge'), new Promise(() => {}))
  let done = false
  let block: string | undefined = 'pending'
  void lead($ as never, report()).then(b => {
    block = b
    done = true
  })
  await settle()
  await w.clock.advance(3000)
  await settle()
  expect(done).toBe(true)
  expect(block).toBeUndefined()
})

test('regression C: a hung read of plan.json does not hold a main-session foundry:judge call past the bound', async ($, on) => {
  str('MAIN_MODEL_REFUSAL')
  const { w } = await cleanWorld($ as never, on as never)
  w.holds.set(PLAN, new Promise(() => {}))
  let done = false
  let deny: string | undefined = 'pending'
  void mainCall(w, { model: 'opus', effort: 'medium' }).then(r => {
    deny = r.deny
    done = true
  })
  await settle()
  await w.clock.advance(3000)
  await settle()
  expect(done).toBe(true)
  expect(deny).toBeUndefined()
})
