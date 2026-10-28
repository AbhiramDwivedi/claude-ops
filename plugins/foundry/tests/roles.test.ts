import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'

import { handBack, startSession, test, world } from './harness'

// ADR-0015 item 9: the plan-file route, the cases contract-roles.test.ts does not cover. Written from the ADR alone;
// the helpers are copied, not imported.

type W = ReturnType<typeof world>

const DIR = 'C:/r/.git/foundry/S1'
const PLAN_JSON = `${DIR}/plan.json`
const PLAN_MD = `${DIR}/plan.md`
const FENCE = '````'
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

const planWith = (over: Record<string, unknown> = {}) => ({
  version: 1,
  goal: 'Add rate limiting to the public API',
  architecture: 'docs/architecture.md',
  approval: 'owner',
  approvedAt: '2026-10-28T15:00:00Z',
  agentCap: 40,
  maxParallelCrews: 4,
  crews: [crew('quotas', 0, 'change'), crew('gateway', 1, 'extend')],
  ...over,
})
const CARRIED = planWith()
const MD = '# Plan\n\nWave 0: quotas.\nWave 1: gateway.'
const jsonOf = (p: unknown) => JSON.stringify(p, null, 2)
const expectedJson = (p: Record<string, unknown>) => JSON.stringify({ ...p, approvedAt: null }, null, 2) + '\n'

const jsonBlock = (json: string) => [`${FENCE}json plan.json`, json, FENCE]
const mdBlock = (md: string) => [`${FENCE}markdown plan.md`, md, FENCE]
const join = (...parts: string[][]) => ['VERDICT: plan ready.', ...parts.flat(), 'Report: done.'].join('\n')

const setup = async ($: Engine, on: On): Promise<W> => {
  const w = world($, ((name: string, handler: unknown) => (name === 'session.id' ? undefined : (on as (n: string, h: unknown) => unknown)(name, handler))) as unknown as On)
  on('session.id', async () => ({ value: 'S1' }))
  await startSession($)
  return w
}

const spawn = (w: W, from: string | undefined, type: string, prompt: string) =>
  w.agentCall(from, { subagent_type: type, prompt, name: 'planner', model: 'opus', effort: 'high' })

const logged = (w: W, start: string) => w.logs.filter(l => l.startsWith(start))
const planKeys = (w: W) => [...w.files.keys()].filter(k => k.toLowerCase().includes('plan'))

test('a second plan.json block is ignored: the first block counts', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  const other = planWith({ goal: 'A different goal', crews: [crew('only', 0, 'change')] })
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD), jsonBlock(jsonOf(other))))
  expect(w.files.get(PLAN_JSON)).toBe(expectedJson(CARRIED))
  expect(w.files.get(PLAN_MD)).toBe(MD)
})

test('a second plan.json block counts nothing even when the first one is invalid', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock('{"crews": 3}'), mdBlock(MD), jsonBlock(jsonOf(CARRIED))))
  expect(planKeys(w)).toEqual([])
  expect(logged(w, NOTHING).length).toBeGreaterThan(0)
})

test('a second plan.md block is ignored: the first block counts', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD), mdBlock('# Another plan')))
  expect(w.files.get(PLAN_MD)).toBe(MD)
  expect(w.files.get(PLAN_JSON)).toBe(expectedJson(CARRIED))
})

test('a hand-back with only a plan.md block writes nothing and logs why', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(mdBlock(MD)))
  expect(planKeys(w)).toEqual([])
  expect(logged(w, NOTHING).length).toBeGreaterThan(0)
})

// Spec: the first line of the prompt, "with a trailing \r and spaces trimmed, is exactly Mode: plan". So trailing
// spaces and a CR are trimmed and the rest must equal the literal: a trailing "ning" or a leading space is not trimmed.
test('a first line of "Mode: plan  \\r" (trailing spaces and CR) is recorded and written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan  \r\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))
  expect(w.files.get(PLAN_JSON)).toBe(expectedJson(CARRIED))
  expect(w.files.get(PLAN_MD)).toBe(MD)
})

test('a first line of "Mode: plan\\r" (CR only, CRLF prompt) is recorded and written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\r\nGoal: rate limiting\r\n')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))
  expect(w.files.has(PLAN_JSON)).toBe(true)
  expect(w.files.has(PLAN_MD)).toBe(true)
})

