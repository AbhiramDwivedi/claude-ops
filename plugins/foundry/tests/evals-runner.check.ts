// @ts-nocheck
// foundry ADR-0007 Seams 4-5, anti-fake checks the contract test (contract-evals.check.ts) does not make: the snippet
// runner really executes, cleans up and stays out of the caller's checkout; the scorer reads only the first line.
// Written before evals/*.ts exist. Red by design until the evals-build crew builds score.ts and snippets.ts.
//
// Run with: node --test plugins/foundry/tests/evals-runner.check.ts
// Needs bash and git, no model, no network. Paths come from this file's location, not cwd.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { score } from '../evals/score.ts'
import { runSnippet } from '../evals/snippets.ts'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PLUGIN, '..', '..')
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const token = () => randomBytes(8).toString('hex')
const snippetDirs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('foundry-snippet-')))

// Other test files run in parallel and may hold a foundry-snippet-* dir for a moment, so a leak is a new dir that is
// still there after a grace period, not one seen at an instant.
function waitGone(extra: Set<string>, ms = 10000) {
  const end = Date.now() + ms
  let left = [...extra].filter((n) => existsSync(join(tmpdir(), n)))
  while (left.length && Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    left = left.filter((n) => existsSync(join(tmpdir(), n)))
  }
  return left
}

// ---- Seam 5: runSnippet cleans up ----
test('runSnippet: removes its foundry-snippet-* temp dir after ok, failing, unfilled and worktree runs', () => {
  const before = snippetDirs()
  const a = runSnippet('echo hi')
  const b = runSnippet('exit 3')
  const c = runSnippet('echo <not-filled>', {})
  const d = runSnippet('echo hi', {}, 'worktree')
  const e = runSnippet('echo hi', {}, 'subdir')
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.code, 3)
  assert.equal(c.ok, false)
  assert.equal(c.code, null)
  assert.equal(d.ok, true)
  assert.equal(e.ok, true)
  const fresh = new Set([...snippetDirs()].filter((n) => !before.has(n)))
  const leaked = waitGone(fresh)
  assert.deepEqual(leaked, [], `leaked temp dirs: ${leaked.join(', ')}`)
})

// ---- Seam 5: runSnippet really executes ----
test('runSnippet: a script that prints a random token gives the token back on stdout', () => {
  const t = token()
  const r = runSnippet(`echo ${t}`)
  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), t)
})

test('runSnippet: the fixture repo has a.txt at root (test -f a.txt)', () => {
  const r = runSnippet('test -f a.txt && echo yes')
  assert.equal(r.ok, true)
  assert.equal(r.stdout.trim(), 'yes')
  const sub = runSnippet('test -f a.txt && echo yes', {}, 'subdir')
  assert.equal(sub.ok, false, 'subdir has no a.txt of its own')
})

test('runSnippet: fills are substituted before the script runs, placeholder text never reaches the shell', () => {
  const t = token()
  const r = runSnippet('echo <thing>-<thing>', { '<thing>': t })
  assert.equal(r.stdout.trim(), `${t}-${t}`)
})

test('runSnippet: the worktree toplevel differs from the root toplevel, and neither is the caller checkout', () => {
  const root = runSnippet('git rev-parse --show-toplevel', {}, 'root')
  const wt = runSnippet('git rev-parse --show-toplevel', {}, 'worktree')
  assert.equal(root.ok, true)
  assert.equal(wt.ok, true)
  assert.notEqual(norm(root.stdout.trim()), norm(wt.stdout.trim()))
  assert.ok(norm(wt.stdout.trim()).endsWith('/wt'), `worktree toplevel ${wt.stdout.trim()}`)
  const realRoot = norm(realpathSync.native(ROOT))
  assert.notEqual(norm(root.stdout.trim()), realRoot)
  assert.notEqual(norm(wt.stdout.trim()), realRoot)
})

test('runSnippet: a failure inside a pipe fails the script (pipefail), and an unset variable fails it (set -u)', () => {
  assert.equal(runSnippet('false | cat').ok, false)
  assert.equal(runSnippet('echo "$FOUNDRY_NOT_SET_' + token() + '"').ok, false)
})

