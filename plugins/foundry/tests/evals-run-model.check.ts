// @ts-nocheck
// foundry ADR-0007 Seam 7 (section 7): evals/run-model.ts, run as a child with CLAUDE pointing at a stub.
// Written before run-model.ts exists, from the ADR and the lead's decisions. Red by design until evals-build builds it.
//
// Run with: node --test plugins/foundry/tests/evals-run-model.check.ts
// Spawn rule pinned here: when CLAUDE ends in .js, .mjs or .cjs, run-model spawns process.execPath with the script as
// the first argument, then the claude args; else it spawns the path directly. The stub is a .mjs, so it spawns on
// Windows and Linux with no shell. The stub logs argv WITHOUT the script path (process.argv.slice(2)).
// No real model, no network. CASE_TIMEOUT_MS is a fixed 600000 constant, so the timeout path is not tested here.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PLUGIN, '..', '..')
const RUN_MODEL = join(PLUGIN, 'evals', 'run-model.ts')
const STUB = join(PLUGIN, 'tests', 'fixtures', 'claude-stub', 'claude.mjs')
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 10 })

const JUDGE_TOOLS = 'Read Grep Glob Bash(git log:*) Bash(git show:*) Bash(git diff:*) Bash(git rev-parse:*)'
const CYNIC_TOOLS = 'Read Grep Glob'

const git = (...args: string[]) => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', env, windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const HEAD = git('rev-parse', 'HEAD')
const COMMON = realpathSync.native(git('rev-parse', '--path-format=absolute', '--git-common-dir'))

function cases() {
  const dir = join(PLUGIN, 'evals', 'golden')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  const all = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return all
}

function body(role: string) {
  const text = readFileSync(join(PLUGIN, 'agents', `${role}.md`), 'utf8').replace(/\r/g, '').replace(/^﻿/, '')
  const m = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  assert.ok(m, `${role}.md has no frontmatter`)
  return m[1]
}

function tree(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      out.push(norm(p))
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}

