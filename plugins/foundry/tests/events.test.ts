import { expect } from 'claude-code/testing'

import { EFFORT_REFUSAL, HANDBACK_REFUSAL, ROLL_BYTES, markerOf } from '../hooks/register'
import { NOW, ROOT, handBack, quiet, startSession, stop, world, test } from './harness'

// foundry 0.4.0 event log (ADR-0003 s1) and the HH:MM stamp (s2), past what contract.test.ts pins: tag and report
// lines, the idle-lead stall, the roll at ROLL_BYTES, refused calls, and an Edit holding HH:MM on both sides.

type W = ReturnType<typeof world>

const MIN = 60_000
const EVENTS = `${ROOT}/events.jsonl`
const LOG = `${ROOT}/decisions.md`
const pad = (n: number) => String(n).padStart(2, '0')
const at = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const lines = (w: W, path = EVENTS) => (w.files.get(path) ?? '').split('\n').filter(l => l.trim() !== '')
const events = (w: W) => lines(w).map(l => JSON.parse(l) as Record<string, unknown>)
const keys = (e: Record<string, unknown>) => Object.keys(e).sort()
const setStatus = (w: W, id: string, s: W['agents'][number]['status']) => {
  w.agents = w.agents.map(a => (a.id === id ? { ...a, status: s } : a))
}

test('a lead tagging its message to main appends one tag line, without the message text', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.send('L1', 'main', 'QUESTION: keep the v1 endpoint secret-text?\nOptions: keep or drop.')
  await w.send('L2', 'main', 'BLOCKED: no API key for staging')
  await w.send('L1', 'main', 'PROPOSAL: split the auth crew')
  // untagged: clears the tag, logs nothing
  await w.send('L1', 'main', 'merged, thanks')
  await settle()
  const got = events(w)
  expect(got.map(e => [e.event, e.crew, e.agent, e.tag])).toEqual([
    ['tag', 'auth', 'auth', 'QUESTION'],
    ['tag', 'billing', 'billing', 'BLOCKED'],
    ['tag', 'auth', 'auth', 'PROPOSAL'],
  ])
  for (const e of got) expect(keys(e)).toEqual(['agent', 'crew', 'event', 'tag', 'ts', 'v'])
  expect(lines(w).some(l => l.includes('secret-text') || l.includes('Options'))).toBe(false)
})

test('a refused SendMessage, a refused Agent call and a refused hand-back append nothing', async ($, on) => {
  const w = world($, on)
  await startSession($)
  // a member may not message main
  expect((await w.send('A1', 'main', 'QUESTION: may I?')).deny).toBeDefined()
  expect(await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-x', model: 'sonnet' })).toEqual({ deny: EFFORT_REFUSAL })
  expect(await handBack($, 'A1', 'done')).toEqual({ deny: HANDBACK_REFUSAL })
  await settle()
  expect(w.files.has(EVENTS)).toBe(false)
})

test('a lead started by the main session appends a spawn line with by main and the lead as its own crew', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.agentCall(undefined, { subagent_type: 'foundry:lead', name: 'docs', model: 'opus' })
  // outside every crew: no line
  await w.agentCall('X', { subagent_type: 'Explore', name: 'scout' })
  await settle()
  const got = events(w)
  expect(got.length).toBe(1)
  const e = got[0] ?? {}
  expect([e.event, e.crew, e.agent, e.agentId, e.type, e.model, e.effort, e.by]).toEqual(['spawn', 'docs', 'docs', 'new1', 'foundry:lead', 'opus', null, 'main'])
  expect(keys(e)).toEqual(['agent', 'agentId', 'by', 'crew', 'effort', 'event', 'model', 'ts', 'type', 'v'])
  expect(lines(w).some(l => l.includes('"p"') || l.includes('"d"'))).toBe(false)
})

