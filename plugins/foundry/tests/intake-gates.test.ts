import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'

import { LEAD_TYPE } from '../hooks/register'
import { handBack, startSession, status, test, world } from './harness'

// ADR-0010 mid-run intake, "What the contract tests pin" items 1-10, with the lead's amendments: no `after`, approval not
// tied to wave 0, the reserved goal id `run` (gate R), and a crew's goal must name a plan goal (gate 2). Written from the
// ADR and the crew spec alone; everything goes through the Agent tool.call entry, the architect hand-back and /foundry.

type W = ReturnType<typeof world>
type Obj = Record<string, unknown>

const FENCE = '````'
const DIR = 'C:/r/.git/foundry/S1'
const PLAN_JSON = `${DIR}/plan.json`
const PLAN_MD = `${DIR}/plan.md`
const APPROVED = '2026-10-17T10:00:00Z'
const REFUSED = '[foundry] Refused: '
const NOTHING = 'foundry: plan-amend route wrote nothing: '
const ADDED = 'foundry: plan-amend route added goal '
const KEPT = 'foundry: plan-file route kept the existing plan:'
const NOT_APPROVED = "the plan isn't approved; give the goal to the plan architect instead"

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const logged = (w: W, start: string) => w.logs.filter(l => l.startsWith(start))

// ---- fixtures ----

const crew = (slug: string, wave: unknown, status = 'planned', extra: Obj = {}): Obj => ({ slug, wave, verdict: 'change', status, ...extra })
const goalEntry = (id: string, extra: Obj = {}): Obj => ({ id, goal: `goal ${id}`, addedAt: '2026-10-17T11:00:00Z', approval: 'auto', approvedAt: '2026-10-17T11:05:00Z', ...extra })
const planOf = (crews: Obj[], goals?: Obj[], top: Obj = {}): Obj => ({
  version: 3,
  goal: 'g',
  approval: 'auto',
  approvedAt: APPROVED,
  maxParallelCrews: 4,
  repairBudget: 2,
  ...(goals === undefined ? {} : { goals }),
  crews,
  ...top,
})

// ---- gates, through the Agent tool.call entry (a foundry:lead start from the main session) ----

const setGate = (w: W, plan: Obj) => w.files.set('C:/r/.git/foundry/s1/plan.json', JSON.stringify(plan))
const start = (w: W, name: string) => w.agentCall(undefined, { subagent_type: LEAD_TYPE, name, model: 'opus', effort: 'medium' })
const expectRefused = async (w: W, name: string, reason: string) => {
  const before = w.ran.length
  expect(await start(w, name)).toEqual({ deny: `${REFUSED}${reason}` })
  expect(w.ran.length).toBe(before)
}
const expectAllowed = async (w: W, name: string) => {
  const r = await start(w, name)
  expect(r.deny).toBeUndefined()
  expect(w.ran.filter(c => c.tool === 'Agent').at(-1)?.name).toBe(name)
}

test('intake item 1: an added goal wave 1 is not held by the run goal unmerged wave 0, and the run goal keeps its own gate', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('r0', 0, 'running'), crew('r1', 1), crew('a0', 0, 'merged', { goal: 'g1' }), crew('a1', 1, 'planned', { goal: 'g1' })], [goalEntry('g1')]))
  await expectAllowed(w, 'a1')
  await expectRefused(w, 'r1', `wave 0 isn't merged yet: r0`)
})

test('intake item 1: a run wave 0 crew that is unmerged never holds an added goal wave 0 either', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('r0', 0, 'running'), crew('a0', 0, 'planned', { goal: 'g1' })], [goalEntry('g1')]))
  await expectAllowed(w, 'a0')
})

test('intake item 2: an added goal wave gate names the goal, and lists the lowest open wave of that goal only', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('r0', 0, 'running'), crew('a0', 0, 'running', { goal: 'g1' }), crew('a0b', 0, 'planned', { goal: 'g1' }), crew('a1', 1, 'planned', { goal: 'g1' })], [goalEntry('g1')]))
  await expectRefused(w, 'a1', `wave 0 of goal g1 isn't merged yet: a0, a0b`)
})

test('intake item 2: a goal wave gate lets merged and dropped crews of that goal through', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('a0', 0, 'merged', { goal: 'g1' }), crew('a0b', 0, 'dropped', { goal: 'g1' }), crew('a1', 1, 'planned', { goal: 'g1' })], [goalEntry('g1')]))
  await expectAllowed(w, 'a1')
})

