// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0004 Seams 3: the prompts carry the section 3 literals. Written before the prompts change.
//
// Run with: node --test plugins/foundry/tests/gates.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.
//
// Literals (verbatim, ADR-0004 section 3): `Head: `, `Patch: `, `## Examined`, `## Not examined`,
// `- UNSCOPED: `, and `BLOCKED: repair budget spent`.

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
const has = (text: string, needle: string, where: string) =>
  assert.ok(text.includes(needle), `${where} does not carry ${JSON.stringify(needle)}`)

const HEAD_LINE = 'Head: '
const PATCH_LINE = 'Patch: '
const EXAMINED = '## Examined'
const NOT_EXAMINED = '## Not examined'
const UNSCOPED = '- UNSCOPED: '
const BUDGET_BLOCKED = 'BLOCKED: repair budget spent'

const frontmatter = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out: Record<string, string> = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const k = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (k) out[k[1]] = k[2].trim()
  }
  return out
}

test('judge.md carries the Head: line literal', () => has(read('agents', 'judge.md'), HEAD_LINE, 'agents/judge.md'))
test('judge.md carries the Patch: line literal', () => has(read('agents', 'judge.md'), PATCH_LINE, 'agents/judge.md'))
test('judge.md carries the - UNSCOPED: finding literal', () => has(read('agents', 'judge.md'), UNSCOPED, 'agents/judge.md'))
test('judge.md names the patch command', () => has(read('agents', 'judge.md'), 'git patch-id --stable', 'agents/judge.md'))

test('lead.md carries the ## Examined heading', () => has(read('agents', 'lead.md'), EXAMINED, 'agents/lead.md'))
test('lead.md carries the ## Not examined heading', () => has(read('agents', 'lead.md'), NOT_EXAMINED, 'agents/lead.md'))
test('lead.md carries BLOCKED: repair budget spent', () => has(read('agents', 'lead.md'), BUDGET_BLOCKED, 'agents/lead.md'))

test('writer.md pins a model', () => {
  const fm = frontmatter(read('agents', 'writer.md'))
  assert.ok(['opus', 'sonnet'].includes(fm.model ?? ''), `agents/writer.md model is ${JSON.stringify(fm.model)}`)
})
test('writer.md pins an effort of low or medium', () => {
  const fm = frontmatter(read('agents', 'writer.md'))
  assert.ok(['low', 'medium'].includes(fm.effort ?? ''), `agents/writer.md effort is ${JSON.stringify(fm.effort)}, want low or medium`)
})

// ADR-0004 section 6, the foreman's merge gate: the crew's newest judge file modified at or after
// approvedAt (not "highest-numbered"); a PASS with no UNSCOPED line; its Head: value equals
// `git rev-parse <crew branch>`, or its Patch: value equals the patch id of PATCH_COMMAND with the lead's
// checks re-run green after the rebase.
test('run skill merge rule names the Head: and Patch: lines', () => {
  const run = read('skills', 'run', 'SKILL.md')
  has(run, HEAD_LINE, 'skills/run/SKILL.md')
  has(run, PATCH_LINE, 'skills/run/SKILL.md')
})
test('run skill merge rule names the patch command', () => has(read('skills', 'run', 'SKILL.md'), 'git patch-id --stable', 'skills/run/SKILL.md'))
test('run skill merge rule reads the newest judge file at or after approvedAt, not the highest-numbered', () => {
  const run = read('skills', 'run', 'SKILL.md')
  assert.ok(/newest judge file[^.]*approvedAt/.test(run), 'skills/run/SKILL.md does not pick the newest judge file at or after approvedAt')
  assert.ok(!run.includes('highest-numbered'), 'skills/run/SKILL.md still says "highest-numbered"')
})
test('run skill merge rule refuses a PASS with an UNSCOPED line', () => has(read('skills', 'run', 'SKILL.md'), 'UNSCOPED', 'skills/run/SKILL.md'))
test('run skill merge rule re-runs the lead checks when only the patch id matches', () => {
  const run = read('skills', 'run', 'SKILL.md')
  assert.ok(/Patch: [^\n]*(checks|re-run)/i.test(run) || /patch id[^\n]*(checks|re-run)/i.test(run), 'skills/run/SKILL.md does not tie a patch-id match to re-running the checks')
})
