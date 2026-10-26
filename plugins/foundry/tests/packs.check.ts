// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry 0.3.0, principles crew: the principle packs (ADR-0001 section 2) and the architect agent
// (sections 3-5). Written before any pack exists.
//
// Run with: node --test plugins/foundry/tests/packs.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs, so it can't read the
// packs from disk. Node can. Every read goes through `read`/`files`, which return ''/[] for a
// missing path, so each test fails on its own assertion instead of crashing the file.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKS = ['core', 'service', 'frontend', 'data', 'ai', 'infra', 'library'] as const

const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}
const files = (...parts: string[]): string[] => {
  try {
    const dir = join(PLUGIN, ...parts)
    return readdirSync(dir).filter(f => statSync(join(dir, f)).isFile())
  } catch {
    return []
  }
}
const skill = () => read('skills', 'principles', 'SKILL.md')
const pack = (name: string) => read('skills', 'principles', `${name}.md`)
const architect = () => read('agents', 'architect.md')

// Frontmatter: the block between a leading `---` line and the next `---` line, as key -> value.
const frontmatter = (text: string): Record<string, string> | null => {
  const m = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---(\n|$)/, '')

// The lines of the `## Rules` section, up to the next `## ` heading or end of file.
const rulesSection = (text: string): string[] | null => {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^## Rules\s*$/.test(l))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^## /.test(l))
  return end < 0 ? rest : rest.slice(0, end)
}
const RULE = /^\d+\. \S/
const TEST = /^   Test: \S/

// ---------- harness sanity: the plugin root resolves (so the failures below are real) ----------

test('packs harness: the plugin root resolves to the foundry plugin files', () => {
  assert.match(read('agents', 'judge.md'), /^---\nname: judge\n/)
  assert.ok(files('agents').includes('judge.md'))
})

// ---------- 1. the index skill ----------

test('principles: skills/principles/SKILL.md exists', () => {
  assert.ok(files('skills', 'principles').includes('SKILL.md'), 'SKILL.md missing')
})

test('principles: SKILL.md frontmatter has name: principles and a non-empty description', () => {
  const fm = frontmatter(skill())
  assert.notEqual(fm, null, 'no frontmatter')
  assert.equal(fm?.name, 'principles')
  assert.ok((fm?.description ?? '').length > 0, 'empty description')
})

// ---------- 2. the seven packs, listed in the index, and nothing else ----------

for (const name of PACKS) {
  test(`principles: pack ${name}.md exists`, () => {
    assert.ok(files('skills', 'principles').includes(`${name}.md`), `${name}.md missing`)
  })

  test(`principles: SKILL.md names ${name}.md`, () => {
    assert.ok(skill().includes(`${name}.md`), `SKILL.md does not name ${name}.md`)
  })
}

test('principles: the directory holds only SKILL.md and the seven packs as .md files', () => {
  const md = files('skills', 'principles').filter(f => f.endsWith('.md')).sort()
  assert.deepEqual(md, ['SKILL.md', ...PACKS.map(p => `${p}.md`)].sort())
})

// ---------- 3 and 4. pack format ----------

for (const name of PACKS) {
  test(`principles: ${name} has no frontmatter and starts with a # heading`, () => {
    const text = pack(name)
    assert.ok(!text.startsWith('---'), 'pack has frontmatter')
    assert.match(text.split('\n')[0], /^# \S/)
  })

  test(`principles: ${name} has a ## Rules section`, () => {
    assert.notEqual(rulesSection(pack(name)), null, 'no ## Rules section')
  })

  test(`principles: ${name} pairs every rule line with the Test line right after it`, () => {
    const lines = rulesSection(pack(name)) ?? []
    const problems: string[] = []
    lines.forEach((line, i) => {
      if (RULE.test(line) && !TEST.test(lines[i + 1] ?? '')) problems.push(`rule without test: ${line}`)
      if (TEST.test(line) && !RULE.test(lines[i - 1] ?? '')) problems.push(`orphan test: ${line}`)
    })
    assert.ok(lines.some(l => RULE.test(l)), 'no rule lines')
    assert.deepEqual(problems, [])
  })

  test(`principles: ${name} has 5 to 15 rules numbered 1..n in order`, () => {
    const lines = rulesSection(pack(name)) ?? []
    const numbers = lines.filter(l => RULE.test(l)).map(l => Number(/^(\d+)\./.exec(l)![1]))
    assert.ok(numbers.length >= 5, `only ${numbers.length} rules`)
    assert.ok(numbers.length <= 15, `${numbers.length} rules`)
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1))
  })
}

// ---------- 5. topics from ADR section 2 (loose, case-insensitive) ----------

const TOPICS: Record<(typeof PACKS)[number], (string | RegExp)[]> = {
  core: ['cohesion', 'coupling', 'interface', 'contract', /fail[ -]fast/, 'idempotent', 'observab', /secure|security default/, 'yagni'],
  service: ['config', 'environment', 'stateless', 'health'],
  frontend: ['component', 'accessibility', /budget/],
  data: ['idempotent', 'schema', 'raw', 'lineage', 'backfill', 'quality'],
  ai: ['eval', 'version', 'prompt', 'budget', /latency|cost/],
  infra: ['code', 'immutable', 'least privilege', 'rollback'],
  library: ['public api', 'semver', 'import'],
}

for (const name of PACKS) {
  test(`principles: ${name} covers its ADR section 2 topics`, () => {
    const text = pack(name).toLowerCase()
    const missing = TOPICS[name].filter(t => (typeof t === 'string' ? !text.includes(t) : !t.test(text))).map(String)
    assert.ok(text.length > 0, `${name}.md empty or missing`)
    assert.deepEqual(missing, [])
  })
}

// ---------- 6. the architect agent ----------

test('architect: agents/architect.md exists', () => {
  assert.ok(files('agents').includes('architect.md'), 'architect.md missing')
})

test('architect: frontmatter has name, description, model opus and effort high', () => {
  const fm = frontmatter(architect())
  assert.notEqual(fm, null, 'no frontmatter')
  assert.equal(fm?.name, 'architect')
  assert.ok((fm?.description ?? '').length > 0, 'empty description')
  assert.equal(fm?.model, 'opus')
  assert.equal(fm?.effort, 'high')
})

test('architect: tools line has Read, Grep, Glob, Bash, Skill, Write and Edit', () => {
  const tools = (frontmatter(architect())?.tools ?? '').split(',').map(t => t.trim())
  const missing = ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Write', 'Edit'].filter(t => !tools.includes(t))
  assert.deepEqual(missing, [])
})

for (const mode of ['init', 'plan', 'design']) {
  test(`architect: body names the ${mode} mode with a heading or bold label`, () => {
    const b = body(architect())
    assert.match(b, new RegExp(`\\b${mode}\\b`))
    assert.match(b, new RegExp(`(^#+ .*\\b${mode}\\b|\\*\\*${mode}\\b)`, 'im'))
  })
}

test('architect: body names the plan files, the schema and the project config', () => {
  const b = body(architect())
  const missing = ['plan.schema.json', 'plan.json', 'plan.md', '.claude/foundry.json'].filter(s => !b.includes(s))
  assert.ok(b.length > 0, 'architect.md empty or missing')
  assert.deepEqual(missing, [])
})

test('architect: body names the extend and change verdicts and the leaf test', () => {
  const b = body(architect())
  assert.match(b, /\bextend\b/)
  assert.match(b, /\bchange\b/)
  assert.ok(b.toLowerCase().includes('leaf test'), 'no "leaf test"')
})
