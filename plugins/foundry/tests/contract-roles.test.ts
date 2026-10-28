import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'

import { parsePlan } from '../hooks/register'
import { handBack, startSession, test, world } from './harness'

// ADR-0015 item 9 and cases 18-21: the plan-file route. The foreman's plan-mode foundry:architect hands its plan back in
// two four-backtick blocks and foundry's hook writes <foundry dir>/plan.json and plan.md. Written from the ADR alone.

type W = ReturnType<typeof world>

const DIR = 'C:/r/.git/foundry/S1'
const PLAN_JSON = `${DIR}/plan.json`
const PLAN_MD = `${DIR}/plan.md`
const FENCE = '````'
const KEPT = 'foundry: plan-file route kept the existing plan:'
const NOTHING = 'foundry: plan-file route wrote nothing:'

const crew = (slug: string, wave: number, verdict: string) => ({
  slug,
  wave,
  verdict,
  modules: [slug],
  owns: [`src/${slug}/**`],
  doneCheck: `pnpm test -- ${slug}`,
  doneCheckProved: true,
  estAgents: 4,
  status: 'planned',
})

// P8: a valid plan, approvedAt as the ADR's hand-back carries it
const planWith = (approvedAt: string | null) => ({
  version: 1,
  goal: 'Add rate limiting to the public API',
  architecture: 'docs/architecture.md',
  approval: 'owner',
  approvedAt,
  agentCap: 40,
  maxParallelCrews: 4,
  crews: [crew('quotas', 0, 'change'), crew('gateway', 1, 'extend')],
})
const CARRIED = planWith('2026-10-28T15:00:00Z')
const MD = '# Plan\n\nWave 0: quotas.\nWave 1: gateway.'

const message = (json: string | undefined = JSON.stringify(CARRIED, null, 2), md: string | undefined = MD) =>
  [
    'VERDICT: plan ready, both files below.',
    ...(json === undefined ? [] : [`${FENCE}json plan.json`, json, FENCE]),
    ...(md === undefined ? [] : [`${FENCE}markdown plan.md`, md, FENCE]),
    'Report: two crews, one wave each.',
  ].join('\n')

// the harness answers session.id 's1'; the ADR's foundry dir is under S1
const setup = async ($: Engine, on: On): Promise<W> => {
  const w = world($, ((name: string, handler: unknown) => (name === 'session.id' ? undefined : (on as (n: string, h: unknown) => unknown)(name, handler))) as unknown as On)
  on('session.id', async () => ({ value: 'S1' }))
  await startSession($)
  return w
}

const spawn = (w: W, from: string | undefined, type: string, prompt: string) =>
  w.agentCall(from, { subagent_type: type, prompt, name: 'planner', model: 'opus', effort: 'high' })

const planWrites = (w: W) => [...w.files.keys()].filter(k => k === PLAN_JSON || k === PLAN_MD)
const logged = (w: W, start: string) => w.logs.filter(l => l.startsWith(start))

test('fixture: the synthetic plan P8 is one parsePlan accepts', async () => {
  expect(parsePlan(JSON.stringify(CARRIED))).toBeDefined()
  expect(parsePlan('{"crews": 3}')).toBeUndefined()
})

test('case 18: the foreman plan-mode architect hand-back writes plan.json and plan.md', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(w.files.has(PLAN_JSON)).toBe(true)
  expect(w.files.has(PLAN_MD)).toBe(true)
})

test('case 18 negative: an architect started inside a crew (agentId set) is not written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, 'L1', 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(planWrites(w)).toEqual([])
})

test('case 18 negative: an architect whose prompt starts Mode: design is not written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: design\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(planWrites(w)).toEqual([])
})

test('case 18 negative: an architect whose prompt starts Mode: init is not written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: init\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(planWrites(w)).toEqual([])
})

test('case 18 negative: a foundry:judge from the main session with Mode: plan is not written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:judge', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(planWrites(w)).toEqual([])
})

test('case 18 negative: a foundry:lead with Mode: plan is not written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:lead', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(planWrites(w)).toEqual([])
})

test('case 18 negative: a general-purpose agent with Mode: plan is not written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'general-purpose', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(planWrites(w)).toEqual([])
})

test('case 19: an approved plan on disk is never overwritten, and the keep is logged', async ($, on) => {
  const w = await setup($, on)
  const existing = JSON.stringify(planWith('2026-10-28T15:11:50Z'), null, 2) + '\n'
  w.files.set(PLAN_JSON, existing)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(w.files.get(PLAN_JSON)).toBe(existing)
  expect(w.files.has(PLAN_MD)).toBe(false)
  expect(logged(w, KEPT).length).toBeGreaterThan(0)
})

test('case 19: an existing plan with approvedAt null is replaced, both files written', async ($, on) => {
  const w = await setup($, on)
  w.files.set(PLAN_JSON, JSON.stringify(planWith(null), null, 2) + '\n')
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(w.files.get(PLAN_MD)).toBe(MD)
  expect(JSON.parse(w.files.get(PLAN_JSON) ?? '{}')).toEqual({ ...CARRIED, approvedAt: null })
  expect(logged(w, KEPT)).toEqual([])
})

test('case 19: an unreadable existing plan is kept', async ($, on) => {
  const w = await setup($, on)
  w.files.set(PLAN_JSON, '{not json')
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  expect(w.files.get(PLAN_JSON)).toBe('{not json')
  expect(w.files.has(PLAN_MD)).toBe(false)
  expect(logged(w, KEPT).length).toBeGreaterThan(0)
})

test('case 20: plan.json is written with approvedAt null and the rest of the carried plan; plan.md is the block text', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message())
  const text = w.files.get(PLAN_JSON) ?? ''
  expect(text).not.toBe('')
  const written = JSON.parse(text) as Record<string, unknown>
  expect(written.approvedAt).toBe(null)
  expect(written).toEqual({ ...CARRIED, approvedAt: null })
  expect(text).toBe(JSON.stringify({ ...CARRIED, approvedAt: null }, null, 2) + '\n')
  expect(w.files.get(PLAN_MD)).toBe(MD)
})

test('case 21: a plan.json block of {"crews": 3} writes nothing and logs why', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message('{"crews": 3}'))
  expect(planWrites(w)).toEqual([])
  expect(logged(w, NOTHING).length).toBeGreaterThan(0)
})

test('case 21: a plan.json block of {not json writes nothing and logs why', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message('{not json'))
  expect(planWrites(w)).toEqual([])
  expect(logged(w, NOTHING).length).toBeGreaterThan(0)
})

test('case 21: a hand-back with no plan.md block writes nothing and logs why', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', message(undefined, undefined))
  expect(planWrites(w)).toEqual([])
  expect(logged(w, NOTHING).length).toBeGreaterThan(0)
})