test('a final report appends one report line with its marker; an interim stop appends none', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await handBack($, 'A1', 'VERDICT: PASS\nthe proof holds, every check ran and the diff matches the brief')
  await settle()
  await $.classic.SubagentStop(stop('B1', '\n\nCHECKPOINT: half done, the rest is listed in the handoff note below'))
  await settle()
  // L1 still has live members: its stop is interim and goes to auth.interim.md
  await $.classic.SubagentStop(stop('L1', 'waiting on my members to finish their work'))
  await settle()
  const got = events(w)
  expect(got.map(e => [e.event, e.crew, e.agent, e.marker])).toEqual([
    ['report', 'auth', 'auth-builder', 'VERDICT: PASS'],
    ['report', 'billing', 'billing-builder', 'CHECKPOINT'],
  ])
  for (const e of got) expect(keys(e)).toEqual(['agent', 'crew', 'event', 'marker', 'ts', 'v'])
  expect(lines(w).some(l => l.includes('proof holds') || l.includes('handoff'))).toBe(false)
})

test('markerOf reads the first non-empty line, else null', () => {
  expect(markerOf('VERDICT: FAIL\nwhy')).toBe('VERDICT: FAIL')
  expect(markerOf('  \n  REDTEAM 3 findings')).toBe('REDTEAM')
  expect(markerOf('QUESTION: which?')).toBe('QUESTION')
  expect(markerOf('PROPOSAL: x')).toBe('PROPOSAL')
  expect(markerOf('BLOCKED: x')).toBe('BLOCKED')
  expect(markerOf('## Summary\nVERDICT: PASS')).toBe(null)
  expect(markerOf('')).toBe(null)
})

test('an idle lead wake appends one stall line with kind idle-lead and the minutes its prompt shows', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(17 * MIN)
  await settle()
  await w.clock.advance(60 * MIN)
  await settle()
  const idle = events(w).filter(e => e.kind === 'idle-lead')
  expect(idle.length).toBe(1)
  const e = idle[0] ?? {}
  expect([e.event, e.crew, e.agent]).toEqual(['stall', 'auth', 'auth'])
  expect(keys(e)).toEqual(['agent', 'crew', 'event', 'kind', 'minutes', 'ts', 'v'])
  const prompt = w.prompts.find(p => p.startsWith('[foundry] idle lead: auth '))
  expect(prompt).toBeDefined()
  expect(Number(/no report for (\d+)m/.exec(prompt ?? '')?.[1])).toBe(e.minutes as number)
})

test('past ROLL_BYTES the log moves to the first free events.<n>.jsonl and starts over', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const big = `${'x'.repeat(ROLL_BYTES)}\n`
  w.files.set(EVENTS, big)
  w.files.set(`${ROOT}/events.1.jsonl`, 'old\n')
  await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-helper', model: 'sonnet', effort: 'low' })
  await settle()
  expect(w.files.get(`${ROOT}/events.1.jsonl`)).toBe('old\n')
  expect(w.files.get(`${ROOT}/events.2.jsonl`)).toBe(big)
  expect(events(w).map(e => [e.event, e.agent, e.effort])).toEqual([['spawn', 'auth-helper', 'low']])
  // under the limit it appends
  await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-helper-2', model: 'sonnet', effort: 'low' })
  await settle()
  expect(events(w).map(e => e.agent)).toEqual(['auth-helper', 'auth-helper-2'])
  expect(w.files.has(`${ROOT}/events.3.jsonl`)).toBe(false)
})

test('an Edit with HH:MM in both old_string and new_string gets the clock time; a clock time already there is kept', async ($, on) => {
  const w = world($, on)
  const before = '- 09:05 | start | plan | none | followed\n- HH:MM | a | b | c | followed\n'
  w.files.set(LOG, before)
  await $.tool.call({ tool: 'Edit', file_path: LOG, old_string: before, new_string: `${before}- HH:MM | d | e | f | followed\n` } as never)
  const call = w.ran.filter(c => c.tool === 'Edit').at(-1)
  expect(call?.old_string).toBe(before)
  expect(call?.new_string).toBe(`- 09:05 | start | plan | none | followed\n- ${at(NOW)} | a | b | c | followed\n- ${at(NOW)} | d | e | f | followed\n`)
})
