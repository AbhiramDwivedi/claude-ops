// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0009 Decision 6 (the Workflow gate) and Decision 2 (roles table). Written from the ADR before the code.
//
// Run with: node --test plugins/foundry/tests/workflow-gate.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Assumption (the ADR fixes it in the `start --wave` output): args.foundry.crews is an array of crew entries,
// each an object with a `slug`. Wave tests pass crews in that form.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'

const { workflowRoleVerdict, workflowCallVerdict, fencedBlock } = reg

const ROLES = {
  architect: { agentType: 'foundry:architect', model: 'opus', effort: 'medium', isolation: 'worktree' },
  cynic: { agentType: 'foundry:cynic', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'foundry:crew-planner', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'foundry:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  redteam: { agentType: 'foundry:judge', model: 'opus', effort: 'medium', isolation: 'worktree' },
  judge: { agentType: 'foundry:judge', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}
const withRole = (key: string, role: unknown) => ({ ...ROLES, [key]: role })

const isDeny = (v: unknown) => {
  assert.ok(v && typeof v === 'object', `expected a deny, got ${JSON.stringify(v)}`)
  assert.equal(typeof (v as { deny: unknown }).deny, 'string')
  return (v as { deny: string }).deny
}
const refused = (v: unknown) => {
  const d = isDeny(v)
  assert.ok(d.startsWith('[foundry] Refused:'), d)
  return d
}

test('register.ts exports the three functions', () => {
  assert.equal(typeof reg.workflowCallVerdict, 'function')
  assert.equal(typeof reg.workflowRoleVerdict, 'function')
  assert.equal(typeof reg.fencedBlock, 'function')
})

// ---- workflowRoleVerdict ----

test('roles: the Decision 2 table is accepted', () => {
  assert.equal(workflowRoleVerdict(ROLES), undefined)
})

for (const model of ['fable', 'haiku', 'claude-opus-4-5', 'Opus', '']) {
  test(`roles: model ${JSON.stringify(model)} is refused`, () => {
    isDeny(workflowRoleVerdict(withRole('builder', { ...ROLES.builder, model })))
  })
}
for (const effort of ['high', 'xhigh', 'max']) {
  test(`roles: effort ${effort} is refused`, () => {
    isDeny(workflowRoleVerdict(withRole('judge', { ...ROLES.judge, effort })))
  })
}
test('roles: a missing model is refused', () => {
  const { model: _m, ...rest } = ROLES.cynic
  isDeny(workflowRoleVerdict(withRole('cynic', rest)))
})
test('roles: a missing effort is refused', () => {
  const { effort: _e, ...rest } = ROLES.cynic
  isDeny(workflowRoleVerdict(withRole('cynic', rest)))
})
test('roles: a lead role is refused even on opus/medium', () => {
  isDeny(workflowRoleVerdict(withRole('lead', { agentType: 'foundry:lead', model: 'opus', effort: 'medium', isolation: 'worktree' })))
})
test('roles: a devops role is refused even on sonnet/low', () => {
  isDeny(workflowRoleVerdict(withRole('devops', { agentType: 'foundry:devops', model: 'sonnet', effort: 'low', isolation: 'none' })))
})
for (const key of ['red-team', 'judge2', 'Judge', 'JUDGE', 'red_team', '']) {
  test(`roles: role key ${JSON.stringify(key)} is refused`, () => {
    isDeny(workflowRoleVerdict(withRole(key, ROLES.judge)))
  })
}
for (const [name, v] of [['undefined', undefined], ['null', null], ['array', []], ['array of roles', [ROLES.judge]], ['string', 'roles'], ['number', 3]] as const) {
  test(`roles: non-object input (${name}) is refused`, () => {
    isDeny(workflowRoleVerdict(v))
  })
}

// ---- workflowCallVerdict ----

const PLUGIN = 'C:/p'
const PLAN_JS = '// plan.js\nexport default async function () { await agent({ type: "foundry:architect" }) }\n'
const WAVE_JS = '// wave.js\nexport default async function () { await agent({ type: "foundry:judge" }) }\n'
const TEXTS = [PLAN_JS, WAVE_JS]
const APPROVED = '2026-10-29T00:00:00Z'

const plan = (extra: Record<string, unknown> = {}) =>
  ({ version: 2, goal: 'g', approval: 'auto', approvedAt: null, maxParallelCrews: 4, repairBudget: 2, crews: [], ...extra }) as never
const crew = (slug: string, wave: number, status: string) => ({ slug, wave, status, verdict: 'extend' })

const call = (over: Record<string, unknown> = {}) => ({
  scriptPath: `${PLUGIN}/workflows/plan.js`,
  scriptText: PLAN_JS,
  args: { foundry: { kind: 'plan', roles: ROLES } },
  pluginDir: PLUGIN,
  pluginScriptTexts: TEXTS,
  ...over,
})
const FOREIGN = 'export default async function () { await agent({ type: "foundry:lead" }) }\n'
const NOT_FOUNDRY = 'export default async function () { await agent({ type: "general-purpose" }) }\n'
const ONLY_FROM = "foundry agents run in a Workflow only from the plugin's plan.js and wave.js"
const waveArgs = (crews: unknown[] = []) => ({ foundry: { kind: 'wave', roles: ROLES, crews } })

test('call: no plan is undefined, even for a foreign script naming foundry:', () => {
  assert.equal(workflowCallVerdict(undefined, call({ scriptPath: '/x/evil.js', scriptText: FOREIGN })), undefined)
})
test('call: a version 1 plan is undefined, even for a foreign script naming foundry:', () => {
  assert.equal(workflowCallVerdict(plan({ version: 1 }), call({ scriptPath: '/x/evil.js', scriptText: FOREIGN })), undefined)
})

test('call: plan.js by path passes', () => {
  assert.equal(workflowCallVerdict(plan(), call()), undefined)
})
test('call: wave.js by path passes', () => {
  const input = call({ scriptPath: `${PLUGIN}/workflows/wave.js`, scriptText: WAVE_JS, args: waveArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: a backslash scriptPath matches the plugin dir', () => {
  const input = call({ scriptPath: 'C:\\p\\workflows\\wave.js', scriptText: WAVE_JS, args: waveArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: foundry-by-path with a bad roles table is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { foundry: { kind: 'plan', roles: withRole('x', { ...ROLES.judge, model: 'fable' }) } } })))
})

test("call: a byte-identical copy of wave.js at another path is foundry's", () => {
  const input = call({ scriptPath: '/home/u/.claude/projects/p/s/workflows/scripts/foundry-wave.js', scriptText: WAVE_JS, args: waveArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: a copy at another path is held to the args checks (missing args.foundry refused)', () => {
  refused(workflowCallVerdict(plan(), call({ scriptPath: '/elsewhere/foundry-plan.js', scriptText: PLAN_JS, args: {} })))
})
test("call: an inline script with identical text is foundry's", () => {
  const input = call({ script: WAVE_JS, scriptPath: undefined, scriptText: WAVE_JS, args: waveArgs() })
  assert.equal(workflowCallVerdict(plan(), input), undefined)
})
test('call: an edited copy (one byte changed) naming foundry: is refused with the plan.js/wave.js text', () => {
  const edited = WAVE_JS.replace('judge', 'judgf')
  assert.notEqual(edited, WAVE_JS)
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/foundry-wave.js', scriptText: edited, args: waveArgs() })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: an edited copy (trailing newline added) naming foundry: is refused', () => {
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/foundry-plan.js', scriptText: PLAN_JS + '\n' })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: an edited inline script naming foundry: is refused', () => {
  const d = refused(workflowCallVerdict(plan(), call({ script: PLAN_JS + ' ', scriptPath: undefined, scriptText: PLAN_JS + ' ' })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: a foreign script whose text contains foundry: is refused with the plan.js/wave.js text', () => {
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/other.js', scriptText: FOREIGN, args: undefined })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: a foreign scriptPath that could not be read is refused with that text', () => {
  const d = refused(workflowCallVerdict(plan(), call({ scriptPath: '/x/missing.js', scriptText: undefined, args: undefined })))
  assert.ok(d.includes(ONLY_FROM), d)
})
test('call: a foreign script without foundry: is undefined', () => {
  assert.equal(workflowCallVerdict(plan(), call({ scriptPath: '/x/other.js', scriptText: NOT_FOUNDRY, args: undefined })), undefined)
})

test('call: args absent is refused for a foundry script', () => {
  refused(workflowCallVerdict(plan(), call({ args: undefined })))
})
test('call: args.foundry absent is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: {} })))
})
test('call: args.foundry a string is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { foundry: 'plan' } })))
})
test('call: args.foundry null is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { foundry: null } })))
})
test('call: a role on fable is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { foundry: { kind: 'plan', roles: withRole('judge', { ...ROLES.judge, model: 'fable' }) } } })))
})
test('call: a lead role is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { foundry: { kind: 'plan', roles: withRole('lead', ROLES.judge) } } })))
})
test('call: missing roles is refused', () => {
  refused(workflowCallVerdict(plan(), call({ args: { foundry: { kind: 'plan' } } })))
})

test('call: kind plan on an approved plan is refused', () => {
  refused(workflowCallVerdict(plan({ approvedAt: APPROVED }), call()))
})
test('call: kind plan with approvedAt null is undefined', () => {
  assert.equal(workflowCallVerdict(plan({ approvedAt: null }), call()), undefined)
})

const waveCall = (crews: unknown[]) => call({ scriptPath: `${PLUGIN}/workflows/wave.js`, scriptText: WAVE_JS, args: waveArgs(crews) })

test('call: kind wave with every crew running and allowed is undefined', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'running'), crew('b', 1, 'running')] })
  assert.equal(workflowCallVerdict(p, waveCall([{ slug: 'a' }, { slug: 'b' }])), undefined)
})
test('call: kind wave refuses a crew whose status is planned', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'running'), crew('b', 1, 'planned')] })
  refused(workflowCallVerdict(p, waveCall([{ slug: 'a' }, { slug: 'b' }])))
})
test('call: kind wave refuses a crew whose status is merged', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'merged')] })
  refused(workflowCallVerdict(p, waveCall([{ slug: 'a' }])))
})
test('call: kind wave refuses when planVerdict refuses (an earlier wave is not merged)', () => {
  const p = plan({ approvedAt: APPROVED, crews: [crew('a', 1, 'planned'), crew('b', 2, 'running')] })
  refused(workflowCallVerdict(p, waveCall([{ slug: 'b' }])))
})
test('call: kind wave refuses when planVerdict refuses (the owner has not approved the design)', () => {
  const p = plan({ approval: 'owner', approvedAt: null, crews: [crew('a', 1, 'running')] })
  refused(workflowCallVerdict(p, waveCall([{ slug: 'a' }])))
})
test('call: kind wave refuses when planVerdict refuses (the cap is reached)', () => {
  const p = plan({ approvedAt: APPROVED, maxParallelCrews: 1, crews: [crew('a', 1, 'running'), crew('b', 1, 'running')] })
  refused(workflowCallVerdict(p, waveCall([{ slug: 'a' }])))
})

