// @ts-nocheck
// foundry ADR-0007 Seams 1-7: the scorer, the snippet runner and the golden set. Written before evals/*.ts exist,
// from the ADR text only. Red by design until the evals-build crew builds evals/score.ts and evals/snippets.ts.
//
// Run with: node --test plugins/foundry/tests/contract-evals.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
// Needs no model, no network and no .git/foundry run dir. Paths come from this file's location, not cwd.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { score } from '../evals/score.ts'
import { extractSnippet, parseSnippets, runSnippet } from '../evals/snippets.ts'
import { PATCH_COMMAND } from '../hooks/register.ts'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PLUGIN, '..', '..')
const ADR = readFileSync(join(PLUGIN, 'docs', 'adr', '0007-behaviour-evals.md'), 'utf8').replace(/\r/g, '')
const SCHEMA = JSON.parse(readFileSync(join(PLUGIN, 'evals', 'case.schema.json'), 'utf8'))

// ---- Seam 1: VERDICT ----
const V = (kind: string) => ({ keyword: 'VERDICT', kind })
const R = (kind: string) => ({ keyword: 'RECOMMEND', kind })
const body = '\n\n## Proof checked\nHead: x\n\n## Findings\nNone.\n'

for (const kind of ['PASS', 'FAIL']) {
  const other = kind === 'PASS' ? 'FAIL' : 'PASS'
  test(`score: VERDICT: ${kind} is ok against ${kind} and not against ${other}`, () => {
    const s = score(`VERDICT: ${kind}${body}`, V(kind))
    assert.equal(s.ok, true)
    assert.equal(s.got, kind)
    const t = score(`VERDICT: ${kind}${body}`, V(other))
    assert.equal(t.ok, false)
    assert.equal(t.got, kind)
  })
  test(`score: VERDICT: ${kind} survives a leading blank line, a BOM and CRLF`, () => {
    for (const text of [`\nVERDICT: ${kind}\nrest\n`, `﻿VERDICT: ${kind}\nrest\n`, `VERDICT: ${kind}\r\nrest\r\n`, `﻿\r\n\r\nVERDICT: ${kind}\r\nrest\r\n`]) {
      assert.deepEqual(score(text, V(kind)), { ok: true, got: kind }, JSON.stringify(text))
    }
  })
}

test('score: VERDICT:PASS with no space is got undefined and not ok against PASS (the gate rules it so)', () => {
  assert.deepEqual(score('VERDICT:PASS\nrest\n', V('PASS')), { ok: false, got: undefined })
  assert.deepEqual(score('VERDICT:FAIL\nrest\n', V('FAIL')), { ok: false, got: undefined })
})

test('score: VERDICT is read from the first non-empty line only', () => {
  assert.equal(score('Some preface\nVERDICT: PASS\n', V('PASS')).got, undefined)
  assert.equal(score('', V('PASS')).got, undefined)
})

// ---- Seam 2: RECOMMEND ----
const forms: Array<[string, string, string]> = [
  ['answer', 'RECOMMEND: answer', 'plain'],
  ['defer', 'cynic-4: RECOMMEND: defer (x2)', 'cynic-N: with count'],
  ['pass', 'cynic-1 RECOMMEND pass: because the seam is shared', 'cynic-N no colon'],
  ['answer', 'cynic-3 RECOMMEND: answer', 'cynic-N colon'],
  ['pass', 'cynic-4: RECOMMEND: pass, option (a)', 'cynic-N: with option'],
  ['defer', '  RECOMMEND: defer', 'leading spaces'],
  ['answer', 'RECOMMEND answer', 'no colon'],
]
for (const [kind, line, label] of forms) {
  test(`score: RECOMMEND ${kind} in the form ${label}`, () => {
    assert.deepEqual(score(`${line}\n`, R(kind)), { ok: true, got: kind })
    assert.deepEqual(score(`${line}\r\nmore\r\n`, R(kind)), { ok: true, got: kind })
    const wrong = ['answer', 'defer', 'pass'].find((k) => k !== kind)
    assert.deepEqual(score(`${line}\n`, R(wrong)), { ok: false, got: kind })
  })
}

