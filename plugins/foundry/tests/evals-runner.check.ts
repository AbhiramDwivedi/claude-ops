// @ts-nocheck
// foundry ADR-0007 Seams 4-5, anti-fake checks the contract test (contract-evals.check.ts) does not make: the snippet
// runner really executes, cleans up and stays out of the caller's checkout; the scorer reads only the first line.
// Written before evals/*.ts exist. Red by design until the evals-build crew builds score.ts and snippets.ts.
//
// Run with: node --test plugins/foundry/tests/evals-runner.check.ts
// Needs bash and git, no model, no network. Paths come from this file's location, not cwd.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { score } from '../evals/score.ts'
import { extractSnippet, runSnippet } from '../evals/snippets.ts'
import { judgeRuling } from '../hooks/register.ts'

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
  const a = runSnippet('echo hi', {})
  const b = runSnippet('exit 3', {})
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
  const r = runSnippet(`echo ${t}`, {})
  assert.equal(r.ok, true)
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), t)
})

test('runSnippet: the fixture repo has a.txt at root (test -f a.txt)', () => {
  const r = runSnippet('test -f a.txt && echo yes', {})
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
  assert.equal(runSnippet('false | cat', {}).ok, false)
  assert.equal(runSnippet('echo "$FOUNDRY_NOT_SET_' + token() + '"', {}).ok, false)
})

test('runSnippet: stdout and stderr come back with CR dropped', () => {
  const r = runSnippet("printf 'a\\r\\nb\\r\\n'; printf 'e\\r\\n' >&2", {})
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

test('runSnippet: drops every GIT_* variable from the caller environment and never touches the repo they point at', () => {
  // Every injected path is inside a throwaway dir. Never point GIT_* at ROOT or any real repo.
  const tmp = mkdtempSync(join(tmpdir(), 'foundry-gitenv-'))
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME']
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]
  const cleaned: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) cleaned[k] = v
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: cleaned, stdio: 'pipe', windowsHide: true }).toString()
  try {
    git(tmp, 'init', '-q')
    const before = git(ROOT, 'status', '--porcelain')
    process.env.GIT_DIR = join(tmp, '.git')
    process.env.GIT_WORK_TREE = tmp
    process.env.GIT_INDEX_FILE = join(tmp, '.git', 'fake-index')
    process.env.GIT_OBJECT_DIRECTORY = join(tmp, 'fake-objects')
    process.env.GIT_CONFIG_GLOBAL = join(tmp, 'fake-gitconfig')
    process.env.GIT_AUTHOR_NAME = 'leaky-author'
    const probe = keys.map((k) => `echo "${k}=\${${k}-unset}"`).join('; ')
    const r = runSnippet(`${probe}; git rev-parse --show-toplevel`, {})
    assert.equal(r.ok, true, r.stderr)
    const lines = r.stdout.trim().split('\n')
    for (const k of keys) assert.ok(lines.includes(`${k}=unset`), `${k} leaked into the snippet: ${r.stdout}`)
    const top = norm(lines[lines.length - 1])
    assert.notEqual(top, norm(realpathSync.native(tmp)))
    assert.notEqual(top, norm(realpathSync.native(ROOT)))
    // The throwaway repo the variables pointed at stays untouched.
    assert.equal(git(tmp, 'rev-list', '--all').trim(), '', 'a commit landed in the throwaway repo')
    const cfg = spawnSync('git', ['config', '--local', 'user.name'], { cwd: tmp, env: cleaned, windowsHide: true })
    assert.equal(cfg.stdout.toString().trim(), '', 'user.name written to the throwaway repo config')
    assert.equal(existsSync(join(tmp, 'a.txt')), false, 'fixture file written into the throwaway work tree')
    assert.equal(git(ROOT, 'status', '--porcelain'), before, 'the real checkout status changed')
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(tmp, { recursive: true, force: true })
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

test('score VERDICT: keyword and kind are case-sensitive', () => {
  assert.equal(score('verdict: pass\n', V('PASS')).got, undefined)
  assert.equal(score('Verdict: FAIL\n', V('FAIL')).got, undefined)
  assert.equal(score('VERDICT: pass\n', V('PASS')).got, undefined)
})

test('score RECOMMEND: the keyword is case-sensitive', () => {
  assert.equal(score('recommend: answer\n', R('answer')).got, undefined)
  assert.equal(score('Recommend: defer\n', R('defer')).got, undefined)
})

test('score RECOMMEND: the line must start with RECOMMEND or a cynic-N prefix', () => {
  assert.equal(score('I would not RECOMMEND pass here\n', R('pass')).got, undefined)
  assert.equal(score('note: cynic-2 RECOMMEND: defer\n', R('defer')).got, undefined)
  assert.deepEqual(score('cynic-2: RECOMMEND: defer\n', R('defer')), { ok: true, got: 'defer' })
  assert.deepEqual(score('  RECOMMEND answer\n', R('answer')), { ok: true, got: 'answer' })
})

// ---- ADR-0007 section 5: the 30-second bash timeout (source check: a live 30 s test is too slow) ----
test('runSnippet (source check): the bash spawn carries timeout: 30_000', () => {
  const text = readFileSync(join(PLUGIN, 'evals', 'snippets.ts'), 'utf8')
  const chunk = text.split('spawnSync(').slice(1).find((c) => c.includes("'bash'"))
  assert.ok(chunk, 'no spawnSync call running bash')
  const opts = chunk.slice(0, chunk.indexOf('})'))
  assert.match(opts, /timeout:\s*(30_000|30000)\b/, 'the bash spawn has no 30-second timeout')
})

// ---- ADR-0007 section 5: extractSnippet rules ----
function withPrompt(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-extract-'))
  try {
    const p = join(dir, 'prompt.md')
    writeFileSync(p, content)
    fn(p)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  }
}
const line = (opening: string, form: 'fenced' | 'inline') => ({ file: 'x.md', opening, form, fills: {} })

test('extractSnippet: drops a BOM (and every CR), so a BOM-prefixed fence still opens at line 0', () => {
  withPrompt('﻿```\r\ngit foo\r\nsecond\r\n```\r\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'fenced')), 'git foo\nsecond')
  })
  withPrompt('﻿`git foo` then text\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'inline')), 'git foo')
  })
  // JS trimStart() also strips a BOM, so behaviour alone cannot tell a dropped BOM from a kept one; the source must say it.
  const text = readFileSync(join(PLUGIN, 'evals', 'snippets.ts'), 'utf8')
  assert.ok(/\\uFEFF|﻿/.test(text), 'snippets.ts never removes a BOM')
})

