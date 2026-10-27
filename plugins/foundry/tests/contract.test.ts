import { expect } from 'claude-code/testing'

import { HEARTBEAT_MS, MODEL_REFUSAL, STALL_MS } from '../hooks/register'
import { NOW, ROOT, startSession, world, test } from './harness'

// Contract test for foundry ADR-0003 "Seams" 1 and 3: the event log at <foundry dir>/events.jsonl
// (shape: docs/events.schema.json) and the HH:MM stamp. Written by foundry run 2's design crew before
// the producer exists; it imports only names register.ts exports today.

type W = ReturnType<typeof world>

const EVENTS = `${ROOT}/events.jsonl`
const LOG = `${ROOT}/decisions.md`
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const FAILED = 'foundry: event log failed, letting the call through:'
const pad = (n: number) => String(n).padStart(2, '0')
const at = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

// appends go through a promise chain: let it drain before reading
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const raw = (w: W) => (w.files.get(EVENTS) ?? '').split('\n').filter(l => l.trim() !== '')
const events = (w: W) => raw(w).map(l => JSON.parse(l) as Record<string, unknown>)

// auth-builder (A1, crew auth) starts a member of its own
const memberCall = (w: W, extra: Record<string, unknown> = {}) =>
  w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-helper', model: 'sonnet', effort: 'medium', ...extra })

test('a crew member Agent call with model and effort appends exactly one spawn line', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const r = await memberCall(w)
  expect(r.deny).toBeUndefined()
  await settle()
  const lines = events(w)
  expect(lines.length).toBe(1)
  const e = lines[0] ?? {}
  expect(e.v).toBe(1)
  expect(e.event).toBe('spawn')
  expect(e.crew).toBe('auth')
  expect(e.agent).toBe('auth-helper')
  expect(e.by).toBe('auth-builder')
  expect(e.type).toBe('kit:builder')
  expect(e.model).toBe('sonnet')
  expect(e.effort).toBe('medium')
  expect(typeof e.ts === 'string' && ISO.test(e.ts)).toBe(true)
  expect(e.agentId === null || typeof e.agentId === 'string').toBe(true)
})

test('a call the hooks refuse (no model) appends nothing; the next allowed call appends one', async ($, on) => {
  const w = world($, on)
  await startSession($)
  expect(await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-nomodel' })).toEqual({ deny: MODEL_REFUSAL })
  await settle()
  expect(raw(w)).toEqual([])
  await memberCall(w)
  await settle()
  expect(events(w).map(e => [e.event, e.agent])).toEqual([['spawn', 'auth-helper']])
})

test('a crew agent idle past STALL_MS appends one stall line with kind agent, once', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(STALL_MS)
  await settle()
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  await settle()
  const stalls = events(w).filter(e => e.event === 'stall' && e.agent === 'auth-builder')
  expect(stalls.length).toBe(1)
  expect(stalls[0]?.kind).toBe('agent')
  expect(stalls[0]?.crew).toBe('auth')
  expect(typeof stalls[0]?.minutes).toBe('number')
})

test('every line parses as JSON and carries v, ts, event, crew and agent', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await memberCall(w)
  await w.activity('A1')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  await settle()
  const lines = raw(w)
  expect(lines.length > 0).toBe(true)
  for (const line of lines) {
    const e = JSON.parse(line) as Record<string, unknown>
    expect(e.v).toBe(1)
    expect(typeof e.ts === 'string' && ISO.test(e.ts)).toBe(true)
    expect(['spawn', 'stall', 'tag', 'report']).toContain(e.event)
    expect(typeof e.crew === 'string' && e.crew !== '').toBe(true)
    expect(typeof e.agent === 'string' && e.agent !== '').toBe(true)
  }
})

test('with fs.write failing for events.jsonl, the Agent call still goes through with its report note, and the failure is logged', async ($, on) => {
  const w = world($, on)
  await startSession($)
  // only event-log writes fail; every other write lands as usual
  const real = w.files
  w.files = new (class extends Map<string, string> {
    override set(k: string, v: string) {
      if (/\/events(\.\d+)?\.jsonl$/.test(k)) throw new Error('disk full')
      return super.set(k, v)
    }
  })(real)
  const before = w.ran.filter(c => c.tool === 'Agent').length
  const r = await w.agentCall('L1', { model: 'sonnet', effort: 'medium', name: 'auth-tester' })
  await settle()
  expect(r.deny).toBeUndefined()
  expect(w.ran.filter(c => c.tool === 'Agent').length).toBe(before + 1)
  expect(r.context).toEqual([`[foundry] If auth-tester's report does not reach you, read ${ROOT}/reports/auth/auth-tester.md once it stops.`])
  expect(w.logs.filter(l => l.startsWith(FAILED)).length).toBe(1)
})

// ---------- stamp hook: the literal HH:MM ----------

test('a Write of decisions.md with a new "- HH:MM |" line reaches disk with the clock time', async ($, on) => {
  const w = world($, on)
  await $.tool.call({ tool: 'Write', file_path: LOG, content: '- HH:MM | x | y | z | followed\n' } as never)
  expect(w.ran.filter(c => c.tool === 'Write').at(-1)?.content).toBe(`- ${at(NOW)} | x | y | z | followed\n`)
})

test('a literal HH:MM already in the log is stamped too, since it marks no time', async ($, on) => {
  const w = world($, on)
  w.files.set(LOG, '- HH:MM | a | b | c | followed\n')
  await $.tool.call({ tool: 'Write', file_path: LOG, content: '- HH:MM | a | b | c | followed\n' } as never)
  expect(w.ran.filter(c => c.tool === 'Write').at(-1)?.content).toBe(`- ${at(NOW)} | a | b | c | followed\n`)
})
