import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'

import { EVENT_WAIT_MS } from '../hooks/register'
import { ROOT, startSession, test, world } from './harness'

// Extra tests for the fetch gate (ADR-0005 section 11) beyond contract-fetch.test.ts: the handler's bounds on a slow or
// throwing file system, and the edges of the logged url and query. Synthetic data only (P8).

type Mode = { exists?: 'hang' | 'throw' }

// world() with `fs.exists` of plan.json made to hang or throw, the one call the fetch handler's plan check makes
const build = ($: Engine, on: On, mode: Mode) => {
  const wrapped = ((name: string, handler: unknown) => {
    if (name !== 'fs.exists') return (on as (n: string, h: unknown) => unknown)(name, handler)
    return (on as (n: string, h: unknown) => unknown)(name, (c: unknown, e: { path: string }) => {
      if (e.path.endsWith('plan.json') && mode.exists === 'hang') return new Promise(() => {})
      if (e.path.endsWith('plan.json') && mode.exists === 'throw') return Promise.reject(new Error('fs is down'))
      return (handler as (c: unknown, e: unknown) => unknown)(c, e)
    })
  }) as unknown as On
  return world($, wrapped)
}

const EVENTS = `${ROOT}/events.jsonl`
const PLAN = `${ROOT}/plan.json`
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const fetches = (w: ReturnType<typeof world>) =>
  (w.files.get(EVENTS) ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(e => e.event === 'fetch')
const withPlan = (w: ReturnType<typeof world>) => w.files.set(PLAN, JSON.stringify({ version: 1, goal: 'g', approval: 'auto', approvedAt: null, maxParallelCrews: 4, crews: [] }))
const web = ($: Engine, fields: Record<string, unknown>, tool = 'WebFetch') =>
  $.tool.call({ tool, ...fields, agentId: undefined } as never) as Promise<{ deny?: unknown }>

test('fetch: a plan.json check that hangs lets the call through within the bound and writes no line', async ($, on) => {
  const w = build($, on, { exists: 'hang' })
  await startSession($)
  withPlan(w)
  let done = false
  let deny: unknown = 'pending'
  void web($, { url: 'https://example.com/a' }).then(r => {
    deny = r.deny
    done = true
  })
  await settle()
  expect(done).toBe(false)
  await w.clock.advance(EVENT_WAIT_MS + 100)
  await settle()
  expect(done).toBe(true)
  expect(deny).toBeUndefined()
  expect(w.ran.some(r => r.tool === 'WebFetch')).toBe(true)
  expect(fetches(w)).toEqual([])
})

test('fetch: a throwing plan.json check lets the call through and writes no line', async ($, on) => {
  const w = build($, on, { exists: 'throw' })
  await startSession($)
  withPlan(w)
  const r = await web($, { url: 'https://example.com/a' })
  await settle()
  expect(r.deny).toBeUndefined()
  expect(w.ran.some(r => r.tool === 'WebFetch')).toBe(true)
  expect(fetches(w)).toEqual([])
})

test('fetch: a missing url and a missing query are logged as ""', async ($, on) => {
  const w = build($, on, {})
  await startSession($)
  withPlan(w)
  await web($, {})
  await web($, {}, 'WebSearch')
  await settle()
  const got = fetches(w)
  expect(got).toHaveLength(2)
  expect(got[0]).toMatchObject({ tool: 'WebFetch', url: '' })
  expect(got[1]).toMatchObject({ tool: 'WebSearch', query: '' })
})

test('fetch: a url with no query or fragment gains no ? or #', async ($, on) => {
  const w = build($, on, {})
  await startSession($)
  withPlan(w)
  await web($, { url: 'https://example.com/docs/page' })
  await web($, { url: 'https://example.com/docs/page?#' })
  await settle()
  expect(fetches(w).map(e => e.url)).toEqual(['https://example.com/docs/page', 'https://example.com/docs/page'])
})

test('fetch: a 10,000-character query is logged as its first 200 characters', async ($, on) => {
  const w = build($, on, {})
  await startSession($)
  withPlan(w)
  await web($, { query: 'z'.repeat(10_000) }, 'WebSearch')
  await settle()
  expect(fetches(w).map(e => e.query)).toEqual(['z'.repeat(200)])
})