test('score: RECOMMEND takes the first matching line, not only the first line', () => {
  const text = 'Reasoning first.\n\nRECOMMEND: defer\nRECOMMEND: answer\n'
  assert.deepEqual(score(text, R('defer')), { ok: true, got: 'defer' })
})

test('score: an unknown RECOMMEND kind is got undefined', () => {
  assert.deepEqual(score('RECOMMEND: drop\n', R('answer')), { ok: false, got: undefined })
  assert.equal(score('RECOMMEND:answer\n', R('answer')).got, undefined) // no whitespace after the colon: strict reading
  assert.equal(score('RECOMMEND: answerable\n', R('answer')).got, undefined) // \b after the kind
  assert.equal(score('no marker at all\n', R('pass')).got, undefined)
})

test('score: a VERDICT line is not a RECOMMEND and the reverse', () => {
  assert.equal(score('VERDICT: PASS\n', R('pass')).got, undefined)
  assert.equal(score('RECOMMEND: pass\n', V('PASS')).got, undefined)
})

test('score: a mismatched expected throws TypeError', () => {
  assert.throws(() => score('VERDICT: PASS\n', { keyword: 'VERDICT', kind: 'answer' }), TypeError)
  assert.throws(() => score('RECOMMEND: pass\n', { keyword: 'RECOMMEND', kind: 'PASS' }), TypeError)
  assert.throws(() => score('RECOMMEND: pass\n', { keyword: 'RECOMMEND', kind: 'drop' }), TypeError)
  assert.throws(() => score('x', { keyword: 'OTHER', kind: 'PASS' }), TypeError)
})

// ---- Seam 3: parseSnippets ----
test('parseSnippets: ADR-0007 yields at least the five listed lines, in order, with fills keeping their angle brackets', () => {
  const lines = parseSnippets(ADR)
  assert.ok(lines.length >= 5, `got ${lines.length}`)
  const first5 = lines.slice(0, 5)
  assert.deepEqual(first5.map((l) => [l.file, l.opening, l.form]), [
    ['plugins/foundry/agents/judge.md', 'git diff --no-color', 'fenced'],
    ['plugins/foundry/agents/lead.md', 'git diff --no-color', 'fenced'],
    ['plugins/foundry/skills/run/SKILL.md', 'git diff --no-color', 'inline'],
    ['plugins/foundry/agents/judge.md', 'git rev-parse --path-format=absolute --git-dir', 'inline'],
    ['plugins/foundry/agents/judge.md', 'git rev-parse --path-format=absolute --git-common-dir', 'inline'],
  ])
  assert.deepEqual(first5[0].fills, { '<base>': 'HEAD~1', '<head>': 'HEAD' })
  assert.deepEqual(first5[3].fills, {})
})

test('parseSnippets: reads only the ## Snippets section and skips prose', () => {
  const text = '# t\n- plugins/foundry/agents/x.md: `a` (fenced; placeholders: none)\n\n## Snippets\n\nprose line\n- plugins/foundry/agents/y.md: `b c` (inline; placeholders: <q>=1, <r-s>=two)\n## Next\n- plugins/foundry/agents/z.md: `d` (fenced; placeholders: none)\n'
  const lines = parseSnippets(text)
  assert.equal(lines.length, 1)
  assert.deepEqual(lines[0], { file: 'plugins/foundry/agents/y.md', opening: 'b c', form: 'inline', fills: { '<q>': '1', '<r-s>': 'two' } })
})

test('parseSnippets: a malformed - line throws an Error that quotes the line', () => {
  const bad = ['- plugins/foundry/agents/x.md: `a` (fenced)', '- not a snippet line', '- plugins/foundry/agents/x.md: `a` (other; placeholders: none)', '- plugins/foundry/agents/x.md: `a` (fenced; placeholders: base=HEAD)', '- plugins/foundry/agents/x.md: `a` (fenced; placeholders: <B>=1)']
  for (const line of bad) {
    assert.throws(() => parseSnippets(`## Snippets\n\n${line}\n`), (e: Error) => e instanceof Error && e.message.includes(line), line)
  }
})

