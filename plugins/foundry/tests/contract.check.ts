// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry 0.4.0 contract, foundry ADR-0002 "Seams": the init, run and architect prompts and the
// foundry.json schema, read as text. Written by the design crew before wave 1 changes the prompts.
//
// Run with: node --test plugins/foundry/tests/contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` gives tests no fs. Every read goes through
// `read`, which returns '' for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}
const init = () => read('skills', 'init', 'SKILL.md')
const run = () => read('skills', 'run', 'SKILL.md')
const architect = () => read('agents', 'architect.md')
const schemaText = () => read('docs', 'foundry-config.schema.json')

const has = (text: string, phrase: string, where: string) => assert.ok(text.includes(phrase), `${where} does not name: ${phrase}`)
const lacks = (text: string, phrase: string, where: string) => assert.ok(!text.includes(phrase), `${where} still holds: ${phrase}`)

// ---------- 1. init builds on kit's manifest ----------

test('init names the kit manifest path', () => has(init(), '.claude/kit/manifest.json', 'skills/init/SKILL.md'))

test('init runs kit:init with the declare args', () => {
  has(init(), 'kit:init', 'skills/init/SKILL.md')
  has(init(), 'declare read-only: foundry:judge, foundry:cynic', 'skills/init/SKILL.md')
})

test('init says what it does when kit is not installed', () =>
  has(init(), 'kit is not installed; foundry init carries on without a kit manifest (0.3.0 behaviour)', 'skills/init/SKILL.md'))

// ---------- 2. init writes only declared foundry.json keys ----------

test('init names the config schema', () => has(init(), 'foundry-config.schema.json', 'skills/init/SKILL.md'))

test('init names each new key the schema declares', () => {
  const props = Object.keys(JSON.parse(schemaText() || '{}').properties ?? {})
  for (const key of ['roles', 'deploy', 'writingSkill', 'promptOverrides']) {
    assert.ok(props.includes(key), `foundry-config.schema.json does not declare ${key}`)
    has(init(), key, 'skills/init/SKILL.md')
  }
})

// ---------- 3. run skill: ports from worktrees, prompt overrides, roles ----------

test('run names PORT_BASE, Prompt overrides: and roles', () => {
  has(run(), 'PORT_BASE', 'skills/run/SKILL.md')
  has(run(), 'Prompt overrides:', 'skills/run/SKILL.md')
  has(run(), 'roles', 'skills/run/SKILL.md')
})

test('run no longer holds the invented port range 4100-4109', () => {
  assert.ok(run() !== '', 'skills/run/SKILL.md not found')
  lacks(run(), '4100-4109', 'skills/run/SKILL.md')
})

// ---------- 4. architect: diagrams and ports ----------

test('architect asks for mermaid diagrams', () => has(architect(), 'mermaid', 'agents/architect.md'))

test('architect holds the no-setup-script ports line', () =>
  has(architect(), 'ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)', 'agents/architect.md'))

test('architect no longer holds "port range"', () => {
  assert.ok(architect() !== '', 'agents/architect.md not found')
  lacks(architect(), 'port range', 'agents/architect.md')
})

// ---------- 5. the config schema ----------

test('the config schema parses as JSON and is closed', () => {
  const schema = JSON.parse(schemaText())
  assert.equal(schema.additionalProperties, false)
})

test('each promptOverrides value pattern takes a file directly under .claude/foundry/prompts/', () => {
  const schema = JSON.parse(schemaText())
  const roles = schema.properties?.promptOverrides?.properties ?? {}
  assert.deepEqual(Object.keys(roles).sort(), ['architect', 'cynic', 'devops', 'judge', 'lead', 'writer'])
  for (const [role, def] of Object.entries(roles)) {
    let node = def
    if (node.$ref) node = node.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], schema)
    assert.equal(typeof node?.pattern, 'string', `promptOverrides.${role} has no pattern`)
    const re = new RegExp(node.pattern)
    assert.ok(re.test('.claude/foundry/prompts/judge.md'), `${role}: rejects .claude/foundry/prompts/judge.md`)
    assert.ok(!re.test('../judge.md'), `${role}: accepts ../judge.md`)
    assert.ok(!re.test('.claude/foundry/prompts/a/b.md'), `${role}: accepts .claude/foundry/prompts/a/b.md`)
  }
})
