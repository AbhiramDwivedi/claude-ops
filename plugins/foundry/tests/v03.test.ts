import { expect, test } from 'claude-code/testing'

import { LEAD_TYPE } from '../hooks/register'
import { ROOT, status, world } from './harness'

// foundry 0.3.0: the plan gates on starting a lead, and the plan lines on /foundry (ADR-0001 s8-9, hooks-spec)

type W = ReturnType<typeof world>
type Crew = Record<string, unknown>

const PLAN = `${ROOT}/plan.json`
const RUN = `this run changes the design; get the owner's approval first`
const refused = (reason: string) => ({ deny: `[foundry] Refused: ${reason}` })

const crew = (slug: string, wave: unknown, status = 'planned', extra: Crew = {}): Crew => ({ slug, wave, verdict: 'change', status, ...extra })
const planText = (crews: Crew[], top: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, goal: 'g', approval: 'auto', approvedAt: null, maxParallelCrews: 4, crews, ...top })
const setPlan = (w: W, crews: Crew[], top: Record<string, unknown> = {}) => w.files.set(PLAN, planText(crews, top))

// the main thread starting a lead, as /foundry:run does
const start = (w: W, name?: string) => w.agentCall(undefined, { subagent_type: LEAD_TYPE, name, model: 'opus' })
const started = (w: W) => w.ran.filter(c => c.tool === 'Agent').map(c => c.name)
const noteFor = (name: string) => `${ROOT}/reports/${name}/${name}.md`

// asserts the call went through as 0.2.1 would: no deny, the tool ran, and the report note came back
const expectAllowed = async (w: W, name: string) => {
  const before = started(w).length
  const r = await start(w, name)
  expect(r.deny).toBeUndefined()
  expect(started(w).length).toBe(before + 1)
  expect(started(w).at(-1)).toBe(name)
  expect(r.context?.[0]).toContain(noteFor(name))
}

// asserts the call was refused with exactly this reason and never reached the tool
const expectRefused = async (w: W, name: string, reason: string) => {
  const before = w.ran.length
  expect(await start(w, name)).toEqual(refused(reason))
  expect(w.ran.length).toBe(before)
}

// ---- each gate refusing, exact text ----

test('v03 gate 1: an owner-approval run with approvedAt null refuses with the run reason', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0)], { approval: 'owner', approvedAt: null })
  await expectRefused(w, 'a', RUN)
  expect(w.ran.length).toBe(0)
})

test('v03 gate 2: a crew whose ownerApproval is pending is refused, naming it', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0), crew('b', 0, 'planned', { ownerApproval: 'pending' })])
  await expectRefused(w, 'b', `b waits for the owner's approval`)
})

test('v03 gate 3: an earlier wave not merged refuses with the lowest such wave and its slugs in array order', async ($, on) => {
  const w = world($, on)
  setPlan(w, [
    crew('x', 1, 'running'),
    crew('zeta', 0, 'planned'),
    crew('y', 1, 'planned'),
    crew('done', 0, 'merged'),
    crew('alpha', 0, 'running'),
    crew('gone', 0, 'dropped'),
    crew('t', 2),
  ])
  await expectRefused(w, 't', `wave 0 isn't merged yet: zeta, alpha`)
})

test('v03 gate 3: when the lowest earlier wave is all merged, the next unmerged wave is named', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0, 'merged'), crew('b', 1, 'review'), crew('c', 1, 'merged'), crew('d', 1, 'failed'), crew('t', 2)])
  await expectRefused(w, 't', `wave 1 isn't merged yet: b, d`)
})

test('v03 gate 3: an earlier crew with no status counts as not merged', async ($, on) => {
  const w = world($, on)
  setPlan(w, [{ slug: 'a', wave: 0, verdict: 'change' }, crew('t', 1)])
  await expectRefused(w, 't', `wave 0 isn't merged yet: a`)
})

test('v03 gate 3: crews whose wave is not a number are ignored, and a target without a numeric wave skips the gate', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('s', '0'), { slug: 'n', verdict: 'change', status: 'planned' }, crew('t', 1), crew('u', 'late')])
  await expectAllowed(w, 't')
  setPlan(w, [crew('a', 0), crew('u', 'late'), { slug: 'v', verdict: 'change' }])
  await expectAllowed(w, 'u')
  await expectAllowed(w, 'v')
})