test('a first line of "Mode: planning" is not recorded: nothing is written', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: planning\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))
  expect(planKeys(w)).toEqual([])
})

test('a first line of " Mode: plan" (leading space, which the spec does not trim) is not recorded', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', ' Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))
  expect(planKeys(w)).toEqual([])
})

test('"Mode: plan" on a later line, not the first, is not recorded', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Goal: rate limiting\nMode: plan')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))
  expect(planKeys(w)).toEqual([])
})

// The hand-back "reaches the foreman as today": the hook returns next(e), it does not deny. A foreman-level architect
// belongs to no crew, so today no reports/ file is written for it, and the route adds none.
test('a plan-mode architect hand-back is not denied, and adds no file besides plan.json and plan.md', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  const r = (await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))) as { deny?: unknown } | undefined
  expect(r?.deny).toBeUndefined()
  expect(w.files.has(PLAN_JSON)).toBe(true)
  expect([...w.files.keys()].filter(k => k.includes('/reports/'))).toEqual([])
})

test('a failed route does not deny the hand-back either', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  const r = (await handBack($, 'new1', join(jsonBlock('{not json'), mdBlock(MD)))) as { deny?: unknown } | undefined
  expect(r?.deny).toBeUndefined()
  expect(logged(w, NOTHING).length).toBeGreaterThan(0)
})

test('the written files sit directly under the foundry dir and nothing else has plan in its path', async ($, on) => {
  const w = await setup($, on)
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD)))
  expect(w.files.has(PLAN_JSON)).toBe(true)
  expect(planKeys(w).sort()).toEqual([PLAN_JSON, PLAN_MD])
})

test('an architecture of ../../../evil still writes only the two fixed paths', async ($, on) => {
  const w = await setup($, on)
  const evil = planWith({ architecture: '../../../evil' })
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(evil)), mdBlock(MD)))
  expect(w.files.get(PLAN_JSON)).toBe(expectedJson(evil))
  expect([...w.files.keys()].filter(k => k.includes('evil') || k.includes('..'))).toEqual([])
  expect(planKeys(w).sort()).toEqual([PLAN_JSON, PLAN_MD])
})

test('a goal containing ../ still writes only the two fixed paths', async ($, on) => {
  const w = await setup($, on)
  const evil = planWith({ goal: 'Replace ../../etc/passwd handling ../ everywhere' })
  await spawn(w, undefined, 'foundry:architect', 'Mode: plan\nGoal: rate limiting')
  await handBack($, 'new1', join(jsonBlock(jsonOf(evil)), mdBlock(MD)))
  expect(w.files.get(PLAN_JSON)).toBe(expectedJson(evil))
  expect([...w.files.keys()].filter(k => k.includes('..'))).toEqual([])
  expect(planKeys(w).sort()).toEqual([PLAN_JSON, PLAN_MD])
})

// Foreground and failure paths of the route. Claude Code runs a foreground Agent call's subagent inside the tool call:
// the architect's agent.spawn fires and its SubagentHandback arrives BEFORE the Agent call's next() returns. The spawn
// belongs to its Agent call by tool_use_id. The mock beneath foundry holds the Agent call open until the test releases
// it (a hook module may not call $.agent.spawn itself, so the test drives the spawn and the hand-back meanwhile).
type Held = { w: W; release: () => void; started: Promise<void>; denyHandBacks: { on: boolean } }
const setupHeld = async ($: Engine, on: On): Promise<Held> => {
  const wrapped = ((name: string, handler: unknown) => (name === 'session.id' || name === 'tool.call' ? undefined : (on as (n: string, h: unknown) => unknown)(name, handler))) as unknown as On
  const w = world($, wrapped)
  let release = () => {}
  let begun = () => {}
  const gate = new Promise<void>(r => (release = r))
  const started = new Promise<void>(r => (begun = r))
  const denyHandBacks = { on: false }
  on('session.id', async () => ({ value: 'S1' }))
  on('agent.spawn', (async (_: Engine, e: { tool_use_id?: string }) => ({ agentId: e.tool_use_id === 'tu-other' ? 'other1' : 'new1', model: 'opus' })) as never)
  on('tool.call', (async (_: Engine, e: Record<string, unknown>) => {
    w.ran.push(e)
    if (e.tool === 'SubagentHandback' && denyHandBacks.on) return { deny: 'refused beneath foundry' }
    if (e.tool !== 'Agent') return { result: 'ok' }
    begun()
    await gate
    return { result: { agentId: 'new1' } }
  }) as never)
  await startSession($)
  return { w, release, started, denyHandBacks }
}
const fullMessage = () => join(jsonBlock(jsonOf(CARRIED)), mdBlock(MD))
const callTu = (w: W, prompt: string) => w.agentCall(undefined, { subagent_type: 'foundry:architect', prompt, name: 'planner', model: 'opus', effort: 'high', tool_use_id: 'tu-plan' })
const spawnFor = ($: Engine, prompt: string, toolUseId: string, name = 'planner') =>
  $.agent.spawn({ subagentType: 'foundry:architect', prompt, description: 'd', name, tool_use_id: toolUseId } as never)