test('extractSnippet fenced: a fence line with leading spaces opens and closes a fence', () => {
  withPrompt('text\n   ```\n   git foo\n  more\n   ```\nafter\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'fenced')), '   git foo\n  more')
  })
  // An indented closing fence must close it, or the body would run on to the next fence.
  withPrompt('```\ngit foo\n   ```\nprose\n```\ngit foo trailing\n```\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'fenced')), 'git foo')
  })
})

test('extractSnippet fenced: the opening must start the FIRST body line, leading spaces dropped', () => {
  withPrompt('```\necho hi\ngit foo bar\n```\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'fenced')), undefined, 'a later body line must not match')
  })
  withPrompt('```\necho hi\ngit foo bar\n```\n\n```\n    git foo baz\nline2\n```\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'fenced')), '    git foo baz\nline2', 'first fence whose first line matches')
  })
  withPrompt('```\nxgit foo\n```\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'fenced')), undefined, 'opening is a prefix match, not a substring')
  })
})

test('extractSnippet inline: spans inside fence bodies are skipped; the first span outside wins', () => {
  withPrompt('```\nrun `git foo inside`\n```\nSee `git foo outside` and `git foo second`.\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'inline')), 'git foo outside')
  })
  withPrompt('```\n`git foo inside`\n```\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'inline')), undefined, 'only a fenced span exists')
  })
  // An indented fence still hides its body.
  withPrompt('  ```\n`git foo hidden`\n  ```\n', (p) => {
    assert.equal(extractSnippet(p, line('git foo', 'inline')), undefined)
  })
})

test('extractSnippet: an unreadable file gives undefined', () => {
  assert.equal(extractSnippet(join(tmpdir(), 'foundry-no-such-prompt-' + token() + '.md'), line('x', 'fenced')), undefined)
})

// ---- ADR-0007 section 4: score rules a VERDICT exactly as the merge gate does ----
test('score VERDICT: agrees with judgeRuling from the gate (hooks/register.ts) on text the gate and a bare regex rule differently', () => {
  for (const text of ['  VERDICT: PASS\n', '\n\nVERDICT: FAIL\n', 'VERDICT:  PASS\n', 'VERDICT: PASS   \n', '﻿VERDICT: PASS\n']) {
    const gate = judgeRuling(text).verdict
    for (const kind of ['PASS', 'FAIL']) {
      assert.deepEqual(score(text, V(kind)), { ok: gate === kind, got: gate }, JSON.stringify(text) + ' expecting ' + kind)
    }
  }
  assert.equal(judgeRuling('  VERDICT: PASS\n').verdict, 'PASS', 'premise: the gate rules indented VERDICT lines')
  assert.deepEqual(score('  VERDICT: PASS\n', V('PASS')), { ok: true, got: 'PASS' })
})