test('v03 gate 4: running at the cap refuses with the count, the cap and the slug', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r1', 0, 'running'), crew('r2', 0, 'running'), crew('t', 0)], { maxParallelCrews: 2 })
  await expectRefused(w, 't', '2 crews running, the cap is 2; start t when one merges')
})

test('v03 gate 4: running above the cap refuses with the real count', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r1', 0, 'running'), crew('r2', 0, 'running'), crew('r3', 0, 'running'), crew('t', 0)], { maxParallelCrews: 2 })
  await expectRefused(w, 't', '3 crews running, the cap is 2; start t when one merges')
})

// ---- gate order ----

test('v03 order: run approval wins over crew approval, wave and cap', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r', 0, 'running'), crew('t', 1, 'planned', { ownerApproval: 'pending' })], { approval: 'owner', approvedAt: null, maxParallelCrews: 1 })
  await expectRefused(w, 't', RUN)
})

test('v03 order: crew approval wins over wave and cap', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r', 0, 'running'), crew('t', 1, 'planned', { ownerApproval: 'pending' })], { maxParallelCrews: 1 })
  await expectRefused(w, 't', `t waits for the owner's approval`)
})

test('v03 order: the wave gate wins over the cap', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r', 0, 'running'), crew('t', 1)], { maxParallelCrews: 1 })
  await expectRefused(w, 't', `wave 0 isn't merged yet: r`)
})

// ---- allows ----

test('v03 allow: earlier waves all merged or dropped, and the 0.2.1 report note still comes back', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0, 'merged'), crew('b', 0, 'dropped'), crew('c', 1, 'merged'), crew('t', 2), crew('later', 3)])
  await expectAllowed(w, 't')
})

test('v03 allow: crews running below the cap', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r1', 0, 'running'), crew('r2', 0, 'running'), crew('r3', 0, 'running'), crew('t', 0)], { maxParallelCrews: 4 })
  await expectAllowed(w, 't')
})

test('v03 allow: the cap is 4 when maxParallelCrews is absent', async ($, on) => {
  const w = world($, on)
  const three = [crew('r1', 0, 'running'), crew('r2', 0, 'running'), crew('r3', 0, 'running')]
  w.files.set(PLAN, JSON.stringify({ version: 1, approval: 'auto', approvedAt: null, crews: [...three, crew('t', 0)] }))
  await expectAllowed(w, 't')
  w.files.set(PLAN, JSON.stringify({ version: 1, approval: 'auto', approvedAt: null, crews: [...three, crew('r4', 0, 'running'), crew('t', 0)] }))
  await expectRefused(w, 't', '4 crews running, the cap is 4; start t when one merges')
})

test('v03 allow: an invalid maxParallelCrews means a cap of 4', async ($, on) => {
  const w = world($, on)
  const three = [crew('r1', 0, 'running'), crew('r2', 0, 'running'), crew('r3', 0, 'running')]
  for (const cap of [0, -1, 2.5, '2', null, true]) {
    setPlan(w, [...three, crew('t', 0)], { maxParallelCrews: cap })
    await expectAllowed(w, 't')
    setPlan(w, [...three, crew('r4', 0, 'running'), crew('t', 0)], { maxParallelCrews: cap })
    await expectRefused(w, 't', '4 crews running, the cap is 4; start t when one merges')
  }
})

test('v03 allow: the crew being started is not counted as running', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('r1', 0, 'running'), crew('t', 0, 'running')], { maxParallelCrews: 2 })
  await expectAllowed(w, 't')
  setPlan(w, [crew('r1', 0, 'running'), crew('r2', 0, 'running'), crew('t', 0, 'running')], { maxParallelCrews: 2 })
  await expectRefused(w, 't', '2 crews running, the cap is 2; start t when one merges')
})

test('v03 allow: approval auto with approvedAt null', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0)], { approval: 'auto', approvedAt: null })
  await expectAllowed(w, 'a')
})

