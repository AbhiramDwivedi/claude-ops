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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// Every `--` flag run-model may pass, plus `-p`. Mirrors ADR-0007 section 7, with `--tools` and `--disallowedTools`
// added on the lead's word. Anything else on the command line (a permission mode) fails the argv test.
const ALLOWED_FLAGS = ['--system-prompt', '--model', '--effort', '--no-session-persistence', '--output-format', '--allowedTools',
  '--tools', '--disallowedTools']
const ONE_VALUE = ['--system-prompt', '--model', '--effort', '--output-format']

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
function run(env: Record<string, string> = {}, args: string[] = [], opts: { claude?: string; cwd?: string; runModel?: string } = {}) {
  // A missing run-model.ts also exits non-zero; without this guard the refusal tests would pass for the wrong reason.
  const runModel = opts.runModel ?? RUN_MODEL
  assert.ok(existsSync(runModel), `${runModel} does not exist`)
  const logDir = mkdtempSync(join(tmpdir(), 'foundry-stublog-'))
  let outDir: string | undefined
  try {
    const childEnv = { ...process.env, CLAUDE: opts.claude ?? STUB, CLAUDE_STUB_LOG: logDir, ...env }
    delete childEnv.CLAUDE_STUB_REPLY
    Object.assign(childEnv, env)
    for (const k of Object.keys(childEnv)) if (k.startsWith('GIT_')) delete childEnv[k]
    const r = spawnSync(process.execPath, [runModel, ...args], {
      cwd: opts.cwd ?? ROOT, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024,
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
    const raw: Record<string, string> = {}
    for (const f of outFiles) raw[f] = readFileSync(join(outDir, f), 'utf8')
    return { r, stdout, calls, outDir, results, outFiles, raw }
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
  const status = () =>
    [['--porcelain'], ['--porcelain', '--ignored']].map((f) =>
      git('status', ...f).split('\n').filter((l) => !l.includes('.claude/worktrees/')).join('\n'))
  const statusBefore = status()
  const foundryBefore = new Set(tree(join(COMMON, 'foundry')))
  const claudeBefore = new Set(tree(join(ROOT, '.claude')))
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
  assert.deepEqual(status(), statusBefore, 'checkout status (plain or --ignored) changed')
  // Live foundry runs write under .git/foundry and .claude/worktrees while this test runs, so the trees are not
  // compared whole. No path NEW since before may look like run-model output: results.json, a golden case id as a
  // basename stem, or foundry-evals.
  const ids = new Set(all.map((c) => c.id))
  const looksLikeOutput = (p: string) => {
    const base = p.split('/').pop() as string
    return base === 'results.json' || p.includes('foundry-evals') || ids.has(base.replace(/\.[^.]*$/, ''))
  }
  for (const [label, before, after] of [
    ['.git/foundry', foundryBefore, tree(join(COMMON, 'foundry'))],
    ['.claude', claudeBefore, tree(join(ROOT, '.claude'))],
  ] as const) {
    const bad = after.filter((p) => !before.has(p) && looksLikeOutput(p))
    assert.deepEqual(bad, [], `run-model wrote under ${label}`)
  }
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

// ---- Red-team gap tests ----

// Splits one logged argv into flag -> value tokens. Fails on any token that is not -p, an allowed flag or a value.
function parseArgv(argv: string[], id: string) {
  const flags: Record<string, string[]> = {}
  let cur: string | undefined
  for (const t of argv) {
    if (t === '-p') { cur = undefined; continue }
    if (t.startsWith('-')) {
      assert.ok(ALLOWED_FLAGS.includes(t), `${id}: flag ${t} is not in the allowed set`)
      flags[t] = []
      cur = t
      continue
    }
    assert.ok(cur, `${id}: stray argument ${JSON.stringify(t).slice(0, 80)}`)
    flags[cur].push(t)
    if (ONE_VALUE.includes(cur)) cur = undefined
  }
  return flags
}

test('run-model: argv carries only the allowed flags (no --permission-mode, no write tool via --tools)', () => {
  const { r, calls } = run()
  assert.equal(r.status, 0, r.stderr)
  assert.ok(calls.length >= 1)
  for (const [i, { argv }] of calls.entries()) {
    const flags = parseArgv(argv, `call ${i + 1}`)
    for (const f of ['--tools', '--allowedTools']) {
      const v = (flags[f] ?? []).join(' ')
      for (const bad of ['Write', 'Edit', 'NotebookEdit']) assert.ok(!v.includes(bad), `call ${i + 1}: ${f} has ${bad}`)
    }
  }
})

test('run-model: --tools and --disallowedTools carry the exact values (judge: Read Grep Glob Bash; cynic: Read Grep Glob)', () => {
  const all = cases()
  const { r, calls } = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(calls.length, all.length)
  const DISALLOWED = ['Bash(git diff --output*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)']
  for (const [i, c] of all.entries()) {
    const flags = parseArgv(calls[i].argv, c.id)
    assert.deepEqual(flags['--tools'], c.role === 'judge' ? ['Read', 'Grep', 'Glob', 'Bash'] : ['Read', 'Grep', 'Glob'], `${c.id}: --tools`)
    assert.deepEqual(flags['--disallowedTools'], DISALLOWED, `${c.id}: --disallowedTools`)
    assert.equal(flags['--allowedTools'].join(' '), c.role === 'judge' ? JUDGE_TOOLS : CYNIC_TOOLS, `${c.id}: --allowedTools`)
  }
})

// Snapshot of <root>/.claude: path -> kind. Skips the contents of subdirs of .claude/worktrees (live agent worktrees).
function claudeSnap(root: string) {
  const out = new Map<string, string>()
  const base = join(root, '.claude')
  const wt = norm(join(base, 'worktrees'))
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const key = norm(p)
      if (norm(d) === wt) {
        out.set(key, e.isDirectory() ? (existsSync(join(p, '.git')) ? 'dir+git' : 'dir') : 'file')
        continue
      }
      out.set(key, e.isDirectory() ? 'dir' : 'file')
      if (e.isDirectory()) walk(p)
    }
  }
  walk(base)
  return out
}

const CLAUDE_BASE = claudeSnap(ROOT)
const COMMON_BASE = new Set(readdirSync(COMMON))

test('run-model: writes nothing under .claude (worktrees excepted) and no run output in the git common dir', () => {
  const all = cases()
  // Baselines come from module load, before any run in this file: an earlier test's run must not hide a leak.
  const before = CLAUDE_BASE
  const commonBefore = COMMON_BASE
  const { r } = run()
  assert.equal(r.status, 0, r.stderr)
  const wt = norm(join(ROOT, '.claude', 'worktrees'))
  const bad: string[] = []
  for (const [p, kind] of claudeSnap(ROOT)) {
    if (before.has(p)) continue
    if (p === wt) continue
    if (!p.startsWith(`${wt}/`)) bad.push(`${p} (${kind})`)
    else if (kind !== 'dir+git') bad.push(`${p} (${kind})`)
  }
  assert.deepEqual(bad, [], 'new paths under .claude')
  const ids = all.map((c) => c.id)
  const leaked = readdirSync(COMMON).filter(
    (n) => !commonBefore.has(n) && (n.includes('foundry-evals') || n.includes('results') || ids.some((id) => n.includes(id))))
  assert.deepEqual(leaked, [], 'new run output in the git common dir')
})

test('run-model (source check): the only environment variable it reads by name is CLAUDE (a bare process.env passed whole is allowed)', () => {
  // ADR-0007 section 7: "It takes no flag that picks or adds cases." A behavioural test can only try names it guesses;
  // a source check closes the door on every name.
  const text = readFileSync(RUN_MODEL, 'utf8')
  const reads = [...text.matchAll(/process\.env(\s*\.\s*(\w+)|\s*\?\.\s*(\w+)|\s*\[\s*(['"`])([^'"`]*)\4\s*\]|\s*\[[^\]]*\])?/g)]
  const named = reads.filter((m) => m[1] !== undefined)
  assert.ok(named.some((m) => (m[2] ?? m[3] ?? m[5]) === 'CLAUDE'), 'run-model no longer reads process.env.CLAUDE')
  for (const m of named) {
    const key = m[2] ?? m[3] ?? m[5]
    assert.equal(key, 'CLAUDE', `run-model reads process.env${m[1]}; only CLAUDE may be read by name`)
  }
})

test('run-model (source check): a timed-out child is detected by ETIMEDOUT and scored with the timeout label', () => {
  // A live 600 s run is too slow, and no override of the timeout is allowed, so there is no behavioural test here.
  // (A red team proved the real path with a patched copy in tmp at 1.5 s.) A dead branch must turn this red.
  const text = readFileSync(RUN_MODEL, 'utf8')
  assert.match(text, /code\s*===\s*['"]ETIMEDOUT['"]/, 'no ETIMEDOUT comparison on the spawn error')
  assert.match(text, /['"]timeout['"]/, "no 'timeout' result label")
  assert.ok(!/(?:const|let)\s+timedOut\s*=\s*(?:false|true)\b/.test(text), 'timedOut is a constant')
  assert.match(text, /timedOut\s*\?\s*['"]timeout['"]/, 'a timed-out case is not given the timeout label')
})

test('run-model: each raw report is the child stdout, and each results.json entry matches that case\'s printed line', () => {
  const reply = 'VERDICT: FAIL\n\nunique-reply-' + Date.now() + '-xq7\n'
  const { r, stdout, results, raw } = run({ CLAUDE_STUB_REPLY: reply })
  assert.equal(r.status, 0, r.stderr)
  const all = cases()
  const { rows } = parse(stdout)
  assert.equal(rows.length, all.length)
  const entries = Array.isArray(results) ? results : Object.values(results.cases ?? results)
  assert.equal(entries.length, all.length)
  for (const c of all) {
    assert.ok(raw[`${c.id}.txt`] !== undefined, `${c.id}.txt missing`)
    assert.equal(raw[`${c.id}.txt`].replace(/\r/g, '').trimEnd(), reply.trimEnd(), `${c.id}.txt is not the child's reply`)
  }
  for (const m of rows) {
    const e = entries.find((x) => x.id === m[1])
    assert.ok(e, `no results entry for ${m[1]}`)
    assert.equal(e.result, m[2], `${m[1]} result`)
    assert.equal(e.expected, m[3], `${m[1]} expected`)
    assert.equal(e.got, m[4], `${m[1]} got`)
  }
  // The reply must really split the cases, or an always-ok results.json would agree with the printed lines.
  assert.ok(rows.some((m) => m[2] === 'ok'), 'premise: some case scores ok on VERDICT: FAIL')
  assert.ok(rows.some((m) => m[2] === 'miss'), 'premise: some case scores miss on VERDICT: FAIL')
})

test('run-model: honours no environment variable that filters cases', () => {
  const all = cases()
  const filt = Object.fromEntries(['EVAL_ONLY', 'EVALS_CASE', 'CASE', 'FOUNDRY_EVAL_CASES', 'ONLY'].map((k) => [k, 'judge-roles-1']))
  const { r, stdout, calls } = run(filt)
  assert.equal(r.status, 0, r.stderr)
  const { rows, scoreLine } = parse(stdout)
  assert.deepEqual(rows.map((m) => m[1]), all.map((c) => c.id))
  assert.equal(calls.length, all.length)
  assert.equal(Number(scoreLine?.[2]), all.length)
})

test('run-model: model and effort come from each agent frontmatter, not a constant', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'foundry-copy-'))
  try {
    const base = join(tmp, 'plugins', 'foundry')
    mkdirSync(join(base, 'hooks'), { recursive: true })
    mkdirSync(join(base, 'agents'), { recursive: true })
    cpSync(join(PLUGIN, 'evals'), join(base, 'evals'), { recursive: true })
    cpSync(join(PLUGIN, 'hooks', 'register.ts'), join(base, 'hooks', 'register.ts'))
    for (const a of ['judge', 'cynic']) cpSync(join(PLUGIN, 'agents', `${a}.md`), join(base, 'agents', `${a}.md`))
    const jp = join(base, 'agents', 'judge.md')
    writeFileSync(jp, readFileSync(jp, 'utf8').replace(/^model:.*$/m, 'model: sonnet').replace(/^effort:.*$/m, 'effort: low'))
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
    for (const args of [['init', '-q'], ['config', 'user.name', 'copy'], ['config', 'user.email', 'copy@example.invalid'],
      ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'copy']]) {
      const g = spawnSync('git', args, { cwd: tmp, env, encoding: 'utf8', windowsHide: true })
      assert.equal(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`)
    }
    const all = cases()
    const { r, calls } = run({}, [], { runModel: join(base, 'evals', 'run-model.ts'), cwd: tmp })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, all.length)
    for (const [i, c] of all.entries()) {
      const { argv } = calls[i]
      const val = (f: string) => argv[argv.indexOf(f) + 1]
      assert.equal(val('--model'), c.role === 'judge' ? 'sonnet' : 'opus', `${c.id}: model`)
      assert.equal(val('--effort'), c.role === 'judge' ? 'low' : 'medium', `${c.id}: effort`)
    }
  } finally {
    rm(tmp)
  }
})

test('run-model (source check): the per-case timeout is CASE_TIMEOUT_MS = 600000 and reaches the case spawn', () => {
  // A source check because a live 600-second test is too slow and no override of the timeout is allowed.
  const text = readFileSync(RUN_MODEL, 'utf8')
  assert.ok(text.includes('CASE_TIMEOUT_MS = 600000'), 'CASE_TIMEOUT_MS = 600000')
  const chunk = text.split('spawnSync(').slice(1).find((c) => c.includes('input: c.input'))
  assert.ok(chunk, 'no spawnSync call passing the case input')
  assert.ok(chunk.includes('timeout: CASE_TIMEOUT_MS'), 'timeout: CASE_TIMEOUT_MS missing from the case spawn')
})

test('run-model: runs claude in the repo root even when started from a subdirectory', () => {
  const { r, calls } = run({}, [], { cwd: PLUGIN })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(calls.length >= 1)
  for (const c of calls) assert.equal(norm(realpathSync.native(c.cwd)), norm(realpathSync.native(ROOT)))
})

test('run-model: a child that exits non-zero with no stdout scores miss got=none, forwards its stderr and exits non-zero', () => {
  const all = cases()
  const { r, stdout } = run({ CLAUDE_STUB_EXIT: '3', CLAUDE_STUB_STDERR: 'auth: not logged in' })
  assert.notEqual(r.status, 0, 'exit code must be non-zero')
  assert.ok((r.stderr ?? '').includes('auth: not logged in'), `stderr was: ${r.stderr}`)
  const { rows, scoreLine } = parse(stdout)
  assert.equal(rows.length, all.length)
  for (const m of rows) assert.deepEqual([m[2], m[4]], ['miss', 'none'], m[1])
  assert.ok(scoreLine, 'score line is still printed')
  assert.equal(Number(scoreLine[1]), 0)
})

test('run-model: a missing binary leaves no foundry-evals-* dir in os.tmpdir()', async () => {
  const list = () => readdirSync(tmpdir()).filter((n) => n.startsWith('foundry-evals-'))
  const before = new Set(list())
  const missing = join(tmpdir(), `foundry-no-such-claude-${process.pid}`, 'claude')
  run({}, [], { claude: missing })
  const fresh = () => list().filter((n) => !before.has(n)).map((n) => join(tmpdir(), n))
    .filter((p) => { try { return statSync(p).isDirectory() && readdirSync(p).length === 0 } catch { return false } })
  const first = fresh()
  // A concurrent test file may be mid-run with a just-created, still empty dir; a leak stays empty.
  await new Promise((res) => setTimeout(res, 2000))
  const now = fresh()
  const stuck = first.filter((p) => now.includes(p))
  for (const p of stuck) rm(p)
  assert.deepEqual(stuck, [], 'empty foundry-evals-* dir left behind')
})