// ---- Seam 4: every listed snippet is found and runs ----
const SNIPPETS = parseSnippets(ADR)
SNIPPETS.forEach((line, i) => {
  test(`snippet ${i + 1}: ${line.file} \`${line.opening}\` (${line.form}) is found, runs ok, and prints`, () => {
    const text = extractSnippet(join(ROOT, line.file), line)
    assert.equal(typeof text, 'string', 'extractSnippet found nothing: a snippet the ADR lists is missing from its prompt')
    assert.ok(text.trim().length > 0)
    const r = runSnippet(text, line.fills)
    assert.equal(r.ok, true, `exit ${r.code}: ${r.stderr}`)
    assert.equal(r.code, 0)
    if (line.form === 'fenced') assert.ok(r.stdout.split('\n').filter((l) => l.length > 0).length >= 1, 'a fenced snippet prints at least one line')
    if (line.opening === 'git diff --no-color') {
      assert.ok(text.includes('git patch-id'), 'a patch-id snippet runs git patch-id')
      const ref = runSnippet(PATCH_COMMAND, line.fills)
      assert.equal(ref.ok, true, ref.stderr)
      const id = (s: string) => s.trim().split(/\s+/)[0]
      assert.match(id(r.stdout), /^[0-9a-f]{40}$/)
      assert.equal(id(r.stdout), id(ref.stdout))
    }
  })
})

test('extractSnippet: undefined for a missing file and for a missing opening', () => {
  const line = SNIPPETS[0]
  assert.equal(extractSnippet(join(ROOT, 'plugins/foundry/agents/no-such-file.md'), line), undefined)
  assert.equal(extractSnippet(join(ROOT, line.file), { ...line, opening: 'zzz no such opening zzz' }), undefined)
})

// ---- Seam 5: runner behaviour ----
test('runSnippet: an unfilled placeholder runs nothing and names the placeholder', () => {
  const r = runSnippet('echo ran; echo <head>', {})
  assert.equal(r.ok, false)
  assert.equal(r.code, null)
  assert.ok(r.stderr.includes('<head>'), r.stderr)
  assert.equal(r.stdout, '')
  const s = runSnippet('git diff <base>...<head>', { '<base>': 'HEAD~1' })
  assert.equal(s.ok, false)
  assert.equal(s.code, null)
})

test('runSnippet: fills every occurrence, drops \\r, reports a nonzero exit', () => {
  const r = runSnippet('echo <x> <x>', { '<x>': 'hi' })
  assert.deepEqual([r.ok, r.code, r.stdout.trim()], [true, 0, 'hi hi'])
  assert.ok(!r.stdout.includes('\r'))
  const f = runSnippet('exit 3', {})
  assert.deepEqual([f.ok, f.code], [false, 3])
})

test('runSnippet: set -e and pipefail are on', () => {
  assert.equal(runSnippet('false; echo after', {}).ok, false)
  assert.equal(runSnippet('false | cat', {}).ok, false)
  assert.equal(runSnippet('echo $undefined_var_xyz', {}).ok, false) // -u
})

