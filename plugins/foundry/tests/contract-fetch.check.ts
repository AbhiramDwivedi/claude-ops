// @ts-nocheck
// foundry 0.8.0 contract, ADR-0005 section 11: the `fetch` branch of docs/events.schema.json, read with node:fs and
// checked with a small inline validator (type, enum, const, required, properties, additionalProperties, minLength,
// maxLength, minimum, oneOf, anyOf, allOf, if/then, not). Synthetic data only (P8).
//
// Run with: node --test plugins/foundry/tests/contract-fetch.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` gives tests no fs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = (() => {
  try {
    return readFileSync(join(PLUGIN, 'docs', 'events.schema.json'), 'utf8')
  } catch {
    return ''
  }
})()
const schema = text === '' ? {} : JSON.parse(text)

const typeOk = (v, t) =>
  t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isInteger(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === t
// true when value v satisfies schema s
function ok(s, v) {
  if (s === true || s === undefined) return true
  if (s === false) return false
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) return false
  if (s.enum && !s.enum.some(x => JSON.stringify(x) === JSON.stringify(v))) return false
  if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => typeOk(v, t))) return false
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) return false
    if (s.maxLength !== undefined && v.length > s.maxLength) return false
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) return false
  if (typeOk(v, 'object')) {
    for (const k of s.required ?? []) if (!(k in v)) return false
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v && !ok(sub, v[k])) return false
    if (s.additionalProperties === false && Object.keys(v).some(k => !(k in (s.properties ?? {})))) return false
  }
  if (s.allOf && !s.allOf.every(x => ok(x, v))) return false
  if (s.anyOf && !s.anyOf.some(x => ok(x, v))) return false
  if (s.oneOf && s.oneOf.filter(x => ok(x, v)).length !== 1) return false
  if (s.not && ok(s.not, v)) return false
  if (s.if && ok(s.if, v)) return ok(s.then, v)
  return true
}
const valid = v => ok(schema, v)

const base = { v: 1, ts: '2026-10-29T08:12:03.512Z', crew: 'growth-contract', agent: 'growth-contract-architect' }
const fetchLine = (extra = {}) => ({ ...base, event: 'fetch', tool: 'WebFetch', url: 'https://example.com:8443/docs/api?version=&lang=', ...extra })

test('ADR-0005 the schema file reads, parses and names the fetch event', () => {
  assert.ok(text.includes('"fetch"'), 'events.schema.json does not hold the literal "fetch"')
  assert.ok(schema.properties.event.enum.includes('fetch'))
})

test('ADR-0005 the validator itself rejects a bad line (sanity)', () => {
  assert.equal(valid({ ...base, event: 'nope' }), false)
  assert.equal(valid({ ...base, v: 2, event: 'budget-spent' }), false)
})

test('ADR-0005 a WebFetch line with a url validates', () => {
  assert.equal(valid(fetchLine()), true)
})

test('ADR-0005 a WebSearch line with a query validates', () => {
  const { url, ...rest } = fetchLine()
  assert.equal(valid({ ...rest, crew: 'main', agent: 'main', tool: 'WebSearch', query: 'example-cli export command flags' }), true)
})

test('ADR-0005 a fetch line with both url and query fails', () => {
  assert.equal(valid(fetchLine({ query: 'q' })), false)
  assert.equal(valid(fetchLine({ tool: 'WebSearch', query: 'q' })), false)
})

test('ADR-0005 a fetch line with tool Bash fails', () => {
  assert.equal(valid(fetchLine({ tool: 'Bash' })), false)
})

test('ADR-0005 a WebFetch line without url fails, and a WebSearch line without query fails', () => {
  const { url, ...noUrl } = fetchLine()
  assert.equal(valid(noUrl), false)
  assert.equal(valid({ ...noUrl, tool: 'WebSearch' }), false)
})

test('ADR-0005 a fetch line without tool, crew or agent fails', () => {
  const { tool, ...noTool } = fetchLine()
  assert.equal(valid(noTool), false)
  const { crew, ...noCrew } = fetchLine()
  assert.equal(valid(noCrew), false)
  const { agent, ...noAgent } = fetchLine()
  assert.equal(valid(noAgent), false)
})

test('ADR-0005 the existing event kinds still validate', () => {
  const lines = [
    { ...base, event: 'budget-spent' },
    { ...base, event: 'spawn', agentId: 'new1', type: 'kit:builder', model: 'sonnet', effort: null, by: 'main' },
    { ...base, event: 'stall', kind: 'agent', minutes: 12 },
    { ...base, event: 'tag', tag: 'QUESTION' },
    { ...base, event: 'report', marker: 'VERDICT: PASS' },
    { ...base, event: 'report', marker: null },
  ]
  for (const l of lines) assert.equal(valid(l), true, JSON.stringify(l))
})

test('ADR-0005 existing event kinds still reject extra or missing fields', () => {
  assert.equal(valid({ ...base, event: 'tag', tag: 'QUESTION', url: 'https://example.com/' }), false)
  assert.equal(valid({ ...base, event: 'stall', kind: 'agent' }), false)
  assert.equal(valid({ ...base, event: 'budget-spent', tool: 'WebFetch' }), false)
})