test('intake item 3: gate 2 refuses a crew whose goal names no entry in goals, exact text', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'ghost' })], [goalEntry('g1')]))
  await expectRefused(w, 't', `t names goal ghost, which isn't in the plan`)
})

test('intake item 3: gate 2 also refuses when the plan has no goals at all', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'ghost' })]))
  await expectRefused(w, 't', `t names goal ghost, which isn't in the plan`)
})

test('intake item 3: gate 3 holds a crew of an owner goal whose approvedAt is null, exact text', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('a0', 0, 'planned', { goal: 'g1' }), crew('r0', 0)], [goalEntry('g1', { approval: 'owner', approvedAt: null })]))
  await expectRefused(w, 'a0', `goal g1 changes the design; get the owner's approval first`)
  await expectAllowed(w, 'r0')
})

test('intake item 3: gate 3 lets an owner goal through once approvedAt is set, and an auto goal whatever the foreman logged', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('a0', 0, 'planned', { goal: 'g1' })], [goalEntry('g1', { approval: 'owner', approvedAt: '2026-10-17T11:30:00Z' })]))
  await expectAllowed(w, 'a0')
})

test('intake item 3: gate R refuses every crew when goals holds an entry with id run, exact text', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('t', 0), crew('u', 0, 'planned', { goal: 'run' }), crew('v', 0, 'planned', { goal: 'g1' })], [goalEntry('run'), goalEntry('g1')]))
  const reason = `goal id run is reserved for the run's first goal; rename it in plan.json`
  await expectRefused(w, 't', reason)
  await expectRefused(w, 'u', reason)
  await expectRefused(w, 'v', reason)
})

test('intake item 3: gate order, 1 before R before 2 before 3 before 4', async ($, on) => {
  const w = world($, on)
  // gate 1 beats R
  setGate(w, planOf([crew('t', 0)], [goalEntry('run')], { approval: 'owner', approvedAt: null }))
  await expectRefused(w, 't', `this run changes the design; get the owner's approval first`)
  // R beats 2
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'ghost' })], [goalEntry('run')]))
  await expectRefused(w, 't', `goal id run is reserved for the run's first goal; rename it in plan.json`)
  // 3 beats 4
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'g1', ownerApproval: 'pending' })], [goalEntry('g1', { approval: 'owner', approvedAt: null })]))
  await expectRefused(w, 't', `goal g1 changes the design; get the owner's approval first`)
  // 4 stays as it was
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'g1', ownerApproval: 'pending' })], [goalEntry('g1')]))
  await expectRefused(w, 't', `t waits for the owner's approval`)
})

test('intake item 4: the cap counts running crews of every goal', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('r0', 0, 'running'), crew('a0', 0, 'running', { goal: 'g1' }), crew('t', 0, 'planned', { goal: 'g1' })], [goalEntry('g1')], { maxParallelCrews: 2 }))
  await expectRefused(w, 't', '2 crews running, the cap is 2; start t when one merges')
  setGate(w, planOf([crew('r0', 0, 'running'), crew('a0', 0, 'running', { goal: 'g1' }), crew('t', 0, 'planned', { goal: 'g1' })], [goalEntry('g1')], { maxParallelCrews: 3 }))
  await expectAllowed(w, 't')
})

test('intake item 10: a crew with goal "run" passes gate 2 with no run entry in goals, and with no goals at all', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'run' })], [goalEntry('g1')]))
  await expectAllowed(w, 't')
  setGate(w, planOf([crew('t', 0, 'planned', { goal: 'run' })]))
  await expectAllowed(w, 't')
})

test('intake item 10: a crew with goal "run" is wave-gated together with crews that have no goal', async ($, on) => {
  const w = world($, on)
  setGate(w, planOf([crew('a', 0, 'running'), crew('t', 1, 'planned', { goal: 'run' })], [goalEntry('g1')]))
  await expectRefused(w, 't', `wave 0 isn't merged yet: a`)
  setGate(w, planOf([crew('a', 0, 'running', { goal: 'run' }), crew('t', 1)], [goalEntry('g1')]))
  await expectRefused(w, 't', `wave 0 isn't merged yet: a`)
})

// ---- the plan-amend route ----