// ---- fencedBlock ----

// Contract (register.ts comment): the inner lines of the first block that opens with a line exactly equal to `open`
// (the opening fence itself, e.g. '````json plan.json') and ends at the next line that is exactly four backticks.

test('fencedBlock: returns the inner lines of the block opened by the given line', () => {
  const msg = 'intro\n````json plan.json\n{"a":1}\nx\n````\ntrailer'
  assert.equal(fencedBlock(msg, '````json plan.json'), '{"a":1}\nx')
})
test('fencedBlock: strips CRLF', () => {
  const msg = 'intro\r\n````markdown plan.md\r\na\r\nb\r\n````\r\ntrailer'
  assert.equal(fencedBlock(msg, '````markdown plan.md'), 'a\nb')
})
test('fencedBlock: undefined without a closing fence', () => {
  assert.equal(fencedBlock('````json plan.json\na\nb\n', '````json plan.json'), undefined)
})
test('fencedBlock: undefined when the opening line is absent', () => {
  assert.equal(fencedBlock('nothing here\n````\na\n````', '````json plan.json'), undefined)
})
test('fencedBlock: the first matching block wins', () => {
  const msg = '````json plan.json\nfirst\n````\n````json plan.json\nsecond\n````'
  assert.equal(fencedBlock(msg, '````json plan.json'), 'first')
})
