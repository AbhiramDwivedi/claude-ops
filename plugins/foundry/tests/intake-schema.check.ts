// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0010 section 1 (as amended by the intake-gates spec: NO crew `after`): the plan.schema.json
// v3 edit, pinned by reading the schema as JSON and asserting its keywords. No validator, no dependency,
// no network.
//
// Run with: node --test plugins/foundry/tests/intake-schema.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` gives tests no fs (see contract.check.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'plan.schema.json')
const SLUG = '^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$'

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const props = schema.properties ?? {}
const allOf = schema.allOf ?? []

// Resolve a local "#/$defs/x" ref; anything else is returned as is.
const deref = (node: any): any => {
  if (node && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    return node.$ref
      .slice(2)
      .split('/')
      .reduce((n: any, k: string) => n?.[k], schema)
  }
  return node
}
const crew = deref(props.crews?.items) ?? {}
const crewProps = crew.properties ?? {}
const goalItem = deref(props.goals?.items) ?? {}
const goalProps = goalItem.properties ?? {}

// Does an `if` schema accept a plan whose version is n? Handles const, enum and anyOf of those.
const versionAccepts = (ifs: any, n: number): boolean => {
  const v = ifs?.properties?.version
  if (!v) return false
  const one = (p: any): boolean =>
    'const' in p ? p.const === n : Array.isArray(p.enum) ? p.enum.includes(n) : false
  if (Array.isArray(v.anyOf)) return v.anyOf.some(one)
  return one(v)
}

// Does `node` forbid a property `key` on the object it applies to?
const forbidsKey = (node: any, key: string): boolean => {
  if (!node) return false
  const p = node.properties?.[key]
  if (p === false || (p && typeof p === 'object' && JSON.stringify(p.not) === '{}')) return true
  const n = node.not
  if (n) {
    if (Array.isArray(n.required) && n.required.includes(key)) return true
    if (Array.isArray(n.anyOf) && n.anyOf.some((a: any) => a?.required?.includes(key))) return true
  }
  if (Array.isArray(node.allOf)) return node.allOf.some((a: any) => forbidsKey(a, key))
  return false
}

const types = (p: any): string[] => (Array.isArray(p?.type) ? p.type : p?.type ? [p.type] : [])

test('version enum is [1, 2, 3]', () => {
  assert.deepEqual(props.version?.enum, [1, 2, 3])
})

test('repairBudget is required in versions 2 and 3, not in 1', () => {
  const req = allOf.filter((e: any) => e.then?.required?.includes('repairBudget'))
  assert.ok(req.length > 0, 'no allOf entry requires repairBudget')
  assert.ok(
    req.some((e: any) => versionAccepts(e.if, 2) && versionAccepts(e.if, 3) && !versionAccepts(e.if, 1)),
    'the conditional that requires repairBudget must cover versions 2 and 3 and not 1',
  )
})

test('version 1 still forbids repairBudget', () => {
  const forb = allOf.filter((e: any) => forbidsKey(e.then, 'repairBudget'))
  assert.ok(
    forb.some((e: any) => versionAccepts(e.if, 1) && !versionAccepts(e.if, 2) && !versionAccepts(e.if, 3)),
    'no conditional forbids repairBudget for version 1 only',
  )
})

test('top-level goals: array, minItems 1, closed items with the five required fields', () => {
  assert.ok(props.goals, 'properties.goals is missing')
  assert.equal(props.goals.type, 'array')
  assert.equal(props.goals.minItems, 1)
  assert.equal(goalItem.additionalProperties, false)
  assert.deepEqual([...(goalItem.required ?? [])].sort(), ['addedAt', 'approval', 'approvedAt', 'goal', 'id'])
  assert.deepEqual(Object.keys(goalProps).sort(), ['addedAt', 'approval', 'approvedAt', 'goal', 'id'])
})

test('goals[].id: slug pattern, maxLength 100, not the reserved "run"', () => {
  const id = goalProps.id ?? {}
  assert.equal(id.type, 'string')
  assert.equal(id.pattern, SLUG)
  assert.equal(id.maxLength, 100)
  assert.deepEqual(id.not, { const: 'run' })
})

test('goals[].goal is a non-empty string', () => {
  assert.equal(goalProps.goal?.type, 'string')
  assert.equal(goalProps.goal?.minLength, 1)
})

test('goals[].addedAt is a date-time string', () => {
  assert.equal(goalProps.addedAt?.type, 'string')
  assert.equal(goalProps.addedAt?.format, 'date-time')
})

test('goals[].approval is auto or owner', () => {
  assert.deepEqual([...(goalProps.approval?.enum ?? [])].sort(), ['auto', 'owner'])
})

test('goals[].approvedAt is a date-time string or null, and approval auto requires a string', () => {
  const a = goalProps.approvedAt ?? {}
  assert.deepEqual(types(a).sort(), ['null', 'string'])
  assert.equal(a.format, 'date-time')
  const cond = (goalItem.allOf ?? []).filter(
    (e: any) =>
      (e.if?.properties?.approval?.const === 'auto' || e.if?.properties?.approval?.enum?.[0] === 'auto') &&
      types(e.then?.properties?.approvedAt).includes('string') &&
      !types(e.then?.properties?.approvedAt).includes('null'),
  )
  assert.ok(cond.length > 0, 'goal item has no conditional: approval auto => approvedAt must be a string')
})

test('crew goal: string with the slug pattern', () => {
  assert.ok(crewProps.goal, 'crew properties.goal is missing')
  assert.equal(crewProps.goal.type, 'string')
  assert.equal(crewProps.goal.pattern, SLUG)
})

test('crew has no `after` property (not approved)', () => {
  assert.ok(!('after' in crewProps), 'crew properties must not define after')
  assert.equal(crew.additionalProperties, false)
})

test('versions 1 and 2 forbid top-level goals', () => {
  const hit = allOf.filter((e: any) => forbidsKey(e.then, 'goals'))
  assert.ok(
    hit.some((e: any) => versionAccepts(e.if, 1) && versionAccepts(e.if, 2) && !versionAccepts(e.if, 3)),
    'no conditional forbids goals for versions 1 and 2 (and not 3)',
  )
})

test('versions 1 and 2 forbid crew goal', () => {
  const hit = allOf.filter((e: any) => {
    const items = deref(e.then?.properties?.crews?.items) ?? e.then?.properties?.crews?.items
    return forbidsKey(items, 'goal')
  })
  assert.ok(
    hit.some((e: any) => versionAccepts(e.if, 1) && versionAccepts(e.if, 2) && !versionAccepts(e.if, 3)),
    'no conditional forbids crew goal for versions 1 and 2 (and not 3)',
  )
})

test('top-level required list and additionalProperties are unchanged', () => {
  assert.deepEqual(schema.required, [
    'version',
    'goal',
    'architecture',
    'approval',
    'approvedAt',
    'maxParallelCrews',
    'crews',
  ])
  assert.equal(schema.additionalProperties, false)
})

test('crew required list and additionalProperties are unchanged', () => {
  assert.deepEqual(crew.required, [
    'slug',
    'wave',
    'verdict',
    'modules',
    'owns',
    'doneCheck',
    'doneCheckProved',
    'estAgents',
    'status',
  ])
  assert.equal(crew.additionalProperties, false)
})