const mdOf = (id: string) => `# Goal ${id}\n\nWave 0: ${id}-one.`
const newCrew = (slug: string, wave: number, extra: Obj = {}): Obj => ({
  slug,
  wave,
  verdict: 'change',
  modules: [slug],
  owns: [`src/${slug}/**`],
  doneCheck: `pnpm test -- ${slug}`,
  doneCheckProved: true,
  estAgents: 3,
  status: 'planned',
  ...extra,
})
const amendOf = (id: string, crews: Obj[], goalExtra: Obj = {}): Obj => ({ goal: { id, goal: `do ${id}`, approval: 'auto', ...goalExtra }, crews })
const message = (json: string | undefined, md: string | undefined = '# plan\n\nthe goal.') =>
  [
    'VERDICT: amendment ready, both files below.',
    ...(json === undefined ? [] : [`${FENCE}json plan-amend.json`, json, FENCE]),
    ...(md === null ? [] : [`${FENCE}markdown plan.md`, md, FENCE]),
    'Report: one crew.',
  ].join('\n')

// the harness answers session.id 's1'; the foundry dir is under S1
const setup = async ($: Engine, on: On): Promise<W> => {
  const w = world($, ((name: string, handler: unknown) => (name === 'session.id' ? undefined : (on as (n: string, h: unknown) => unknown)(name, handler))) as unknown as On)
  on('session.id', async () => ({ value: 'S1' }))
  await startSession($)
  return w
}

// the foreman's architect call, then its hand-back
const sendAmend = async ($: Engine, w: W, id: string, amend: unknown, md: string | null = mdOf(id)) => {
  await w.agentCall(undefined, { subagent_type: 'foundry:architect', prompt: `Mode: amend\nGoal id: ${id}`, name: `architect-amend-${id}`, model: 'opus', effort: 'medium' })
  await handBack($, 'new1', message(typeof amend === 'string' ? amend : JSON.stringify(amend), md))
  await settle()
}
const sendPlan = async ($: Engine, w: W) => {
  await w.agentCall(undefined, { subagent_type: 'foundry:architect', prompt: 'Mode: plan\nGoal: something else', name: 'planner', model: 'opus', effort: 'medium' })
  await handBack($, 'new1', ['VERDICT: plan ready, both files below.', `${FENCE}json plan.json`, JSON.stringify(planOf([newCrew('other', 0)]), null, 2), FENCE, `${FENCE}markdown plan.md`, '# other plan', FENCE, 'Report: one crew.'].join('\n'))
  await settle()
}

const existing = (): Obj => ({
  version: 2,
  goal: 'Add rate limiting',
  architecture: 'docs/architecture.md',
  approval: 'owner',
  approvedAt: APPROVED,
  agentCap: 40,
  maxParallelCrews: 3,
  repairBudget: 2,
  crews: [newCrew('quotas', 0, { status: 'merged', ownerApproval: 'approved', verdict: 'design' }), newCrew('gateway', 1, { status: 'running' }), newCrew('docs', 1)],
})
const text = (plan: Obj) => JSON.stringify(plan, null, 2) + '\n'
const onDisk = (w: W): Obj => JSON.parse(w.files.get(PLAN_JSON) ?? '{}') as Obj
const crewsOf = (p: Obj) => p.crews as Obj[]
const goalsOf = (p: Obj): Obj[] => (Array.isArray(p.goals) ? (p.goals as Obj[]) : [])
const slugs = (p: Obj) => crewsOf(p).map(c => c.slug)

test('intake item 5: a Mode: amend hand-back on an approved plan appends the goal and its crews and leaves the rest alone', async ($, on) => {
  const w = await setup($, on)
  const before = existing()
  w.files.set(PLAN_JSON, text(before))
  w.files.set(PLAN_MD, 'OLD PLAN')
  const mine = [newCrew('intake-one', 0, { verdict: 'design' }), newCrew('intake-two', 1, { status: 'merged', goal: 'somebody-else' })]
  await sendAmend($, w, 'intake', amendOf('intake', mine), mdOf('intake'))
  const after = onDisk(w)
  expect(after.version).toBe(3)
  for (const key of Object.keys(before)) if (key !== 'version' && key !== 'crews') expect(after[key]).toEqual(before[key])
  expect(Object.keys(after).sort()).toEqual([...Object.keys(before), 'goals'].sort())
  expect(crewsOf(after).slice(0, 3)).toEqual(crewsOf(before))
  expect(crewsOf(after).slice(3)).toEqual([
    { ...mine[0], goal: 'intake', status: 'planned' },
    { ...mine[1], goal: 'intake', status: 'planned' },
  ])
  expect(crewsOf(after).length).toBe(5)
  expect(goalsOf(after).length).toBe(1)
  expect(goalsOf(after)[0]).toMatchObject({ id: 'intake', goal: 'do intake', approval: 'auto', approvedAt: null })
  expect(String(goalsOf(after)[0]?.addedAt)).toMatch(/^2026-10-17T12:00:00(\.000)?Z$/)
  expect(w.files.get(`${DIR}/plan-intake.md`)).toBe(mdOf('intake'))
  expect(w.files.get(PLAN_MD)).toBe('OLD PLAN')
  expect(w.files.get(PLAN_JSON)).toBe(text(after))
  expect(logged(w, `${ADDED}intake: 2 crews`).length).toBe(1)
})