// Runs run-model as a child. Returns the result, the stub's call logs in call order, and the results dir it printed.
function run(env: Record<string, string> = {}, args: string[] = [], opts: { claude?: string } = {}) {
  // A missing run-model.ts also exits non-zero; without this guard the refusal tests would pass for the wrong reason.
  assert.ok(existsSync(RUN_MODEL), `${RUN_MODEL} does not exist`)
  const logDir = mkdtempSync(join(tmpdir(), 'foundry-stublog-'))
  let outDir: string | undefined
  try {
    const childEnv = { ...process.env, CLAUDE: opts.claude ?? STUB, CLAUDE_STUB_LOG: logDir, ...env }
    delete childEnv.CLAUDE_STUB_REPLY
    Object.assign(childEnv, env)
    for (const k of Object.keys(childEnv)) if (k.startsWith('GIT_')) delete childEnv[k]
    const r = spawnSync(process.execPath, [RUN_MODEL, ...args], {
      cwd: ROOT, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    })
    const stdout = (r.stdout ?? '').replace(/\r/g, '')
    const m = stdout.split('\n').map((l) => l.match(/(\S*foundry-evals-[^\s"'`]*)/)).find(Boolean)
    outDir = m ? m[1] : undefined
    const calls = readdirSync(logDir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((f) => JSON.parse(readFileSync(join(logDir, f), 'utf8')))
    const results = outDir && existsSync(outDir) ? JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) : undefined
    const outFiles = outDir && existsSync(outDir) ? readdirSync(outDir) : []
    return { r, stdout, calls, outDir, results, outFiles }
  } finally {
    rm(logDir)
    if (outDir && basename(outDir).startsWith('foundry-evals-') && norm(dirname(outDir)) === norm(realpathSync.native(tmpdir()))) rm(outDir)
    else if (outDir && basename(outDir).startsWith('foundry-evals-') && existsSync(outDir)) rm(outDir)
  }
}

const LINE = /^(\S+) (ok|miss|timeout) expected=(\S+) got=(\S+)$/
function parse(stdout: string) {
  const lines = stdout.split('\n').filter((l) => l.trim())
  const rows = lines.map((l) => l.match(LINE)).filter(Boolean)
  const scoreLine = lines.map((l) => l.match(/^score (\d+)\/(\d+) at ([0-9a-f]{40})$/)).find(Boolean)
  return { rows, scoreLine }
}

test('run-model: exit 0, one line per golden case sorted by id, then a score line with HEAD sha and the case total', () => {
  const all = cases()
  assert.ok(all.length >= 1, 'no golden cases')
  const { r, stdout } = run()
  assert.equal(r.status, 0, r.stderr)
  const { rows, scoreLine } = parse(stdout)
  assert.equal(rows.length, all.length)
  assert.deepEqual(rows.map((m) => m[1]), all.map((c) => c.id))
  for (const [i, m] of rows.entries()) assert.equal(m[3], all[i].expected.kind, `expected= for ${all[i].id}`)
  assert.ok(scoreLine, `no score line in:\n${stdout}`)
  assert.equal(Number(scoreLine[2]), all.length)
  assert.equal(scoreLine[3], HEAD)
  const lines = stdout.split('\n').filter((l) => l.trim())
  assert.ok(lines.findIndex((l) => l.startsWith('score ')) > lines.findIndex((l) => LINE.test(l)), 'score line after case lines')
})

test('run-model: results follow the stub reply - PASS reply then FAIL reply flip the ok count (no always-pass scorer)', () => {
  const all = cases()
  const judges = all.filter((c) => c.role === 'judge')
  const passes = judges.filter((c) => c.expected.kind === 'PASS').length
  const fails = judges.filter((c) => c.expected.kind === 'FAIL').length
  assert.ok(passes >= 1 && fails >= 1, 'need judge PASS and FAIL cases')

  const a = run()
  assert.equal(a.r.status, 0, a.r.stderr)
  const pa = parse(a.stdout)
  for (const [i, m] of pa.rows.entries()) {
    const c = all[i]
    if (c.role === 'judge' && c.expected.kind === 'PASS') assert.deepEqual([m[2], m[4]], ['ok', 'PASS'], c.id)
    else if (c.role === 'judge') assert.deepEqual([m[2], m[4]], ['miss', 'PASS'], c.id)
    else assert.deepEqual([m[2], m[4]], ['miss', 'none'], c.id)
  }
  assert.equal(Number(pa.scoreLine[1]), passes)

  const b = run({ CLAUDE_STUB_REPLY: 'VERDICT: FAIL' })
  assert.equal(b.r.status, 0, b.r.stderr)
  const pb = parse(b.stdout)
  for (const [i, m] of pb.rows.entries()) {
    const c = all[i]
    if (c.role === 'judge') assert.deepEqual([m[2], m[4]], [c.expected.kind === 'FAIL' ? 'ok' : 'miss', 'FAIL'], c.id)
    else assert.deepEqual([m[2], m[4]], ['miss', 'none'], c.id)
  }
  assert.equal(Number(pb.scoreLine[1]), fails)
})

test('run-model: a reply with a preamble before the VERDICT line scores got=none for judges (stdout is scored as a whole)', () => {
  const { r, stdout } = run({ CLAUDE_STUB_REPLY: 'thinking out loud\nVERDICT: PASS\n' })
  assert.equal(r.status, 0, r.stderr)
  const { rows, scoreLine } = parse(stdout)
  assert.ok(rows.length >= 1)
  for (const m of rows) assert.deepEqual([m[2], m[4]], ['miss', 'none'], m[1])
  assert.equal(Number(scoreLine[1]), 0)
})

test('run-model: one claude call per case, with the flags, role prompt, tool list, stdin and cwd the ADR fixes', () => {
  const all = cases()
  const { r, calls } = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(calls.length, all.length, 'one call per case')
  const roleBody = { judge: body('judge').trim(), cynic: body('cynic').trim() }
  for (const [i, c] of all.entries()) {
    const { argv, stdin, cwd } = calls[i]
    const val = (flag: string) => {
      const at = argv.indexOf(flag)
      assert.ok(at >= 0, `${c.id}: missing ${flag} in ${JSON.stringify(argv).slice(0, 300)}`)
      return argv[at + 1]
    }
    assert.ok(argv.includes('-p'), `${c.id}: -p`)
    assert.ok(argv.includes('--no-session-persistence'), `${c.id}: --no-session-persistence`)
    assert.equal(val('--output-format'), 'text')
    assert.equal(val('--model'), 'opus')
    assert.equal(val('--effort'), 'medium')
    assert.equal(val('--system-prompt').replace(/\r/g, '').trim(), roleBody[c.role], `${c.id}: system prompt`)
    // --allowedTools: read the separate arguments after the flag up to the next `--` flag, joined by one space.
    // A single space-joined argument gives the same string, so both layouts pass.
    const at = argv.indexOf('--allowedTools')
    assert.ok(at >= 0, `${c.id}: --allowedTools`)
    const tools: string[] = []
    for (let j = at + 1; j < argv.length && !argv[j].startsWith('--'); j++) tools.push(argv[j])
    assert.equal(tools.join(' '), c.role === 'judge' ? JUDGE_TOOLS : CYNIC_TOOLS, `${c.id}: tools`)
    for (const bad of ['Write', 'Edit', 'NotebookEdit']) assert.ok(!tools.join(' ').includes(bad), `${c.id}: ${bad}`)
    assert.ok(!argv.includes('--max-budget-usd'), 'no budget flag')
    assert.equal(stdin, c.input, `${c.id}: stdin is the case input`)
    assert.equal(norm(realpathSync.native(cwd)), norm(realpathSync.native(ROOT)), `${c.id}: cwd`)
  }
})

test('run-model: prints a foundry-evals-* tmpdir holding results.json and one raw report per case; nothing written in the checkout', () => {
  const all = cases()
  const statusBefore = git('status', '--porcelain')
  const foundryBefore = tree(join(COMMON, 'foundry'))
  const claudeBefore = tree(join(ROOT, '.claude'))
  const { r, outDir, results, outFiles } = run()
  assert.equal(r.status, 0, r.stderr)
  assert.ok(outDir, 'no foundry-evals-* path printed')
  assert.ok(basename(outDir).startsWith('foundry-evals-'))
  assert.equal(norm(realpathSync.native(dirname(outDir))), norm(realpathSync.native(tmpdir())), 'under os.tmpdir()')
  assert.ok(Array.isArray(results) || (results && typeof results === 'object'), 'results.json parses')
  const entries = Array.isArray(results) ? results : Object.values(results.cases ?? results)
  assert.equal(entries.length, all.length, 'one results entry per case')
  const raw = outFiles.filter((f) => f !== 'results.json')
  assert.equal(raw.length, all.length, `one raw report per case, got ${raw.join(',')}`)
  assert.equal(git('status', '--porcelain'), statusBefore, 'checkout status changed')
  assert.deepEqual(tree(join(COMMON, 'foundry')), foundryBefore, '.git/foundry changed')
  assert.deepEqual(tree(join(ROOT, '.claude')), claudeBefore, '.claude changed')
})

test('run-model: takes no flag that picks cases - an extra --case argument exits non-zero', () => {
  const { r, stdout } = run({}, ['--case', 'judge-roles-1'])
  assert.notEqual(r.status, 0, `exit 0 with output:\n${stdout}`)
  assert.equal(parse(stdout).scoreLine, undefined, 'no score line when the flag is refused')
})

test('run-model: a missing binary never prints a score with a passing case', () => {
  const missing = join(tmpdir(), `foundry-no-such-claude-${process.pid}`, 'claude')
  for (const claude of [missing, `${missing}.mjs`]) {
    const { r, stdout } = run({}, [], { claude })
    const { rows, scoreLine } = parse(stdout)
    if (r.status === 0 && scoreLine) assert.equal(Number(scoreLine[1]), 0, `${claude}: ${scoreLine[0]}`)
    for (const m of rows) assert.notEqual(m[2], 'ok', `${claude}: ${m[0]}`)
    assert.ok(r.status !== 0 || rows.length > 0, 'a silent exit 0 is no answer')
  }
})
