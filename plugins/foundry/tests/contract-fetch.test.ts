import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'

import * as mod from '../hooks/register'
import { ROOT, startSession, handBack, test, world } from './harness'

// Contract test for foundry 0.8.0, ADR-0005 section 11 "Fetch gate" (architecture.md): the pure fetchVerdict and the
// WebFetch/WebSearch handler that logs a `fetch` line. Written before the producer exists. fetchVerdict is read off
// the module namespace and asserted to be a function first, so on 0.7.1 each test fails on its own assertion and
// the file still loads. Synthetic data only (P8).
// Two groups are REGRESSION GUARDS that pass on 0.7.1 and must keep passing: leadStopPasses with and without a
// `## Learned` section, and the plan route writing nothing for an UNCOVERED-only hand-back.

type W = ReturnType<typeof world>
type Verdict = { kind: string; line: Record<string, unknown> | null }
type Fv = (tool: string, input: Record<string, unknown>, crew: string, agent: string, hasPlan: boolean) => Verdict

const fv = (): Fv => {
  const v = (mod as Record<string, unknown>).fetchVerdict
  expect(typeof v === 'function' ? 'function' : 'fetchVerdict is not exported as a function').toBe('function')
  return v as Fv
}

const EVENTS = `${ROOT}/events.jsonl`
const PLAN = `${ROOT}/plan.json`
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const events = (w: W) =>
  (w.files.get(EVENTS) ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
const fetches = (w: W) => events(w).filter(e => e.event === 'fetch')
const withPlan = (w: W) => w.files.set(PLAN, JSON.stringify({ version: 1, goal: 'g', approval: 'auto', approvedAt: null, maxParallelCrews: 4, crews: [] }))
const web = ($: Engine, from: string | undefined, fields: Record<string, unknown> = { url: 'https://example.com/a' }, tool = 'WebFetch') =>
  $.tool.call({ tool, ...fields, agentId: from } as never) as Promise<{ deny?: unknown }>
const reached = (w: W, tool = 'WebFetch') => w.ran.some(r => r.tool === tool)

const URL_IN = 'https://user:secret@example.com:8443/docs/api?version=2&lang=en#auth'
const URL_OUT = 'https://example.com:8443/docs/api?version=&lang='

// ---------- fetchVerdict, pure ----------

test('ADR-0005 fetchVerdict allows every call, with or without a plan', () => {
  const f = fv()
  for (const hasPlan of [true, false]) {
    expect(f('WebFetch', { url: URL_IN }, 'c', 'a', hasPlan).kind).toBe('allow')
    expect(f('WebSearch', { query: 'q' }, 'c', 'a', hasPlan).kind).toBe('allow')
    expect(f('WebFetch', {}, 'c', 'a', hasPlan).kind).toBe('allow')
  }
})

test('ADR-0005 fetchVerdict gives a null line when hasPlan is false', () => {
  const f = fv()
  expect(f('WebFetch', { url: URL_IN }, 'c', 'a', false).line).toBeNull()
  expect(f('WebSearch', { query: 'q' }, 'c', 'a', false).line).toBeNull()
})

test('ADR-0005 fetchVerdict passes crew, agent and tool through on a WebFetch line', () => {
  const line = fv()('WebFetch', { url: 'https://example.com/x' }, 'billing', 'billing-builder', true).line
  expect(line).toEqual({ event: 'fetch', crew: 'billing', agent: 'billing-builder', tool: 'WebFetch', url: 'https://example.com/x' })
})

test('ADR-0005 fetchVerdict passes crew, agent and tool through on a WebSearch line, with query and no url', () => {
  const line = fv()('WebSearch', { query: 'example-cli export flags' }, 'main', 'main', true).line
  expect(line).toEqual({ event: 'fetch', crew: 'main', agent: 'main', tool: 'WebSearch', query: 'example-cli export flags' })
  expect(line).not.toHaveProperty('url')
})

test('ADR-0005 fetchVerdict strips userinfo, query values and fragment, keeps scheme, host, port, path and keys', () => {
  expect(fv()('WebFetch', { url: URL_IN }, 'c', 'a', true).line?.url).toBe(URL_OUT)
})

test('ADR-0005 fetchVerdict keeps duplicate query keys, in order', () => {
  const url = fv()('WebFetch', { url: 'https://example.com/s?tag=a&x=1&tag=b#f' }, 'c', 'a', true).line?.url
  expect(url).toBe('https://example.com/s?tag=&x=&tag=')
})

test('ADR-0005 fetchVerdict drops a default port and leaves a url with no query or fragment alone', () => {
  const f = fv()
  expect(f('WebFetch', { url: 'https://example.com:443/docs' }, 'c', 'a', true).line?.url).toBe('https://example.com/docs')
  expect(f('WebFetch', { url: 'https://example.com/docs/page' }, 'c', 'a', true).line?.url).toBe('https://example.com/docs/page')
})

test('ADR-0005 fetchVerdict cuts a WebSearch query to its first 200 characters', () => {
  const q = 'x'.repeat(10_000)
  const got = fv()('WebSearch', { query: q }, 'c', 'a', true).line?.query as string
  expect(got).toBe('x'.repeat(200))
  const exact = 'y'.repeat(200)
  expect(fv()('WebSearch', { query: exact }, 'c', 'a', true).line?.query).toBe(exact)
  const keeps = `${'a'.repeat(199)}b${'c'.repeat(50)}`
  expect(fv()('WebSearch', { query: keeps }, 'c', 'a', true).line?.query).toBe(`${'a'.repeat(199)}b`)
})

test('ADR-0005 fetchVerdict logs "" for a url or query that is not a string', () => {
  const f = fv()
  for (const bad of [undefined, null, 42, { u: 1 }, ['https://example.com/']]) {
    expect(f('WebFetch', { url: bad }, 'c', 'a', true).line?.url).toBe('')
    expect(f('WebSearch', { query: bad }, 'c', 'a', true).line?.query).toBe('')
  }
})

test('ADR-0005 fetchVerdict logs "" for a url that does not parse', () => {
  expect(fv()('WebFetch', { url: 'not a url' }, 'c', 'a', true).line?.url).toBe('')
})

// ---------- the handler, through the harness ----------

test('ADR-0005 a WebFetch by a crew member writes a fetch line with the crew slug and the agent name', async ($, on) => {
  const w = world($, on)
  await startSession($)
  withPlan(w)
  const r = await web($, 'A1', { url: URL_IN })
  await settle()
  expect(r.deny).toBeUndefined()
  expect(reached(w)).toBe(true)
  const got = fetches(w)
  expect(got).toHaveLength(1)
  expect(got[0]).toMatchObject({ v: 1, event: 'fetch', crew: 'auth', agent: 'auth-builder', tool: 'WebFetch', url: URL_OUT })
  expect(typeof got[0].ts).toBe('string')
})

test('ADR-0005 a WebSearch by a crew member writes a query line cut to 200 characters', async ($, on) => {
  const w = world($, on)
  await startSession($)
  withPlan(w)
  await web($, 'B1', { query: 'q'.repeat(500) }, 'WebSearch')
  await settle()
  const got = fetches(w)
  expect(got).toHaveLength(1)
  expect(got[0]).toMatchObject({ event: 'fetch', crew: 'billing', agent: 'billing-builder', tool: 'WebSearch', query: 'q'.repeat(200) })
  expect(got[0]).not.toHaveProperty('url')
})

test('ADR-0005 a fetch by a foundry agent outside every crew is logged under crew main and its own name', async ($, on) => {
  const w = world($, on)
  await startSession($)
  withPlan(w)
  const r = await web($, 'C1', { url: 'https://example.com/docs' })
  await settle()
  expect(r.deny).toBeUndefined()
  expect(fetches(w)).toHaveLength(1)
  expect(fetches(w)[0]).toMatchObject({ crew: 'main', agent: 'cynic-1', tool: 'WebFetch', url: 'https://example.com/docs' })
})

test('ADR-0005 a fetch by the main session is logged with crew main and agent main', async ($, on) => {
  const w = world($, on)
  await startSession($)
  withPlan(w)
  const r = await web($, undefined, { query: 'example topic' }, 'WebSearch')
  await settle()
  expect(r.deny).toBeUndefined()
  expect(reached(w, 'WebSearch')).toBe(true)
  expect(fetches(w)).toHaveLength(1)
  expect(fetches(w)[0]).toMatchObject({ crew: 'main', agent: 'main', tool: 'WebSearch', query: 'example topic' })
})

test('ADR-0005 no fetch line is written when the foundry dir holds no plan.json, and the call still goes through', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const r = await web($, 'A1')
  await web($, undefined, { query: 'q' }, 'WebSearch')
  await settle()
  expect(r.deny).toBeUndefined()
  expect(reached(w)).toBe(true)
  expect(reached(w, 'WebSearch')).toBe(true)
  expect(fetches(w)).toEqual([])
  expect(w.files.has(EVENTS)).toBe(false)
  // the same session, once a plan exists, does log: the absence above is the gate, not a missing handler
  withPlan(w)
  await web($, 'A1')
  await settle()
  expect(fetches(w)).toHaveLength(1)
})