test('intake item 5: a second goal is appended after the first, and the first goal entry and crews pass through untouched', async ($, on) => {
  const w = await setup($, on)
  w.files.set(PLAN_JSON, text(existing()))
  await sendAmend($, w, 'one', amendOf('one', [newCrew('one-a', 0)]))
  const mid = onDisk(w)
  await w.clock.advance(3 * 60_000)
  await sendAmend($, w, 'two', amendOf('two', [newCrew('two-a', 0)], { approval: 'owner' }))
  const after = onDisk(w)
  expect(goalsOf(after).map(g => g.id)).toEqual(['one', 'two'])
  expect(goalsOf(after)[0]).toEqual(goalsOf(mid)[0])
  expect(goalsOf(after)[1]).toMatchObject({ approval: 'owner', approvedAt: null })
  expect(crewsOf(after).slice(0, 4)).toEqual(crewsOf(mid))
  expect(slugs(after)).toEqual(['quotas', 'gateway', 'docs', 'one-a', 'two-a'])
})

test('intake item 3: an amend with approval auto and a wave 0 crew is accepted', async ($, on) => {
  const w = await setup($, on)
  w.files.set(PLAN_JSON, text(existing()))
  await sendAmend($, w, 'auto-goal', amendOf('auto-goal', [newCrew('ag-design', 0, { verdict: 'design' })], { approval: 'auto' }))
  expect(goalsOf(onDisk(w)).map(g => g.id)).toEqual(['auto-goal'])
  expect(logged(w, NOTHING)).toEqual([])
})

test('intake item 3: an amend with approval owner and no wave 0 crew is accepted', async ($, on) => {
  const w = await setup($, on)
  w.files.set(PLAN_JSON, text(existing()))
  await sendAmend($, w, 'owner-goal', amendOf('owner-goal', [newCrew('og-build', 1)], { approval: 'owner' }))
  expect(goalsOf(onDisk(w))[0]).toMatchObject({ id: 'owner-goal', approval: 'owner', approvedAt: null })
  expect(logged(w, NOTHING)).toEqual([])
})

// item 6: each refusal leaves plan.json byte-identical and logs the nothing line
type Refusal = { name: string; amend: () => unknown; md?: string | null; reason?: string; plan?: () => string | undefined }
const refusals: Refusal[] = [
  { name: 'there is no plan.json', amend: () => amendOf('g1', [newCrew('c1', 0)]), plan: () => undefined, reason: NOT_APPROVED },
  { name: 'the plan is version 1', amend: () => amendOf('g1', [newCrew('c1', 0)]), plan: () => text({ ...existing(), version: 1 }), reason: 'the plan is version 1; re-plan it in plan mode before adding a goal' },
  { name: 'the plan has no version', amend: () => amendOf('g1', [newCrew('c1', 0)]), plan: () => text(Object.fromEntries(Object.entries(existing()).filter(([k]) => k !== 'version'))) },
  { name: 'the plan version is a string', amend: () => amendOf('g1', [newCrew('c1', 0)]), plan: () => text({ ...existing(), version: '2' }) },
  { name: 'the plan top-level approvedAt is null', amend: () => amendOf('g1', [newCrew('c1', 0)]), plan: () => text({ ...existing(), approvedAt: null }), reason: NOT_APPROVED },
  { name: 'the plan is not parseable', amend: () => amendOf('g1', [newCrew('c1', 0)]), plan: () => '{not json', reason: NOT_APPROVED },
  { name: 'the plan.md block is missing', amend: () => amendOf('g1', [newCrew('c1', 0)]), md: null },
  { name: 'the amend block is not JSON', amend: () => '{not json' },
  { name: 'the amend is not an object', amend: () => '[1, 2]' },
  { name: 'the amend is a bare string', amend: () => '"hello"' },
  { name: 'the goal id fails the slug pattern', amend: () => amendOf('Bad_Id', [newCrew('c1', 0)]) },
  { name: 'the goal id ends in a number', amend: () => amendOf('goal-2', [newCrew('c1', 0)]) },
  { name: 'the goal id is run', amend: () => amendOf('run', [newCrew('c1', 0)]) },
  { name: 'goal.goal is empty', amend: () => amendOf('g1', [newCrew('c1', 0)], { goal: '' }) },
  { name: 'goal.goal is not a string', amend: () => amendOf('g1', [newCrew('c1', 0)], { goal: 5 }) },
  { name: 'goal.approval is neither auto nor owner', amend: () => amendOf('g1', [newCrew('c1', 0)], { approval: 'maybe' }) },
  { name: 'crews is empty', amend: () => amendOf('g1', []) },
  { name: 'crews is not an array', amend: () => ({ goal: { id: 'g1', goal: 'x', approval: 'auto' }, crews: { slug: 'c1' } }) },
  { name: 'a crew is not an object', amend: () => amendOf('g1', [newCrew('c1', 0), 'c2' as never]) },
  { name: 'a crew slug fails the pattern', amend: () => amendOf('g1', [newCrew('Not A Slug', 0)]) },
  { name: 'a crew slug repeats within the amend', amend: () => amendOf('g1', [newCrew('c1', 0), newCrew('c1', 1)]) },
  { name: 'a crew slug equals a crew outside this goal', amend: () => amendOf('g1', [newCrew('gateway', 0)]) },
]
for (const r of refusals) {
  test(`intake item 6: refused, plan.json byte-identical and logged: ${r.name}`, async ($, on) => {
    const w = await setup($, on)
    const plan = r.plan === undefined ? text(existing()) : r.plan()
    if (plan !== undefined) w.files.set(PLAN_JSON, plan)
    w.files.set(PLAN_MD, 'OLD PLAN')
    await sendAmend($, w, 'g1', r.amend(), r.md === null ? null : mdOf('g1'))
    expect(w.files.get(PLAN_JSON)).toBe(plan)
    expect(w.files.get(PLAN_MD)).toBe('OLD PLAN')
    expect(w.files.has(`${DIR}/plan-g1.md`)).toBe(false)
    expect(logged(w, NOTHING).length).toBe(1)
    if (r.reason !== undefined) expect(logged(w, NOTHING)[0]).toBe(`${NOTHING}${r.reason}`)
    expect(logged(w, ADDED)).toEqual([])
  })
}