const handBackFrom = ($: Engine, id: string, message = fullMessage()) => handBack($, id, message)

test('foreground: a plan-mode architect whose hand-back arrives before the Agent call returns is written', async ($, on) => {
  const h = await setupHeld($, on)
  const call = callTu(h.w, 'Mode: plan\nGoal: rate limiting')
  await h.started
  await spawnFor($, 'Mode: plan\nGoal: rate limiting', 'tu-plan')
  await handBackFrom($, 'new1')
  h.release()
  await call
  expect(h.w.files.get(PLAN_JSON)).toBe(expectedJson(CARRIED))
  expect(h.w.files.get(PLAN_MD)).toBe(MD)
})

test('foreground: the same flow with Mode: design writes nothing', async ($, on) => {
  const h = await setupHeld($, on)
  const call = callTu(h.w, 'Mode: design\nGoal: rate limiting')
  await h.started
  await spawnFor($, 'Mode: design\nGoal: rate limiting', 'tu-plan')
  await handBackFrom($, 'new1')
  h.release()
  await call
  expect(planKeys(h.w)).toEqual([])
})

test('foreground: an unrelated spawn (other tool_use_id) in between is not recorded; the plan architect still writes', async ($, on) => {
  const h = await setupHeld($, on)
  const call = callTu(h.w, 'Mode: plan\nGoal: rate limiting')
  await h.started
  // a background architect from another Agent call, with a Mode: plan prompt of its own
  await spawnFor($, 'Mode: plan\nGoal: other', 'tu-other', 'other')
  await handBackFrom($, 'other1')
  expect(planKeys(h.w)).toEqual([])
  await spawnFor($, 'Mode: plan\nGoal: rate limiting', 'tu-plan')
  await handBackFrom($, 'new1')
  h.release()
  await call
  expect(h.w.files.get(PLAN_JSON)).toBe(expectedJson(CARRIED))
  expect(h.w.files.get(PLAN_MD)).toBe(MD)
})

test('a hand-back that a hook beneath foundry denies writes no plan files; a later accepted one does', async ($, on) => {
  const h = await setupHeld($, on)
  const call = callTu(h.w, 'Mode: plan\nGoal: rate limiting')
  await h.started
  await spawnFor($, 'Mode: plan\nGoal: rate limiting', 'tu-plan')
  // the Agent call returns first, so this test is about the denial alone
  h.release()
  await call
  h.denyHandBacks.on = true
  await handBackFrom($, 'new1')
  expect(planKeys(h.w)).toEqual([])
  h.denyHandBacks.on = false
  await handBackFrom($, 'new1')
  expect(h.w.files.get(PLAN_JSON)).toBe(expectedJson(CARRIED))
  expect(h.w.files.get(PLAN_MD)).toBe(MD)
})

test('plan.md failing after plan.json was written logs "wrote plan.json but not plan.md"', async ($, on) => {
  const h = await setupHeld($, on)
  h.w.failWrite = p => p === PLAN_MD
  const call = callTu(h.w, 'Mode: plan\nGoal: rate limiting')
  await h.started
  await spawnFor($, 'Mode: plan\nGoal: rate limiting', 'tu-plan')
  h.release()
  await call
  await handBackFrom($, 'new1')
  expect(h.w.files.has(PLAN_JSON)).toBe(true)
  expect(h.w.files.has(PLAN_MD)).toBe(false)
  expect(logged(h.w, 'foundry: plan-file route wrote plan.json but not plan.md:').length).toBeGreaterThan(0)
})