test('v03 allow: approval owner with approvedAt set, or approvedAt missing', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0)], { approval: 'owner', approvedAt: '2026-10-26T10:00:00Z' })
  await expectAllowed(w, 'a')
  w.files.set(PLAN, JSON.stringify({ version: 1, approval: 'owner', crews: [crew('a', 0)] }))
  await expectAllowed(w, 'a')
})

test('v03 allow: ownerApproval approved', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0, 'planned', { ownerApproval: 'approved' })])
  await expectAllowed(w, 'a')
})

test('v03 allow: a crew already merged, dropped or running is not refused for that alone', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('m', 0, 'merged'), crew('d', 0, 'dropped'), crew('r', 0, 'running')], { maxParallelCrews: 3 })
  await expectAllowed(w, 'm')
  await expectAllowed(w, 'd')
  await expectAllowed(w, 'r')
})

// ---- fail open ----

const failOpen = async (w: W, name: string | undefined = 'a') => {
  const r = await start(w, name)
  expect(r.deny).toBeUndefined()
  expect(w.ran.length).toBe(1)
}

test('v03 fail open: no plan.json', async ($, on) => {
  const w = world($, on)
  await failOpen(w)
})

test('v03 fail open: an empty plan.json', async ($, on) => {
  const w = world($, on)
  w.files.set(PLAN, '')
  await failOpen(w)
})

test('v03 fail open: plan.json that is not JSON', async ($, on) => {
  const w = world($, on)
  w.files.set(PLAN, '{"approval": "owner", "approvedAt": null, "crews": [{"slug": "a"')
  await failOpen(w)
})

test('v03 fail open: plan.json whose top level is not an object', async ($, on) => {
  const w = world($, on)
  w.files.set(PLAN, JSON.stringify([crew('a', 0)]))
  await failOpen(w)
})

test('v03 fail open: crews is not an array', async ($, on) => {
  const w = world($, on)
  w.files.set(PLAN, JSON.stringify({ approval: 'owner', approvedAt: null, crews: { a: crew('a', 0) } }))
  await failOpen(w)
})

test('v03 fail open: a name that is not in the plan', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0, 'planned', { ownerApproval: 'pending' })], { approval: 'owner', approvedAt: null })
  await failOpen(w, 'other')
})

test('v03 fail open: a lead started with no name, or an empty one', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0)], { approval: 'owner', approvedAt: null })
  expect((await start(w, undefined)).deny).toBeUndefined()
  expect((await start(w, '')).deny).toBeUndefined()
  expect(w.ran.length).toBe(2)
})

test('v03 fail open: an Agent call that is not a foundry:lead is never plan-gated', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0)], { approval: 'owner', approvedAt: null })
  expect((await w.agentCall(undefined, { subagent_type: 'Explore', name: 'a', model: 'opus' })).deny).toBeUndefined()
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:cynic', name: 'a', model: 'opus', effort: 'max' })).deny).toBeUndefined()
  expect((await w.agentCall(undefined, { name: 'a', model: 'opus' })).deny).toBeUndefined()
  expect(w.ran.length).toBe(3)
})

test('v03 fail open: a foundry:lead started by another agent, inside a crew or not, is not plan-gated', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0)], { approval: 'owner', approvedAt: null })
  expect((await w.agentCall('X', { subagent_type: LEAD_TYPE, name: 'a', model: 'opus' })).deny).toBeUndefined()
  expect((await w.agentCall('L1', { subagent_type: LEAD_TYPE, name: 'a', model: 'sonnet', effort: 'medium' })).deny).toBeUndefined()
  expect(w.ran.length).toBe(2)
})

// ---- successor rule ----

test('v03 successor: <slug>-2 not in the plan is gated as <slug>, and reasons name the base slug', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0), crew('b', 1, 'planned', { ownerApproval: 'pending' })])
  await expectRefused(w, 'b-2', `b waits for the owner's approval`)
  setPlan(w, [crew('a', 0), crew('b', 1)])
  await expectRefused(w, 'b-2', `wave 0 isn't merged yet: a`)
  await expectRefused(w, 'b-10', `wave 0 isn't merged yet: a`)
  setPlan(w, [crew('r', 0, 'running'), crew('b', 0)], { maxParallelCrews: 1 })
  await expectRefused(w, 'b-3', '1 crews running, the cap is 1; start b when one merges')
})