test('runSnippet: the temp repo has two commits, a.txt, sub/b.txt, and root is the default', () => {
  const r = runSnippet('git rev-list --count HEAD; cat a.txt; cat sub/b.txt; git diff --name-only HEAD~1 HEAD; git status --porcelain', {})
  assert.equal(r.ok, true, r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n'), ['2', 'two', 'b', 'a.txt'])
  const sub = runSnippet('basename "$(pwd)"; test -f b.txt', {}, 'subdir')
  assert.deepEqual([sub.ok, sub.stdout.trim()], [true, 'sub'])
  const wt = runSnippet('git rev-list --count HEAD; test -f a.txt', {}, 'worktree')
  assert.deepEqual([wt.ok, wt.stdout.trim()], [true, '2'])
})

test('runSnippet: inherited GIT_* variables are dropped and the caller checkout is untouched', () => {
  const saved = process.env.GIT_DIR
  process.env.GIT_DIR = join(ROOT, 'no-such-git-dir')
  try {
    const r = runSnippet('git rev-parse HEAD', {})
    assert.equal(r.ok, true, r.stderr)
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = saved
  }
  const top = runSnippet('git rev-parse --show-toplevel', {}).stdout.trim().replace(/\\/g, '/').toLowerCase()
  assert.ok(!top.startsWith(ROOT.replace(/\\/g, '/').toLowerCase()), `ran inside the caller checkout: ${top}`)
})

// ---- Seam 6: the 0.9.1 git-dir check ----
const BROKEN = '[ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]' // 897528e
const FIXED = '[ "$(git rev-parse --path-format=absolute --git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ]' // 4e43d5c
test('git-dir check: the 897528e script fails in subdir', () => {
  assert.equal(runSnippet(BROKEN, {}, 'subdir').ok, false)
})
test('git-dir check: the 897528e script passes at the root (the sanity half)', () => {
  assert.equal(runSnippet(BROKEN, {}, 'root').ok, true)
})
test('git-dir check: the 4e43d5c script passes at root and in subdir, fails in a worktree', () => {
  assert.equal(runSnippet(FIXED, {}, 'root').ok, true)
  assert.equal(runSnippet(FIXED, {}, 'subdir').ok, true)
  assert.equal(runSnippet(FIXED, {}, 'worktree').ok, false)
})
test('git-dir check: the same comparison built from judge.md spans gives the fixed results', () => {
  const [gd, gc] = SNIPPETS.filter((l) => l.file === 'plugins/foundry/agents/judge.md' && /git rev-parse --path-format=absolute --git-(dir|common-dir)$/.test(l.opening))
  assert.ok(gd && gc, 'ADR lists both git-dir spans')
  const a = extractSnippet(join(ROOT, gd.file), gd)
  const b = extractSnippet(join(ROOT, gc.file), gc)
  assert.equal(typeof a, 'string')
  assert.equal(typeof b, 'string')
  const script = `[ "$(${a})" = "$(${b})" ]`
  assert.equal(runSnippet(script, {}, 'root').ok, true)
  assert.equal(runSnippet(script, {}, 'subdir').ok, true)
  assert.equal(runSnippet(script, {}, 'worktree').ok, false)
})

// ---- Seam 7: the golden set ----
const GOLDEN = join(PLUGIN, 'evals', 'golden')
const files = existsSync(GOLDEN) ? readdirSync(GOLDEN).filter((f) => f.endsWith('.json')).sort() : []
const cases = files.map((f) => ({ file: f, data: JSON.parse(readFileSync(join(GOLDEN, f), 'utf8')) }))
const idRe = new RegExp(SCHEMA.properties.id.pattern)
const sourceRe = new RegExp(SCHEMA.properties.source.pattern)

test('golden: counts - at least 18 cases, 12 judge (4 FAIL), 6 cynic over 2 kinds', () => {
  assert.ok(cases.length >= 18, `${cases.length} cases`)
  const judge = cases.filter((c) => c.data.role === 'judge')
  const cynic = cases.filter((c) => c.data.role === 'cynic')
  assert.ok(judge.length >= 12, `${judge.length} judge`)
  assert.ok(judge.filter((c) => c.data.expected?.kind === 'FAIL').length >= 4, 'fewer than 4 FAIL judge cases')
  assert.ok(cynic.length >= 6, `${cynic.length} cynic`)
  assert.ok(new Set(cynic.map((c) => c.data.expected?.kind)).size >= 2, 'cynic cases cover fewer than 2 kinds')
})

test('golden: every case carries each key the schema requires, by hand, and no others', () => {
  assert.ok(cases.length > 0, 'no golden cases')
  for (const { file, data } of cases) {
    for (const key of SCHEMA.required) assert.ok(key in data, `${file} lacks ${key}`)
    for (const key of Object.keys(data)) assert.ok(key in SCHEMA.properties, `${file} has extra key ${key}`)
    for (const key of SCHEMA.properties.expected.required) assert.ok(key in data.expected, `${file} expected lacks ${key}`)
    assert.deepEqual(Object.keys(data.expected).sort(), ['keyword', 'kind'], file)
    assert.ok(typeof data.input === 'string' && data.input.length >= SCHEMA.properties.input.minLength, `${file} input`)
  }
})

test('golden: id equals the file name, matches the id pattern; role in the enum; source form', () => {
  assert.ok(cases.length > 0, 'no golden cases')
  for (const { file, data } of cases) {
    assert.equal(data.id, file.replace(/\.json$/, ''), file)
    assert.match(data.id, idRe, file)
    assert.ok(SCHEMA.properties.role.enum.includes(data.role), `${file} role ${data.role}`)
    assert.ok(data.source.startsWith('.git/foundry/'), `${file} source ${data.source}`)
    assert.ok(!data.source.includes('..'), `${file} source has ..`)
    assert.ok(!data.source.includes('\\'), `${file} source has a backslash`)
    assert.ok(!/^[A-Za-z]:/.test(data.source) && !data.source.startsWith('/'), `${file} source is absolute`)
    assert.match(data.source, sourceRe, file)
  }
})

test('golden: expected pairs the role with its keyword and a kind of that keyword', () => {
  assert.ok(cases.length > 0, 'no golden cases')
  for (const { file, data } of cases) {
    if (data.role === 'judge') {
      assert.equal(data.expected.keyword, 'VERDICT', file)
      assert.ok(['PASS', 'FAIL'].includes(data.expected.kind), file)
    } else {
      assert.equal(data.expected.keyword, 'RECOMMEND', file)
      assert.ok(['answer', 'defer', 'pass'].includes(data.expected.kind), file)
    }
  }
})

const REQUIRED: Array<[string, string, string, string]> = [
  ['judge-redteam-reset', 'judge', 'VERDICT', 'PASS'],
  ...[1, 2, 3, 4, 5, 6, 7].map((n): [string, string, string, string] => [`judge-roles-${n}`, 'judge', 'VERDICT', 'FAIL']),
  ['judge-foundry-protocol-1', 'judge', 'VERDICT', 'FAIL'],
  ['judge-foundry-protocol-2', 'judge', 'VERDICT', 'PASS'],
  ['cynic-answer-case-fold', 'cynic', 'RECOMMEND', 'answer'],
  ['cynic-defer-log-promise', 'cynic', 'RECOMMEND', 'defer'],
  ['cynic-pass-seam-route', 'cynic', 'RECOMMEND', 'pass'],
]
test('golden: the ADR section 3 ids exist with their role and kind, and the judge ones with the listed source', () => {
  // the table is read from the ADR so the test and the ADR cannot drift
  const rows = [...ADR.matchAll(/^\| `((?:judge|cynic)-[a-z0-9-]+)` \| (judge|cynic) \| `(\.git\/foundry\/[^`]+)`[^|]*\| `(VERDICT|RECOMMEND)` `([A-Za-z]+)` \|$/gm)]
  assert.deepEqual(rows.map((m) => [m[1], m[2], m[4], m[5]]), REQUIRED)
  const byId = new Map(cases.map((c) => [c.data.id, c.data]))
  for (const m of rows) {
    const c = byId.get(m[1])
    assert.ok(c, `missing case ${m[1]}`)
    assert.equal(c.role, m[2], m[1])
    assert.deepEqual(c.expected, { keyword: m[4], kind: m[5] }, m[1])
    if (m[2] === 'judge') assert.equal(c.source, m[3], m[1])
    else assert.ok(c.source.startsWith(m[3].replace(/decisions\.md.*/, 'decisions.md')), m[1])
  }
})

test("golden: score of each case's own expected line is ok", () => {
  assert.ok(cases.length > 0, 'no golden cases')
  for (const { file, data } of cases) {
    const { keyword, kind } = data.expected
    const line = keyword === 'VERDICT' ? `VERDICT: ${kind}\n\nrest\n` : `RECOMMEND: ${kind}\n`
    assert.deepEqual(score(line, data.expected), { ok: true, got: kind }, file)
  }
})

test('golden: no judge input line starts with VERDICT:, no cynic input contains RECOMMEND', () => {
  assert.ok(cases.length > 0, 'no golden cases')
  for (const { file, data } of cases) {
    if (data.role === 'judge') for (const l of data.input.replace(/\r/g, '').split('\n')) assert.ok(!/^\s*VERDICT:/.test(l), `${file}: ${l}`)
    else assert.ok(!data.input.includes('RECOMMEND'), `${file} input contains RECOMMEND`)
  }
})
