// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0006 section 3: skills/retro/SKILL.md carries the root-cause step. Written before the skill changes.
//
// Run with: node --test plugins/foundry/tests/retro-cause.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion. Every failure says "producer missing".

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r/g, '')
  } catch {
    return ''
  }
}
const SKILL = read('skills', 'retro', 'SKILL.md')

const HEADING3 = '## 3. Find the causes'
const HEADING4 = '## 4. Propose changes'
const CAUSE_FORM = 'CAUSE: <anomaly> | <evidence> | <fix location>'
const NOT_FOUND = 'CAUSE: <anomaly> | not found | none'
const KINDS = ['leftover', 'judge fail', 'stall', 'overrule', 'spent budget']
const NOT_ANOMALY = 'Spawns over estAgents are not an anomaly; give them no CAUSE line.'
const SOURCES = "Its only sources are git, the disk, decisions.md, the judge files' VERDICT: and finding lines, and the plugin's own files."
const P24 = 'It never reads message, prompt or report bodies (P24).'
const BOUND = 'at most 3 reads per anomaly'
const PLUGIN_PREFIX = 'plugin: '
const NEVER_WRITTEN = 'Plugin-level causes go to the owner as plugin findings and are never written (ADR-0005 section 1).'
const DESC = 'why crews stalled or got rejected'

// the body of section 3: from its heading to the next `## ` heading ('' when the heading is missing)
const section3 = (): string => {
  const i = SKILL.indexOf(HEADING3)
  if (i < 0) return ''
  const rest = SKILL.slice(i + HEADING3.length)
  const j = rest.search(/\n## /)
  return j < 0 ? rest : rest.slice(0, j)
}
const inSection = (needle: string) =>
  assert.ok(section3().includes(needle), `producer missing: SKILL.md section 3 does not carry ${JSON.stringify(needle)}`)

test('heading 3 is "Find the causes", before heading 4, with a heading 5 after', () => {
  const h3 = SKILL.indexOf(HEADING3)
  const h4 = SKILL.indexOf(HEADING4)
  const h5 = SKILL.search(/^## 5\. /m)
  assert.ok(h3 >= 0, `producer missing: SKILL.md has no ${JSON.stringify(HEADING3)}`)
  assert.ok(h4 > h3, `producer missing: ${JSON.stringify(HEADING4)} is not after section 3`)
  assert.ok(h5 > h4, 'producer missing: no "## 5. " heading after section 4')
})

test('the CAUSE line form is pinned', () => inSection(CAUSE_FORM))

for (const kind of KINDS) {
  test(`anomaly kind \`${kind}\` is named in backticks`, () => inSection('`' + kind + '`'))
}

test('spawns over estAgents are not an anomaly', () => inSection(NOT_ANOMALY))
test('the not-found form is pinned', () => inSection(NOT_FOUND))
test('the sources sentence is pinned', () => inSection(SOURCES))
test('the P24 sentence is pinned', () => inSection(P24))
test('the read bound is pinned', () => inSection(BOUND))
test('plugin-level fix locations start with "plugin: "', () => inSection(PLUGIN_PREFIX))
test('plugin-level causes are never written', () => inSection(NEVER_WRITTEN))

test('the frontmatter description still carries "why crews stalled or got rejected"', () => {
  const m = /^---\n([\s\S]*?)\n---/.exec(SKILL)
  const desc = (m?.[1] ?? '').split('\n').find((l: string) => l.startsWith('description:')) ?? ''
  // already true today: this pins something built, so it passes before and after the producer lands
  assert.ok(desc.includes(DESC), `SKILL.md frontmatter description lost ${JSON.stringify(DESC)}`)
})