test('intake item 6: the plan.json block missing is refused with the nothing line', async ($, on) => {
  const w = await setup($, on)
  const plan = text(existing())
  w.files.set(PLAN_JSON, plan)
  await w.agentCall(undefined, { subagent_type: 'foundry:architect', prompt: 'Mode: amend\nGoal id: g1', name: 'a', model: 'opus', effort: 'medium' })
  await handBack($, 'new1', message(undefined, '# only the markdown'))
  await settle()
  expect(w.files.get(PLAN_JSON)).toBe(plan)
  expect(logged(w, NOTHING).length).toBe(1)
})

// the replace path
const withGoalAThenB = async ($: Engine, w: W) => {
  w.files.set(PLAN_JSON, text(existing()))
  await sendAmend($, w, 'aa', amendOf('aa', [newCrew('aa-one', 0), newCrew('aa-two', 1)]))
  expect(goalsOf(onDisk(w)).map(g => g.id)).toEqual(['aa'])
  const addedAt = goalsOf(onDisk(w))[0].addedAt
  await w.clock.advance(3 * 60_000)
  await sendAmend($, w, 'bb', amendOf('bb', [newCrew('bb-one', 0)]))
  expect(goalsOf(onDisk(w)).map(g => g.id)).toEqual(['aa', 'bb'])
  await w.clock.advance(3 * 60_000)
  return addedAt
}

test('intake item 7: replace keeps the goal index and original addedAt and puts new crews at the first old crew index', async ($, on) => {
  const w = await setup($, on)
  const addedAt = await withGoalAThenB($, w)
  const mid = onDisk(w)
  expect(slugs(mid)).toEqual(['quotas', 'gateway', 'docs', 'aa-one', 'aa-two', 'bb-one'])
  await sendAmend($, w, 'aa', amendOf('aa', [newCrew('aa-x', 0), newCrew('aa-y', 0), newCrew('aa-z', 1)], { goal: 'do aa, redone', approval: 'owner' }))
  const after = onDisk(w)
  expect(goalsOf(after).map(g => g.id)).toEqual(['aa', 'bb'])
  expect(goalsOf(after)[0]).toMatchObject({ id: 'aa', goal: 'do aa, redone', approval: 'owner', approvedAt: null, addedAt })
  expect(goalsOf(after)[1]).toEqual(goalsOf(mid)[1])
  expect(slugs(after)).toEqual(['quotas', 'gateway', 'docs', 'aa-x', 'aa-y', 'aa-z', 'bb-one'])
  expect(crewsOf(after)[6]).toEqual(crewsOf(mid)[5])
  expect(crewsOf(after).slice(0, 3)).toEqual(crewsOf(mid).slice(0, 3))
  expect(crewsOf(after).slice(3, 6).map(c => c.goal)).toEqual(['aa', 'aa', 'aa'])
  expect(after.version).toBe(3)
})