test('v03 successor: a successor of a running crew does not count its base as running', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('b', 0, 'running')], { maxParallelCrews: 1 })
  await expectAllowed(w, 'b-2')
})

test('v03 successor: a <slug>-2 that is itself a plan slug is gated as itself', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('b', 0, 'planned', { ownerApproval: 'pending' }), crew('b-2', 0, 'planned', { ownerApproval: 'approved' })])
  await expectAllowed(w, 'b-2')
  setPlan(w, [crew('b', 0), crew('b-2', 0, 'planned', { ownerApproval: 'pending' })])
  await expectRefused(w, 'b-2', `b-2 waits for the owner's approval`)
})

test('v03 successor: <slug>-1, <unknown>-2 and a double suffix are not gated', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('b', 0, 'planned', { ownerApproval: 'pending' })])
  for (const name of ['b-1', 'b-0', 'zzz-2', 'b-2-3', 'b-x', 'b2']) expect((await start(w, name)).deny).toBeUndefined()
  expect(w.ran.length).toBe(6)
})

// ---- fresh reads, read-only ----

test('v03 fresh reads: editing plan.json between calls flips refuse to allow and back', async ($, on) => {
  const w = world($, on)
  setPlan(w, [crew('a', 0, 'planned', { ownerApproval: 'pending' })])
  await expectRefused(w, 'a', `a waits for the owner's approval`)
  setPlan(w, [crew('a', 0, 'planned', { ownerApproval: 'approved' })])
  await expectAllowed(w, 'a')
  setPlan(w, [crew('a', 0, 'planned', { ownerApproval: 'pending' })])
  await expectRefused(w, 'a', `a waits for the owner's approval`)
  w.files.delete(PLAN)
  await expectAllowed(w, 'a')
})

test('v03 read-only: no gate or /foundry ever writes plan.json', async ($, on) => {
  const w = world($, on)
  const text = `${planText([crew('a', 0, 'running'), crew('b', 1, 'planned', { ownerApproval: 'pending' }), crew('c', 0)], { maxParallelCrews: 1 })}\n`
  w.files.set(PLAN, text)
  await start(w, 'a')
  await start(w, 'b')
  await start(w, 'c')
  await start(w, 'b-2')
  await status($)
  expect(w.files.get(PLAN)).toBe(text)
})

// ---- /foundry plan lines ----

// the 0.2.1 output follows the plan lines
const expectPlanAbove = (text: string, planLines: string[], base: string) => {
  const head = `${planLines.join('\n')}\n`
  expect(text.slice(0, head.length)).toBe(head)
  expect(text.slice(head.length).replace(/^\n+/, '')).toBe(base)
}

test('v03 /foundry: plan lines sit above the 0.2.1 crews block, sorted by wave with ties in array order', async ($, on) => {
  const w = world($, on)
  const base = await status($)
  expect(base.startsWith('Crews (')).toBe(true)
  setPlan(w, [
    { slug: 'c', wave: 2, verdict: 'change', status: 'merged' },
    { slug: 'z', wave: 0, verdict: 'design', status: 'running' },
    { slug: 'b', wave: 1, verdict: 'extend', status: 'planned', ownerApproval: 'pending' },
    { slug: 'a', wave: 0, verdict: 'reuse', status: 'dropped', ownerApproval: 'approved' },
  ])
  expectPlanAbove(
    await status($),
    [
      'Plan (4 crews, approval auto):',
      '- wave 0: z, design, running',
      '- wave 0: a, reuse, dropped',
      `- wave 1: b, extend, planned, waits for the owner's approval`,
      '- wave 2: c, change, merged',
    ],
    base,
  )
})

test('v03 /foundry: an owner run with approvedAt null says it waits for the owner', async ($, on) => {
  const w = world($, on)
  const base = await status($)
  setPlan(w, [crew('a', 0), crew('b', 1)], { approval: 'owner', approvedAt: null })
  expectPlanAbove(await status($), ['Plan (2 crews, approval owner, waiting for the owner):', '- wave 0: a, change, planned', '- wave 1: b, change, planned'], base)
  setPlan(w, [crew('a', 0), crew('b', 1)], { approval: 'owner', approvedAt: '2026-10-26T10:00:00Z' })
  expectPlanAbove(await status($), ['Plan (2 crews, approval owner):', '- wave 0: a, change, planned', '- wave 1: b, change, planned'], base)
})