test('ADR-0005 a throwing fs.write never blocks the call, and the failure is logged', async ($, on) => {
  const w = world($, on)
  await startSession($)
  withPlan(w)
  let failed = 0
  w.failWrite = p => p.endsWith('events.jsonl') && failed++ === 0
  const r = await web($, 'A1')
  await settle()
  expect(r.deny).toBeUndefined()
  expect(reached(w)).toBe(true)
  expect(failed).toBeGreaterThan(0)
  // the failed append neither blocked the call nor broke the gate: the next call logs its line
  await web($, 'A1', { url: 'https://example.com/next' })
  await settle()
  expect(fetches(w).map(e => e.url)).toEqual(['https://example.com/next'])
})

// ---------- REGRESSION GUARDS: these pass on 0.7.1 and must keep passing ----------

const REPORT = ['## Summary', 'x', '## Branch', 'b', '## Changes', 'c', '## Proof', 'p', '## Checks run', 'k', '## Open questions', 'none'].join('\n')

test('ADR-0005 regression guard (passes on 0.7.1): leadStopPasses passes a report with ## Proof and no ## Learned', () => {
  expect(mod.leadStopPasses(REPORT)).toBe(true)
})

test('ADR-0005 regression guard (passes on 0.7.1): leadStopPasses passes a report with ## Proof and a ## Learned section', () => {
  const learned = `${REPORT}\n## Learned\n- Convention: example item\n`
  expect(mod.leadStopPasses(learned)).toBe(true)
})

test('ADR-0005 regression guard (passes on 0.7.1): leadStopPasses still refuses text with no Proof and no marker', () => {
  expect(mod.leadStopPasses('## Summary\nx\n## Learned\n- y')).toBe(false)
})

const DIR = 'C:/r/.git/foundry/S1'
test('ADR-0005 regression guard (passes on 0.7.1): a plan-mode hand-back of only UNCOVERED lines writes no plan.json or plan.md', async ($, on) => {
  const w = world($, ((name: string, handler: unknown) => (name === 'session.id' ? undefined : (on as (n: string, h: unknown) => unknown)(name, handler))) as unknown as On)
  on('session.id', async () => ({ value: 'S1' }))
  await startSession($)
  await w.agentCall(undefined, { subagent_type: 'foundry:architect', prompt: 'Mode: plan\nGoal: example goal', name: 'planner', model: 'opus', effort: 'high' })
  await handBack($, 'new1', 'UNCOVERED: payments | no module owns it\nUNCOVERED: search | the doc names no module')
  await settle()
  expect([...w.files.keys()].filter(k => k === `${DIR}/plan.json` || k === `${DIR}/plan.md`)).toEqual([])
})