test('intake item 7: sending the same amend again leaves plan.json byte-identical', async ($, on) => {
  const w = await setup($, on)
  await withGoalAThenB($, w)
  const amend = amendOf('aa', [newCrew('aa-x', 0), newCrew('aa-y', 1)])
  await sendAmend($, w, 'aa', amend)
  const once = w.files.get(PLAN_JSON)
  await w.clock.advance(10 * 60_000)
  await sendAmend($, w, 'aa', amend)
  expect(w.files.get(PLAN_JSON)).toBe(once)
  expect(logged(w, NOTHING)).toEqual([])
})

test('intake item 7: an amend for an approved goal is refused with goal <id> is approved', async ($, on) => {
  const w = await setup($, on)
  await withGoalAThenB($, w)
  const p = onDisk(w)
  goalsOf(p)[0].approvedAt = '2026-10-17T11:59:00Z'
  w.files.set(PLAN_JSON, text(p))
  await sendAmend($, w, 'aa', amendOf('aa', [newCrew('aa-x', 0)]))
  expect(w.files.get(PLAN_JSON)).toBe(text(p))
  expect(logged(w, NOTHING)).toEqual([`${NOTHING}goal aa is approved`])
})

test('intake item 7: an amend for a goal with a crew that is not planned is refused with goal <id> has started crews', async ($, on) => {
  const w = await setup($, on)
  await withGoalAThenB($, w)
  const p = onDisk(w)
  crewsOf(p)[3].status = 'running'
  w.files.set(PLAN_JSON, text(p))
  await sendAmend($, w, 'aa', amendOf('aa', [newCrew('aa-x', 0)]))
  expect(w.files.get(PLAN_JSON)).toBe(text(p))
  expect(logged(w, NOTHING)).toEqual([`${NOTHING}goal aa has started crews`])
})

test('intake item 7: when the goal crews were all removed by hand, the replacement crews go at the end', async ($, on) => {
  const w = await setup($, on)
  await withGoalAThenB($, w)
  const p = onDisk(w)
  p.crews = crewsOf(p).filter(c => c.goal !== 'aa')
  w.files.set(PLAN_JSON, text(p))
  await sendAmend($, w, 'aa', amendOf('aa', [newCrew('aa-x', 0)]))
  expect(slugs(onDisk(w))).toEqual(['quotas', 'gateway', 'docs', 'bb-one', 'aa-x'])
  expect(goalsOf(onDisk(w)).map(g => g.id)).toEqual(['aa', 'bb'])
})

test('intake item 8: a Mode: plan hand-back over an approved plan is still kept, goals or not', async ($, on) => {
  const w = await setup($, on)
  w.files.set(PLAN_JSON, text(existing()))
  await sendAmend($, w, 'aa', amendOf('aa', [newCrew('aa-one', 0)]))
  const plan = w.files.get(PLAN_JSON)
  w.files.delete(PLAN_MD)
  await sendPlan($, w)
  expect(w.files.get(PLAN_JSON)).toBe(plan)
  expect(w.files.has(PLAN_MD)).toBe(false)
  expect(logged(w, KEPT).length).toBeGreaterThan(0)
})

// ---- /foundry ----

