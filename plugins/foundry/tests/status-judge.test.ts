import { expect } from 'claude-code/testing'

import { judgeRuling, LEAD_TYPE } from '../hooks/register'
import { agent, ROOT, startSession, test, world } from './harness'

// /foundry status must show the verdict the merge gate would read: the newest judge file at or after the plan's
// approvedAt, ruled by judgeRuling. Driven through the command entry point, with no un-exported names.

const APPROVED = '2026-10-17T11:00:00Z'
const SINCE = Date.parse(APPROVED)
const HOUR = 3_600_000

type W = ReturnType<typeof world>
const status = async ($: Parameters<typeof startSession>[0]) => ((await $.command.run({ command: 'foundry', args: '' } as never)) as { text?: string }).text ?? ''

const setPlan = (w: W) =>
  w.files.set(`${ROOT}/plan.json`, JSON.stringify({ version: 1, goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, crews: [{ slug: 'auth', wave: 0, verdict: 'change', status: 'running' }] }))
const put = (w: W, crew: string, file: string, text: string, mtimeMs: number) => {
  const p = `${ROOT}/reports/${crew}/${file}`
  w.files.set(p, text)
  w.mtimes.set(p, mtimeMs)
}
// the judge lines status prints, one per crew that has one
const judgeLines = (text: string) => text.split('\n').filter(l => /^\s*judge:/.test(l))
const onlyAuth = (w: W) => {
  w.agents = [agent('L1', LEAD_TYPE, 'auth')]
}

test('status shows the newest judge file by mtime, not the highest -judge-<k>', async ($, on) => {
  const w = world($, on)
  setPlan(w)
  onlyAuth(w)
  put(w, 'auth', 'auth-judge-2.md', 'VERDICT: FAIL\nround two', SINCE + HOUR)
  put(w, 'auth', 'auth-judge.md', 'VERDICT: PASS\nre-ruled later', SINCE + 2 * HOUR)
  await startSession($)
  expect(judgeLines(await status($))).toEqual(['  judge: PASS'])
})

test('status ignores a judge file from before approvedAt even with the highest k', async ($, on) => {
  const w = world($, on)
  setPlan(w)
  onlyAuth(w)
  put(w, 'auth', 'auth-judge.md', 'VERDICT: PASS\nthis run', SINCE + HOUR)
  put(w, 'auth', 'auth-judge-3.md', 'VERDICT: FAIL\nstale run', SINCE - HOUR)
  await startSession($)
  expect(judgeLines(await status($))).toEqual(['  judge: PASS'])
})

test('status shows no judge line when every judge file predates approvedAt', async ($, on) => {
  const w = world($, on)
  setPlan(w)
  onlyAuth(w)
  put(w, 'auth', 'auth-judge-2.md', 'VERDICT: FAIL\nstale', SINCE - HOUR)
  await startSession($)
  expect(judgeLines(await status($))).toEqual([])
})

test('status rules a no-space VERDICT:PASS first line the way judgeRuling does', async ($, on) => {
  const text = 'VERDICT:PASS\nbody'
  const ruled = judgeRuling(text).verdict
  // the gate's parser does not take the no-space marker as a ruling
  expect(ruled).toBeUndefined()
  const w = world($, on)
  setPlan(w)
  onlyAuth(w)
  put(w, 'auth', 'auth-judge.md', text, SINCE + HOUR)
  await startSession($)
  expect(judgeLines(await status($))).toEqual([])
})

test('a successor lead reads its own reports and picks its own newest file the same way', async ($, on) => {
  const w = world($, on)
  setPlan(w)
  w.agents = [agent('L1', LEAD_TYPE, 'auth'), agent('L3', LEAD_TYPE, 'auth-2')]
  put(w, 'auth', 'auth-judge.md', 'VERDICT: FAIL\nfirst lead', SINCE + HOUR)
  put(w, 'auth-2', 'auth-2-judge-2.md', 'VERDICT: FAIL\nround two', SINCE + HOUR)
  put(w, 'auth-2', 'auth-2-judge.md', 'VERDICT: PASS\nre-ruled later', SINCE + 2 * HOUR)
  await startSession($)
  expect(judgeLines(await status($))).toEqual(['  judge: FAIL', '  judge: PASS'])
})