test('runSnippet: stdout and stderr come back with CR dropped', () => {
  const r = runSnippet("printf 'a\\r\\nb\\r\\n'; printf 'e\\r\\n' >&2")
  assert.equal(r.stdout.includes('\r'), false)
  assert.equal(r.stderr.includes('\r'), false)
  assert.equal(r.stdout, 'a\nb\n')
})

// ---- Seam 5: runSnippet never touches the caller's checkout ----
test('runSnippet: a snippet that creates a canary file leaves the caller checkout and cwd untouched', () => {
  const name = `canary-${token()}.txt`
  for (const where of ['root', 'subdir', 'worktree']) {
    const r = runSnippet(`touch ${name} && echo made`, {}, where as any)
    assert.equal(r.ok, true, `${where}: ${r.stderr}`)
  }
  assert.equal(existsSync(join(ROOT, name)), false, 'canary in the repo root')
  assert.equal(existsSync(join(process.cwd(), name)), false, 'canary in cwd')
  assert.equal(existsSync(join(PLUGIN, name)), false, 'canary in the plugin dir')
})

test('runSnippet: drops GIT_* variables from the caller environment', () => {
  process.env.GIT_DIR = join(ROOT, '.git')
  process.env.GIT_WORK_TREE = ROOT
  try {
    const r = runSnippet('git rev-parse --show-toplevel')
    assert.equal(r.ok, true, r.stderr)
    assert.notEqual(norm(r.stdout.trim()), norm(realpathSync.native(ROOT)))
  } finally {
    delete process.env.GIT_DIR
    delete process.env.GIT_WORK_TREE
  }
})

// ---- Seam 1-2: score reads only what the ADR says (seams 1 and 2 of contract-evals pin the basics) ----
const V = (kind: string) => ({ keyword: 'VERDICT', kind })
const R = (kind: string) => ({ keyword: 'RECOMMEND', kind })

test('score VERDICT: a VERDICT line that is not the first non-empty line gives got undefined', () => {
  for (const report of ['Some preamble\nVERDICT: PASS\n', '## Heading\n\nVERDICT: FAIL\n', 'x\n\n\nVERDICT: PASS']) {
    assert.deepEqual(score(report, V('PASS')), { ok: false, got: undefined }, report)
    assert.deepEqual(score(report, V('FAIL')), { ok: false, got: undefined }, report)
  }
})

test('score: a RECOMMEND line inside a VERDICT report does not score as a VERDICT, and the reverse', () => {
  assert.deepEqual(score('RECOMMEND: answer\nVERDICT: PASS\n', V('PASS')), { ok: false, got: undefined })
  assert.deepEqual(score('VERDICT: PASS\n', R('pass')), { ok: false, got: undefined })
  assert.deepEqual(score('VERDICT: FAIL\n\nreason\n', R('answer')), { ok: false, got: undefined })
  // The keywords pick independent readings of one report.
  const both = 'VERDICT: PASS\n\nRECOMMEND: defer\n'
  assert.deepEqual(score(both, V('PASS')), { ok: true, got: 'PASS' })
  assert.deepEqual(score(both, R('defer')), { ok: true, got: 'defer' })
  assert.deepEqual(score(both, R('pass')), { ok: false, got: 'defer' })
})

test('score: is pure - the same input twice gives equal results, and different inputs give different results', () => {
  const report = 'VERDICT: PASS\n\nbody\n'
  const first = score(report, V('PASS'))
  const second = score(report, V('PASS'))
  assert.deepEqual(first, second)
  assert.notEqual(first, second, 'a fresh object each call, no shared mutable result')
  assert.equal(score(report, V('PASS')).ok, true)
  assert.equal(score(report, V('FAIL')).ok, false)
  assert.equal(score('VERDICT: FAIL\n', V('FAIL')).ok, true)
  assert.equal(score('VERDICT: FAIL\n', V('PASS')).ok, false)
  assert.equal(score('', V('PASS')).got, undefined)
})