// the plan lines at the head of /foundry's text
const planBlock = (t: string) => {
  const out: string[] = []
  for (const line of t.split('\n')) {
    if (!/^(Plan \(|Goal |- wave )/.test(line)) break
    out.push(line)
  }
  return out
}
const show = async ($: Engine, w: W, plan: Obj) => {
  setGate(w, plan)
  return planBlock(await status($))
}

test('intake item 9: wait suffixes, ready to start, and no suffix on a status other than planned', async ($, on) => {
  const w = world($, on)
  const lines = await show($, w, planOf([crew('a', 0, 'running'), crew('b', 0, 'merged'), crew('c', 1), crew('d', 0), crew('e', 0, 'planned', { ownerApproval: 'pending' })], undefined, { maxParallelCrews: 4 }))
  expect(lines).toEqual([
    'Plan (5 crews, approval auto):',
    '- wave 0: a, change, running',
    '- wave 0: b, change, merged',
    '- wave 0: d, change, planned, ready to start',
    `- wave 0: e, change, planned, waits for the owner's approval`,
    '- wave 1: c, change, planned, waits for wave 0 to merge: a, d, e',
  ])
})

test('intake item 9: gate wait texts for the run approval, the cap, goal approval, a missing goal and the reserved id', async ($, on) => {
  const w = world($, on)
  expect(await show($, w, planOf([crew('t', 0)], undefined, { approval: 'owner', approvedAt: null }))).toEqual([
    'Plan (1 crews, approval owner, waiting for the owner):',
    `- wave 0: t, change, planned, waits for the owner's approval of the plan`,
  ])
  expect(await show($, w, planOf([crew('r', 0, 'running'), crew('s', 0, 'running'), crew('t', 0)], undefined, { maxParallelCrews: 2 }))).toEqual([
    'Plan (3 crews, approval auto):',
    '- wave 0: r, change, running',
    '- wave 0: s, change, running',
    '- wave 0: t, change, planned, waits for a free slot: 2 of 2 running',
  ])
  const owner = await show($, w, planOf([crew('t', 0, 'planned', { goal: 'g1' })], [goalEntry('g1', { approval: 'owner', approvedAt: null })]))
  expect(owner).toContain(`- wave 0: t, change, planned, waits for the owner's approval of goal g1`)
  const ghost = await show($, w, planOf([crew('t', 0, 'planned', { goal: 'ghost' })], [goalEntry('g1')]))
  expect(ghost).toContain(`- wave 0: t, change, planned, waits for a fix: goal ghost isn't in the plan`)
  const reserved = await show($, w, planOf([crew('t', 0)], [goalEntry('run')]))
  expect(reserved).toContain('- wave 0: t, change, planned, waits for a fix: goal id run is reserved')
})

test('intake item 9: a wave wait inside an added goal names only that goal crews', async ($, on) => {
  const w = world($, on)
  const lines = await show($, w, planOf([crew('r0', 0, 'running'), crew('a0', 0, 'running', { goal: 'g1' }), crew('a1', 1, 'planned', { goal: 'g1' }), crew('r1', 1)], [goalEntry('g1')]))
  expect(lines).toEqual([
    'Plan (4 crews, 2 goals, approval auto):',
    'Goal run (approval auto): g',
    '- wave 0: r0, change, running',
    '- wave 1: r1, change, planned, waits for wave 0 to merge: r0',
    'Goal g1 (approval auto): goal g1',
    '- wave 0: a0, change, running',
    '- wave 1: a1, change, planned, waits for wave 0 to merge: a0',
  ])
})

test('intake item 9: no goal lines and the old header when the plan has no goals', async ($, on) => {
  const w = world($, on)
  const lines = await show($, w, planOf([crew('a', 0, 'running'), crew('b', 1)], undefined))
  expect(lines.some(l => l.startsWith('Goal '))).toBe(false)
  expect(lines[0]).toBe('Plan (2 crews, approval auto):')
  const v2 = await show($, w, { version: 2, goal: 'g', approval: 'auto', approvedAt: APPROVED, maxParallelCrews: 4, repairBudget: 2, crews: [crew('a', 0)] })
  expect(v2).toEqual(['Plan (1 crews, approval auto):', '- wave 0: a, change, planned, ready to start'])
})

test('intake item 9: goal lines show approval, waiting for the owner, and done', async ($, on) => {
  const w = world($, on)
  const lines = await show(
    $,
    w,
    planOf(
      [crew('r0', 0, 'merged'), crew('r1', 1, 'dropped'), crew('a0', 0, 'planned', { goal: 'g1' }), crew('b0', 0, 'merged', { goal: 'g2' })],
      [goalEntry('g1', { approval: 'owner', approvedAt: null, goal: 'first   added' }), goalEntry('g2', { goal: 'second' })],
    ),
  )
  expect(lines).toEqual([
    'Plan (4 crews, 3 goals, approval auto):',
    'Goal run (approval auto, done): g',
    '- wave 0: r0, change, merged',
    '- wave 1: r1, change, dropped',
    'Goal g1 (approval owner, waiting for the owner): first added',
    `- wave 0: a0, change, planned, waits for the owner's approval of goal g1`,
    'Goal g2 (approval auto, done): second',
    '- wave 0: b0, change, merged',
  ])
})

test('intake item 9: the run goal waiting for the owner shows in the header and its goal line', async ($, on) => {
  const w = world($, on)
  const lines = await show($, w, planOf([crew('r0', 0)], [goalEntry('g1')], { approval: 'owner', approvedAt: null }))
  expect(lines[0]).toBe('Plan (1 crews, 2 goals, approval owner, waiting for the owner):')
  expect(lines[1]).toBe('Goal run (approval owner, waiting for the owner): g')
})

test('intake item 9: a crew naming a goal that is not in the plan is listed under a not-in-the-plan line after the known goals', async ($, on) => {
  const w = world($, on)
  const lines = await show($, w, planOf([crew('x', 0, 'planned', { goal: 'ghost' }), crew('a0', 0, 'running', { goal: 'g1' }), crew('r0', 0, 'running')], [goalEntry('g1')]))
  expect(lines).toEqual([
    'Plan (3 crews, 2 goals, approval auto):',
    'Goal run (approval auto): g',
    '- wave 0: r0, change, running',
    'Goal g1 (approval auto): goal g1',
    '- wave 0: a0, change, running',
    'Goal ghost (not in the plan):',
    `- wave 0: x, change, planned, waits for a fix: goal ghost isn't in the plan`,
  ])
})

test('intake item 9: the goal text is collapsed to one line and cut at 100 characters', async ($, on) => {
  const w = world($, on)
  const exact = 'e'.repeat(100)
  const over = `${'o'.repeat(99)}p`.padEnd(101, 'q')
  const lines = await show($, w, planOf([crew('r0', 0, 'running')], [goalEntry('g1', { goal: exact }), goalEntry('g2', { goal: over }), goalEntry('g3', { goal: `${'w'.repeat(50)}\n\n  \t${'x'.repeat(49)}` })]))
  expect(lines).toContain(`Goal g1 (approval auto, done): ${exact}`)
  expect(lines).toContain(`Goal g2 (approval auto, done): ${over.slice(0, 99)}…`)
  expect(lines).toContain(`Goal g3 (approval auto, done): ${'w'.repeat(50)} ${'x'.repeat(49)}`)
})

test('intake item 10: a crew with goal "run" is listed under Goal run with the crews that have no goal', async ($, on) => {
  const w = world($, on)
  const lines = await show($, w, planOf([crew('a', 0, 'running'), crew('t', 0, 'planned', { goal: 'run' }), crew('a0', 0, 'running', { goal: 'g1' })], [goalEntry('g1')]))
  expect(lines).toEqual([
    'Plan (3 crews, 2 goals, approval auto):',
    'Goal run (approval auto): g',
    '- wave 0: a, change, running',
    '- wave 0: t, change, planned, ready to start',
    'Goal g1 (approval auto): goal g1',
    '- wave 0: a0, change, running',
  ])
})

test('intake item 9: the section 5 example prints exactly its lines, with no after', async ($, on) => {
  const w = world($, on)
  const head = 'Make foundry prod-grade on quality and bloat, from the reviewed anti-bloat analysis: (1) hook clean'
  expect(head.length).toBe(99)
  const runGoal = `${head}ing of the hooks,\n  (2) fewer   prompts,\n\n(3) ${'more words about the plan '.repeat(50)}end`
  expect(runGoal.replace(/\s+/g, ' ').length).toBeGreaterThan(1000)
  const intake = 'Mid-run intake: start new crews mid-run, tell the owner what is in progress, take more work'
  const plan = planOf(
    [
      crew('eval-design', 0, 'merged', { verdict: 'design' }),
      crew('hooks-cleanup', 1, 'merged', { verdict: 'extend' }),
      crew('evals-build', 1, 'running'),
      crew('prompt-rules', 2, 'planned'),
      crew('intake-design', 0, 'running', { goal: 'intake', verdict: 'design' }),
      crew('intake-gates', 1, 'planned', { goal: 'intake' }),
      crew('intake-retro', 1, 'planned', { goal: 'intake' }),
    ],
    [goalEntry('intake', { goal: intake, approval: 'owner', approvedAt: '2026-10-17T11:30:00Z' })],
    { goal: runGoal, approval: 'owner', approvedAt: APPROVED },
  )
  expect(await show($, w, plan)).toEqual([
    'Plan (7 crews, 2 goals, approval owner):',
    `Goal run (approval owner): ${head}…`,
    '- wave 0: eval-design, design, merged',
    '- wave 1: hooks-cleanup, extend, merged',
    '- wave 1: evals-build, change, running',
    '- wave 2: prompt-rules, change, planned, waits for wave 1 to merge: evals-build',
    `Goal intake (approval owner): ${intake}`,
    '- wave 0: intake-design, design, running',
    '- wave 1: intake-gates, change, planned, waits for wave 0 to merge: intake-design',
    '- wave 1: intake-retro, change, planned, waits for wave 0 to merge: intake-design',
  ])
})