test('v03 /foundry: a missing crew field prints as ?', async ($, on) => {
  const w = world($, on)
  const base = await status($)
  setPlan(w, [{ slug: 'a', wave: 0 }, { slug: 'b', wave: 1, status: 'running' }, { slug: 'c', wave: 2, verdict: 'extend' }])
  expectPlanAbove(await status($), ['Plan (3 crews, approval auto):', '- wave 0: a, ?, ?', '- wave 1: b, ?, running', '- wave 2: c, extend, ?'], base)
})

test('v03 /foundry: plan lines sit above the no-crews line too', async ($, on) => {
  const w = world($, on)
  w.agents = []
  const base = await status($)
  expect(base.startsWith('No foundry crews in this session.')).toBe(true)
  setPlan(w, [crew('a', 0)])
  expectPlanAbove(await status($), ['Plan (1 crews, approval auto):', '- wave 0: a, change, planned'], base)
})

test('v03 /foundry: no plan, or one it cannot read, leaves the output byte-identical to 0.2.1', async ($, on) => {
  const w = world($, on)
  const base = await status($)
  for (const text of ['', '{"crews": [', '[]', '"plan"', JSON.stringify({ approval: 'auto', crews: 'a' })]) {
    w.files.set(PLAN, text)
    expect(await status($)).toBe(base)
  }
  w.files.delete(PLAN)
  w.agents = []
  const none = await status($)
  w.files.set(PLAN, '{bad')
  expect(await status($)).toBe(none)
})

// ---- the shipped example ----

// A verbatim copy of plugins/foundry/docs/plan.example.json. The test sandbox loads only code files, so neither an
// import of the .json nor a node:fs read works here; keep this copy in step with the doc.
const PLAN_EXAMPLE = `{
  "version": 1,
  "goal": "Add rate limiting to the public API, with per-key quotas stored in Postgres",
  "architecture": "docs/architecture.md",
  "approval": "owner",
  "approvedAt": null,
  "agentCap": 40,
  "maxParallelCrews": 4,
  "crews": [
    {
      "slug": "ratelimit-design",
      "wave": 0,
      "verdict": "design",
      "modules": ["gateway", "quotas"],
      "owns": [
        "docs/architecture.md",
        "docs/adr/0007-rate-limiting.md",
        "tests/contract/quota-store.test.ts"
      ],
      "doneCheck": "pnpm test -- tests/contract/quota-store.test.ts",
      "doneCheckProved": true,
      "estAgents": 5,
      "status": "planned"
    },
    {
      "slug": "quotas",
      "wave": 1,
      "verdict": "change",
      "modules": ["quotas"],
      "owns": ["src/quotas/**", "migrations/0012_quotas.sql", "tests/quotas/**"],
      "doneCheck": "pnpm test -- quotas",
      "doneCheckProved": true,
      "estAgents": 8,
      "status": "planned"
    },
    {
      "slug": "gateway",
      "wave": 1,
      "verdict": "extend",
      "modules": ["gateway"],
      "owns": ["src/gateway/middleware/ratelimit.ts", "tests/gateway/ratelimit.test.ts"],
      "doneCheck": "pnpm test -- gateway/ratelimit",
      "doneCheckProved": true,
      "estAgents": 6,
      "status": "planned"
    }
  ]
}
`

test('v03 example: the shipped plan.example.json refuses until approvedAt is set, then gates by wave', async ($, on) => {
  const w = world($, on)
  w.files.set(PLAN, PLAN_EXAMPLE)
  await expectRefused(w, 'ratelimit-design', RUN)
  await expectRefused(w, 'quotas', RUN)
  w.files.set(PLAN, PLAN_EXAMPLE.replace('"approvedAt": null', '"approvedAt": "2026-10-26T10:00:00Z"'))
  await expectAllowed(w, 'ratelimit-design')
  await expectRefused(w, 'quotas', `wave 0 isn't merged yet: ratelimit-design`)
})
