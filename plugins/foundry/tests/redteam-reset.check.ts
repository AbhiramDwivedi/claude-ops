// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0006 section 2: the red team resets its own branch and leaves a clean worktree. Written before the prompts change.
//
// Run with: node --test plugins/foundry/tests/redteam-reset.check.ts
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
const JUDGE = read('agents', 'judge.md')
const LEAD = read('agents', 'lead.md')

const RED_START = 'When your brief opens with the line `Red team:`'
const RESET = 'git reset --hard <sha>'

// the red-team section: from its first line to the next `## ` heading ('' when the start is missing)
const redTeam = (): string => {
  const i = JUDGE.indexOf(RED_START)
  if (i < 0) return ''
  const rest = JUDGE.slice(i)
  const j = rest.search(/\n## /)
  return j < 0 ? rest : rest.slice(0, j)
}
const present = (needle: string) =>
  assert.ok(redTeam().includes(needle), `producer missing: judge.md red-team section does not carry ${JSON.stringify(needle)}`)

test('judge.md red-team section resets to the sha at least twice (start and end)', () => {
  assert.ok(redTeam().length > 0, 'producer missing: judge.md has no red-team section')
  const n = redTeam().split(RESET).length - 1
  assert.ok(n >= 2, `producer missing: judge.md red-team section carries ${JSON.stringify(RESET)} ${n} time(s), want at least 2`)
})

for (const lit of [
  'git clean -fd',
  'git status --porcelain --untracked-files=all',
  'even when the worktrees hook tells you to commit',
  'discard',
  'temp dir',
]) {
  test(`judge.md red-team section carries ${JSON.stringify(lit)}`, () => present(lit))
}

for (const lit of ['git rev-parse --git-dir', 'git rev-parse --git-common-dir', 'git branch --show-current', 'worktree-agent-']) {
  test(`judge.md red-team section carries ${JSON.stringify(lit)}`, () => present(lit))
}

test('judge.md red-team section checks the worktree before the first reset', () => {
  const s = redTeam()
  const check = s.indexOf('git rev-parse --git-dir')
  const reset = s.indexOf(RESET)
  assert.ok(check >= 0, 'producer missing: judge.md red-team section has no "git rev-parse --git-dir"')
  assert.ok(reset >= 0 && check < reset, 'producer missing: "git rev-parse --git-dir" does not come before the first "git reset --hard <sha>"')
})

test('judge.md no longer says "git checkout --detach" anywhere', () => {
  assert.ok(JUDGE.length > 0, 'producer missing: judge.md not readable')
  assert.ok(!JUDGE.includes('git checkout --detach'), 'producer missing: judge.md still carries "git checkout --detach"')
})

const leadBullet = (): string => LEAD.split('\n').find((l: string) => l.startsWith('- **Red team, when the brief says yes.**')) ?? ''

test('lead.md red-team bullet does not say "checks out"', () => {
  assert.ok(leadBullet().length > 0, 'producer missing: lead.md has no red-team bullet')
  assert.ok(!leadBullet().includes('checks out'), 'producer missing: lead.md red-team bullet still says "checks out"')
})

test('lead.md red-team bullet carries "git reset --hard <sha>"', () => {
  assert.ok(leadBullet().includes(RESET), `producer missing: lead.md red-team bullet does not carry ${JSON.stringify(RESET)}`)
})
