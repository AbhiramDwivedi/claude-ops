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
import { spawn, spawnSync } from 'node:child_process'
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
// Drops block and line comments so a source check cannot be satisfied by a comment. Naive: fine for run-model.ts.
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

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

// Every form a .git/foundry path takes in a golden input: repo-relative or absolute, either slash, any run of
// separators (JSON-escaped backslashes are single after JSON.parse). The spec rewrites each to inputs/<basename>.
const FOUNDRY_PATH = /[^\s"'`()]*\.git[\\/]+foundry[\\/][^\s"'`)]*/g
function foundryPaths(input: string): string[] { return input.match(FOUNDRY_PATH) ?? [] }
function expectedInput(input: string): string {
  return input.replace(FOUNDRY_PATH, (p) => `inputs/${basename(p.replace(/\\/g, '/'))}`)
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
    // Every run that prints `results <dir>` removes that dir here, so the suite leaves no foundry-evals-* dir behind.
    if (outDir && basename(outDir).startsWith('foundry-evals-') && existsSync(outDir)) rm(outDir)
  }
}

// Throwaway-worktree contract (foreman ruling, option (a) for the run-model answer leak): each case runs in a temp
// worktree under os.tmpdir(), never in the checkout, and the worktree is gone once run-model has exited.
const insideDir = (child: string, parent: string) => norm(child).startsWith(`${norm(parent)}/`)
function assertThrowawayCwd(cwd: string, label: string) {
  const tmp = realpathSync.native(tmpdir())
  assert.ok(insideDir(cwd, tmp) || insideDir(cwd, tmpdir()), `${label}: ${cwd} is not under os.tmpdir() (${tmp})`)
  assert.notEqual(norm(cwd), norm(realpathSync.native(ROOT)), `${label}: cwd is the repo root`)
  assert.ok(!insideDir(cwd, realpathSync.native(ROOT)), `${label}: cwd is inside the checkout`)
  assert.equal(existsSync(cwd), false, `${label}: ${cwd} still exists after the run (worktree not removed)`)
}

// Worktrees git knows that live under os.tmpdir(): `git worktree list` entries and <common>/worktrees/<name>/gitdir
// pointers. Live agent worktrees sit under .claude/worktrees, so only tmpdir ones count.
// The leak tests pass a throwaway repo (see leakRepo) so the snapshot only sees worktrees that repo's runner made;
// reading the real checkout's list would also see every parallel crew's evals run.
function tmpWorktrees(repo: string = ROOT) {
  const common = repo === ROOT ? COMMON : realpathSync.native(join(repo, '.git'))
  const tmps = [norm(tmpdir()), norm(realpathSync.native(tmpdir()))]
  const underTmp = (p: string) => tmps.some((t) => norm(p).startsWith(`${t}/`))
  const own = [norm(repo), norm(realpathSync.native(repo))]
  const listedRaw = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8', env: cleanEnv(), windowsHide: true })
  assert.equal(listedRaw.status, 0, listedRaw.stderr)
  const listed = listedRaw.stdout.split('\n').filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9).trim()).filter(underTmp).map(norm).filter((p) => !own.includes(p))
  const wtDir = join(common, 'worktrees')
  const meta: string[] = []
  if (existsSync(wtDir)) {
    for (const n of readdirSync(wtDir)) {
      let g = ''
      try { g = readFileSync(join(wtDir, n, 'gitdir'), 'utf8').trim() } catch { g = '' }
      if (underTmp(g)) meta.push(`${n} -> ${norm(g)}`)
    }
  }
  return { listed: listed.sort(), meta: meta.sort() }
}
const newOnly = (before: string[], after: string[]) => after.filter((x) => !before.includes(x))

// A claude stand-in that records, at call time, what the fixture stub cannot: whether golden and the agents dir exist
// in its cwd, the files under <cwd>/inputs, and what git says about the cwd. Written to a temp dir by the test.
function makeProbe() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-probe-'))
  const file = join(dir, 'claude.mjs')
  writeFileSync(file, `import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
let stdin = ''
try { stdin = readFileSync(0, 'utf8') } catch {}
const cwd = process.cwd()
const g = (...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null }
const inputsDir = join(cwd, 'inputs')
const names = existsSync(inputsDir) ? readdirSync(inputsDir) : []
const rec = {
  argv: process.argv.slice(2), stdin, cwd,
  golden: existsSync(join(cwd, 'plugins', 'foundry', 'evals', 'golden')),
  agents: existsSync(join(cwd, 'plugins', 'foundry', 'agents')),
  inputs: names,
  inputText: Object.fromEntries(names.map((f) => [f, readFileSync(join(inputsDir, f), 'utf8')])),
  head: g('rev-parse', 'HEAD'),
  detached: g('symbolic-ref', '-q', 'HEAD') === null,
  worktrees: g('worktree', 'list', '--porcelain'),
}
const logDir = process.env.CLAUDE_STUB_LOG
if (logDir) {
  const n = readdirSync(logDir).filter((f) => /^\\d+\\.json$/.test(f)).length + 1
  writeFileSync(join(logDir, n + '.json'), JSON.stringify(rec))
}
process.stdout.write('VERDICT: PASS\\n\\n## Proof checked\\nprobe\\n')
`)
  return { file, dir }
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
    assert.equal(stdin, expectedInput(c.input), `${c.id}: stdin is the case input with .git/foundry paths rewritten to inputs/<basename>`)
    assertThrowawayCwd(cwd, `${c.id}: cwd`)
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
  // a source check closes the door on every name. Comments are stripped first. Today's file mentions process.env twice:
  // the whole-env copy `{ ...process.env }` for git (GIT_* dropped) and the one `process.env.CLAUDE` read. Pinned at 2.
  const text = stripComments(readFileSync(RUN_MODEL, 'utf8'))
  const reads = [...text.matchAll(/process\.env(\s*\.\s*(\w+)|\s*\?\.\s*(\w+)|\s*\[\s*(['"`])([^'"`]*)\4\s*\]|\s*\[[^\]]*\])?/g)]
  const named = reads.filter((m) => m[1] !== undefined)
  assert.ok(named.some((m) => (m[2] ?? m[3] ?? m[5]) === 'CLAUDE'), 'run-model no longer reads process.env.CLAUDE')
  for (const m of named) {
    const key = m[2] ?? m[3] ?? m[5]
    assert.equal(key, 'CLAUDE', `run-model reads process.env${m[1]}; only CLAUDE may be read by name`)
  }
  assert.equal((text.match(/process\.env/g) ?? []).length, 2, 'run-model mentions process.env a number of times other than the allowed 2')
  assert.equal((text.match(/\.\.\.\s*process\.env\b/g) ?? []).length, 1, 'exactly one whole-env spread is allowed')
  assert.ok(!/=\s*process\.env\s*(?:[;\n)]|$)/.test(text), 'process.env must not be aliased with =')
  assert.ok(!/}\s*=\s*process\.env/.test(text), 'process.env must not be destructured')
  assert.ok(!/\bprocess\s*\[\s*['"`]env['"`]\s*\]/.test(text), 'process["env"] is not allowed')
})

test('run-model: a case that outlives CASE_TIMEOUT_MS is killed and scored timeout (patched copy at 1.5 s, stub sleeps 5 s)', () => {
  // ADR-0007 section 7: "kills the child and scores the case timeout". The real constant is 600000, so the copy gets 1500.
  assert.ok(readFileSync(RUN_MODEL, 'utf8').includes('CASE_TIMEOUT_MS = 600000'), 'real run-model.ts must keep CASE_TIMEOUT_MS = 600000')
  const tmp = mkdtempSync(join(tmpdir(), 'foundry-copy-'))
  try {
    const base = join(tmp, 'plugins', 'foundry')
    mkdirSync(join(base, 'hooks'), { recursive: true })
    mkdirSync(join(base, 'agents'), { recursive: true })
    mkdirSync(join(base, 'evals', 'golden'), { recursive: true })
    // The copy holds only 2 golden cases (one judge, one cynic), so the run costs about 2 x 1.5 s, not one wait per real case.
    const golden = cases()
    const keep = [golden.find((c) => c.role === 'judge'), golden.find((c) => c.role === 'cynic')]
    assert.ok(keep.every(Boolean), 'need a judge and a cynic golden case')
    for (const f of readdirSync(join(PLUGIN, 'evals'))) if (f !== 'golden') cpSync(join(PLUGIN, 'evals', f), join(base, 'evals', f), { recursive: true })
    for (const c of keep) writeFileSync(join(base, 'evals', 'golden', `${c.id}.json`), JSON.stringify(c))
    cpSync(join(PLUGIN, 'hooks', 'register.ts'), join(base, 'hooks', 'register.ts'))
    for (const a of ['judge', 'cynic']) cpSync(join(PLUGIN, 'agents', `${a}.md`), join(base, 'agents', `${a}.md`))
    const rp = join(base, 'evals', 'run-model.ts')
    const orig = readFileSync(rp, 'utf8')
    const patched = orig.replace('CASE_TIMEOUT_MS = 600000', 'CASE_TIMEOUT_MS = 1500')
    assert.notEqual(patched, orig, 'the CASE_TIMEOUT_MS replacement did not happen')
    writeFileSync(rp, patched)
    const sleeper = join(tmp, 'sleeper.mjs')
    writeFileSync(sleeper, 'setTimeout(() => process.stdout.write("VERDICT: PASS\\n"), 5000)\n')
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
    for (const args of [['init', '-q'], ['config', 'user.name', 'copy'], ['config', 'user.email', 'copy@example.invalid'],
      ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'copy']]) {
      const g = spawnSync('git', args, { cwd: tmp, env, encoding: 'utf8', windowsHide: true })
      assert.equal(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`)
    }
    const { r, stdout } = run({}, [], { runModel: rp, cwd: tmp, claude: sleeper })
    const lines = stdout.split('\n').filter((l) => l.trim())
    const rows = lines.filter((l) => LINE.test(l))
    const sorted = [...keep].sort((a, b) => (a.id < b.id ? -1 : 1))
    assert.deepEqual(rows, sorted.map((c) => `${c.id} timeout expected=${c.expected.kind} got=none`), `stdout:\n${stdout}\nstderr: ${r.stderr}`)
    assert.ok(lines.some((l) => /^score 0\/2\b/.test(l)), `no 'score 0/2' line in:\n${stdout}`)
    assert.ok(!/cannot run/.test(stdout + (r.stderr ?? '')), 'a timeout must not read as "cannot run"')
  } finally {
    rm(tmp)
  }
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
  const text = stripComments(readFileSync(RUN_MODEL, 'utf8'))
  assert.equal(text.split('const CASE_TIMEOUT_MS = 600000').length - 1, 1, 'const CASE_TIMEOUT_MS = 600000 must be declared exactly once')
  // The function that spawns the model: a top-level function whose body calls spawn( and writes the case input to stdin.
  const fn = text.split(/\n(?=(?:async )?function )/).find((f) => /\bspawn\(/.test(f) && /stdin\.(end|write)\(/.test(f))
  assert.ok(fn, 'no function spawns the model and writes to its stdin')
  assert.ok(/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*\}\s*,\s*CASE_TIMEOUT_MS\s*\)/.test(fn), 'setTimeout(..., CASE_TIMEOUT_MS) with no arithmetic must guard the case child')
  assert.ok(/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*'SIGKILL'[^}]*\}\s*,\s*CASE_TIMEOUT_MS\s*\)/.test(fn), 'the CASE_TIMEOUT_MS timer must kill the child with SIGKILL')
  assert.ok(/stdin\.end\(\s*input\s*\)/.test(fn), 'the case input must be written to the child stdin')
  assert.ok(/runCase\([^)]*\bc\.input\s*\)/.test(text), 'the call site must pass c.input to runCase')
})

test('run-model: runs claude in a throwaway worktree even when started from a subdirectory', () => {
  const { r, calls } = run({}, [], { cwd: PLUGIN })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(calls.length >= 1)
  for (const c of calls) assertThrowawayCwd(c.cwd, 'cwd')
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

test('run-model: at call time the case cwd is a detached worktree of HEAD with the agents dir checked out and the golden dir removed', () => {
  const probe = makeProbe()
  try {
    const { r, calls } = run({}, [], { claude: probe.file })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, cases().length)
    for (const c of calls) {
      assert.equal(c.golden, false, `golden still present in ${c.cwd}/plugins/foundry/evals/golden`)
      assert.equal(c.agents, true, `plugins/foundry/agents missing in ${c.cwd}`)
      assert.equal(c.head, HEAD, 'worktree is not at HEAD')
      assert.equal(c.detached, true, 'worktree is not detached')
      assert.ok(c.worktrees.split('\n').some((l: string) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(c.cwd)),
        `git does not list ${c.cwd} as a worktree`)
      assertThrowawayCwd(c.cwd, 'probe cwd')
    }
  } finally { rm(probe.dir) }
})

test('run-model: no .git/foundry (either slash) reaches claude on stdin; named files arrive as inputs/<basename>, copied into the temp tree', () => {
  const all = cases()
  const probe = makeProbe()
  try {
    const { r, calls } = run({}, [], { claude: probe.file })
    assert.equal(r.status, 0, r.stderr)
    let named = 0
    for (const [i, c] of all.entries()) {
      const call = calls[i]
      assert.ok(!call.stdin.includes('.git/foundry'), `${c.id}: stdin contains .git/foundry`)
      assert.ok(!call.stdin.includes('.git\\foundry'), `${c.id}: stdin contains .git\\foundry`)
      assert.ok(!/\.git[\\/]+foundry/.test(call.stdin), `${c.id}: stdin still names a .git/foundry path`)
      assert.equal(call.stdin, expectedInput(c.input), `${c.id}: stdin is the input with only the paths rewritten`)
      const paths = foundryPaths(c.input)
      for (const p of paths) {
        named++
        const base = basename(p.replace(/\\/g, '/'))
        assert.ok(call.stdin.includes(`inputs/${base}`), `${c.id}: stdin does not name inputs/${base}`)
        const src = join(COMMON, p.replace(/\\/g, '/').replace(/^.*?\.git\//, ''))
        if (existsSync(src)) {
          assert.ok(call.inputs.includes(base), `${c.id}: ${base} not copied to <cwd>/inputs (has ${call.inputs.join(',')})`)
          assert.equal(call.inputText[base], readFileSync(src, 'utf8'), `${c.id}: copied ${base} differs from the source`)
        }
      }
    }
    assert.ok(named >= 1, 'no golden case names a .git/foundry file; this test would pin nothing')
  } finally { rm(probe.dir) }
})

test('run-model: after a run git lists no extra worktree under os.tmpdir() and the common dir holds no leftover worktree metadata', () => {
  const { tmp, rp } = leakRepo()
  try {
    const before = tmpWorktrees(tmp)
    const { r, calls } = run({}, [], { runModel: rp, cwd: tmp })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(calls.length >= 1)
    const after = tmpWorktrees(tmp)
    assert.deepEqual(newOnly(before.listed, after.listed), [], 'git worktree list shows a leftover temp worktree')
    assert.deepEqual(newOnly(before.meta, after.meta), [], '<common>/worktrees holds leftover metadata from the run')
    for (const c of calls) assert.equal(existsSync(c.cwd), false, `${c.cwd} still exists`)
  } finally { rm(tmp) }
})

test('run-model: the temp worktrees are removed even when every claude call fails', () => {
  const { tmp, rp } = leakRepo()
  try {
    const before = tmpWorktrees(tmp)
    const { r, calls } = run({ CLAUDE_STUB_EXIT: '3', CLAUDE_STUB_STDERR: 'boom' }, [], { runModel: rp, cwd: tmp })
    assert.notEqual(r.status, 0)
    assert.equal(calls.length, LEAK_CASES.length)
    const after = tmpWorktrees(tmp)
    assert.deepEqual(newOnly(before.listed, after.listed), [], 'leftover temp worktree after failing calls')
    assert.deepEqual(newOnly(before.meta, after.meta), [], 'leftover worktree metadata after failing calls')
    for (const c of calls) assertThrowawayCwd(c.cwd, 'failing-call cwd')
  } finally { rm(tmp) }
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


// ---- Hardening tests (red team 5): interrupt, punctuation, collisions, directories, busy cleanup ----------------------
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const sleepMs = (ms: number) => new Promise((res) => setTimeout(res, ms))
const cleanEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k]; return e }

// Copy of the plugin in a throwaway git repo with only the given golden cases. `sources` maps a path under
// <git dir>/foundry to its content; they are created unconditionally, so a copy assertion never skips.
function synth(defs: { id: string; input: string }[], sources: Record<string, string>) {
  const tmp = mkdtempSync(join(tmpdir(), 'foundry-synth-'))
  const base = join(tmp, 'plugins', 'foundry')
  mkdirSync(join(base, 'hooks'), { recursive: true })
  mkdirSync(join(base, 'agents'), { recursive: true })
  mkdirSync(join(base, 'evals', 'golden'), { recursive: true })
  for (const f of readdirSync(join(PLUGIN, 'evals'))) if (f !== 'golden') cpSync(join(PLUGIN, 'evals', f), join(base, 'evals', f), { recursive: true })
  cpSync(join(PLUGIN, 'hooks', 'register.ts'), join(base, 'hooks', 'register.ts'))
  for (const a of ['judge', 'cynic']) cpSync(join(PLUGIN, 'agents', `${a}.md`), join(base, 'agents', `${a}.md`))
  for (const d of defs) {
    writeFileSync(join(base, 'evals', 'golden', `${d.id}.json`), JSON.stringify({
      id: d.id, source: `.git/foundry/${U1}/a.md`, role: 'judge', input: d.input, expected: { keyword: 'VERDICT', kind: 'PASS' },
    }))
  }
  const env = cleanEnv()
  for (const args of [['init', '-q'], ['config', 'user.name', 'copy'], ['config', 'user.email', 'copy@example.invalid'],
    ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'copy']]) {
    const g = spawnSync('git', args, { cwd: tmp, env, encoding: 'utf8', windowsHide: true })
    assert.equal(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`)
  }
  for (const [rel, content] of Object.entries(sources)) {
    const f = join(tmp, '.git', 'foundry', rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, content)
  }
  return { tmp, rp: join(base, 'evals', 'run-model.ts') }
}

// A throwaway repo (copy of the plugin, two golden cases) for the worktree-leak tests. The runner inside it creates
// its temp worktrees in THIS repo, so before/after snapshots of tmpWorktrees(tmp) see only what this run did, never
// a parallel crew's run against the real checkout.
const LEAK_CASES = [{ id: 'leak-one', input: 'x\n' }, { id: 'leak-two', input: 'y\n' }]
const leakRepo = () => synth(LEAK_CASES, {})

// Like makeProbe, but resolves every inputs/... token in stdin (nested paths too) and records the content found.
function makeResolveProbe() {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-rprobe-'))
  const file = join(dir, 'claude.mjs')
  writeFileSync(file, `import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
let stdin = ''
try { stdin = readFileSync(0, 'utf8') } catch {}
const files = {}
for (const t of stdin.match(/inputs\\/[^\\s,;]+/g) ?? []) {
  try { files[t] = readFileSync(join(process.cwd(), t), 'utf8') } catch { files[t] = null }
}
const logDir = process.env.CLAUDE_STUB_LOG
if (logDir) writeFileSync(join(logDir, (readdirSync(logDir).length + 1) + '.json'), JSON.stringify({ stdin, cwd: process.cwd(), files }))
process.stdout.write('VERDICT: PASS\\n\\n## Proof checked\\nprobe\\n')
`)
  return { file, dir }
}

test('run-model: trailing punctuation after a .git/foundry path stays in the text, not in the file name (comma, full stop, semicolon)', () => {
  const defs = [
    { id: 'p-comma', input: `See .git/foundry/${U1}/a.md, then judge.\n` },
    { id: 'p-dot', input: `The brief is at .git/foundry/${U1}/a.md.\n` },
    { id: 'p-semi', input: `Read .git/foundry/${U1}/a.md; then judge.\n` },
  ]
  const { tmp, rp } = synth(defs, { [`${U1}/a.md`]: 'CONTENT-A\n' })
  const probe = makeProbe()
  try {
    const { r, calls } = run({}, [], { runModel: rp, cwd: tmp, claude: probe.file })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 3)
    const want = ['See inputs/a.md, then judge.\n', 'The brief is at inputs/a.md.\n', 'Read inputs/a.md; then judge.\n']
    for (const [i, d] of defs.entries()) {
      assert.equal(calls[i].stdin, want[i], `${d.id}: stdin`)
      assert.deepEqual(calls[i].inputs, ['a.md'], `${d.id}: <cwd>/inputs must hold exactly a.md (no file named with the punctuation)`)
      assert.equal(calls[i].inputText['a.md'], 'CONTENT-A\n', `${d.id}: copied content`)
    }
  } finally { rm(probe.dir); rm(tmp) }
})

test('run-model: two .git/foundry files with the same basename get two distinct inputs/ paths, each with its own content; the same file twice maps to one path', () => {
  const input = `first .git/foundry/${U1}/decisions.md\nsecond .git/foundry/${U2}/decisions.md\nagain .git/foundry/${U1}/decisions.md\n`
  const { tmp, rp } = synth([{ id: 'collide', input }], { [`${U1}/decisions.md`]: 'ONE\n', [`${U2}/decisions.md`]: 'TWO\n' })
  const probe = makeResolveProbe()
  try {
    const { r, calls } = run({}, [], { runModel: rp, cwd: tmp, claude: probe.file })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 1)
    const lines = calls[0].stdin.split('\n')
    assert.equal(lines[0], 'first inputs/decisions.md', 'the first file keeps inputs/<basename>')
    assert.ok(/^second inputs\/\S+$/.test(lines[1]), `second line: ${lines[1]}`)
    const p1 = lines[0].slice('first '.length)
    const p2 = lines[1].slice('second '.length)
    assert.notEqual(p2, p1, 'both files were given the same inputs/ path')
    assert.equal(lines[2], `again ${p1}`, 'the same file named twice must map to the same path')
    assert.ok(!/\.git[\\/]+foundry/.test(calls[0].stdin), 'stdin still names .git/foundry')
    assert.equal(calls[0].files[p1], 'ONE\n', `${p1} must hold the first file's content`)
    assert.equal(calls[0].files[p2], 'TWO\n', `${p2} must hold the second file's content`)
  } finally { rm(probe.dir); rm(tmp) }
})

test('run-model: a directory named in the input does not abort the run; every case still gets a line and the score line', () => {
  const defs = [
    { id: 'd-dir', input: `Review .git/foundry/${U1}/reports/foo/ now.\n` },
    { id: 'e-plain', input: 'No paths here.\n' },
  ]
  const { tmp, rp } = synth(defs, { [`${U1}/reports/foo/x.md`]: 'X\n', [`${U1}/reports/foo/sub/y.md`]: 'Y\n' })
  try {
    const { r, stdout, calls } = run({}, [], { runModel: rp, cwd: tmp })
    const lines = stdout.split('\n').filter((l) => l.trim())
    assert.deepEqual(lines.filter((l) => LINE.test(l)), ['d-dir ok expected=PASS got=PASS', 'e-plain ok expected=PASS got=PASS'],
      `exit ${r.status}\nstdout:\n${stdout}\nstderr: ${r.stderr}`)
    assert.ok(lines.some((l) => /^score 2\/2 at /.test(l)), `no score line in:\n${stdout}`)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(calls.length, 2)
    assert.ok(!/\.git[\\/]+foundry/.test(calls[0].stdin), `stdin still names .git/foundry: ${calls[0].stdin}`)
  } finally { rm(tmp) }
})

// An interrupt the runner can actually catch. On Windows child.kill('SIGINT') is TerminateProcess, so no handler can
// run; a real Ctrl-Break is a console control event, delivered here by a Python helper (CREATE_NEW_PROCESS_GROUP +
// os.kill(pid, CTRL_BREAK_EVENT)). On POSIX the signal is sent with child.kill.
const SIG_HELPER_PY = `import json, os, signal, subprocess, sys, time
node, script, cwd, d = sys.argv[1:5]
p = subprocess.Popen([node, script], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
started = os.path.join(d, 'started.json')
deadline = time.time() + 60
while time.time() < deadline and not os.path.exists(started) and p.poll() is None:
    time.sleep(0.1)
time.sleep(0.3)
if p.poll() is None:
    os.kill(p.pid, signal.CTRL_BREAK_EVENT)
try:
    out, _ = p.communicate(timeout=20)
    code = p.returncode
except subprocess.TimeoutExpired:
    p.kill()
    out, _ = p.communicate()
    code = 'hung'
sys.stdout.write(json.dumps({'code': code, 'stdout': out.decode('utf8', 'replace')}))
`

async function interruptCase(how: 'SIGINT' | 'SIGTERM' | 'CTRL_BREAK', t: { skip: (m?: string) => void }) {
  if (how === 'CTRL_BREAK') {
    const py = spawnSync('python', ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true })
    if (py.error || py.status !== 0) { t.skip('python was not found on PATH; the Windows Ctrl-Break delivery needs it'); return }
  }
  const { tmp, rp } = leakRepo()
  const before = tmpWorktrees(tmp)
  const dir = mkdtempSync(join(tmpdir(), 'foundry-sig-'))
  const stub = join(dir, 'hang.mjs')
  writeFileSync(stub, `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
writeFileSync(join(process.env.SIG_DIR, 'started.json'), JSON.stringify({ pid: process.pid, cwd: process.cwd() }))
setTimeout(() => {}, 60000)
`)
  const env = { ...cleanEnv(), CLAUDE: stub, SIG_DIR: dir }
  let child: ReturnType<typeof spawn>
  if (how === 'CTRL_BREAK') {
    const helper = join(dir, 'sigbreak.py')
    writeFileSync(helper, SIG_HELPER_PY)
    child = spawn('python', [helper, process.execPath, rp, tmp, dir], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } else {
    child = spawn(process.execPath, [rp], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  }
  let out = ''
  let err = ''
  child.stdout!.on('data', (d) => { out += d })
  child.stderr!.on('data', (d) => { err += d })
  const exited = new Promise<{ code: number | null; sig: string | null }>((res) => child.on('exit', (code, sig) => res({ code, sig })))
  let started: { pid: number; cwd: string } | undefined
  let leftL: string[] = []
  try {
    let code: number | string | null
    let sig: string | null = null
    let runnerOut: string
    if (how === 'CTRL_BREAK') {
      const res = await Promise.race([exited, sleepMs(100000).then(() => 'hung' as const)])
      assert.notEqual(res, 'hung', 'the Python helper did not finish')
      let parsed: { code: number | string; stdout: string } | undefined
      try { parsed = JSON.parse(out) } catch { assert.fail(`helper gave no result (python stderr: ${err}) stdout: ${out}`) }
      code = parsed!.code
      runnerOut = parsed!.stdout
      try { started = JSON.parse(readFileSync(join(dir, 'started.json'), 'utf8')) } catch {}
      assert.ok(started, `the stub never started (python stderr: ${err})`)
      assert.notEqual(code, 'hung', 'run-model did not exit within 20 s of Ctrl-Break')
    } else {
      for (let i = 0; i < 600 && !started; i++) {
        try { started = JSON.parse(readFileSync(join(dir, 'started.json'), 'utf8')) } catch { await sleepMs(100) }
      }
      assert.ok(started, 'the stub never started')
      child.kill(how)
      const res = await Promise.race([exited, sleepMs(20000).then(() => 'hung' as const)])
      assert.notEqual(res, 'hung', `run-model did not exit within 20 s of ${how}`)
      ;({ code, sig } = res as { code: number | null; sig: string | null })
      runnerOut = out
    }
    await sleepMs(300)
    const after = tmpWorktrees(tmp)
    leftL = newOnly(before.listed, after.listed)
    assert.ok(code !== 0, `exit code ${code} signal ${sig}: an interrupted run must not exit 0`)
    assert.ok(!/^score /m.test(runnerOut), `a score line was printed after the interrupt:\n${runnerOut}`)
    assert.deepEqual(leftL, [], `runner exit ${code}/${sig} after ${how}: git worktree list shows a leftover temp worktree`)
    assert.deepEqual(newOnly(before.meta, after.meta), [], `runner exit ${code}/${sig} after ${how}: <common>/worktrees holds leftover metadata`)
    assert.ok(!existsSync(started!.cwd), `runner exit ${code}/${sig} after ${how}: the temp worktree dir ${started!.cwd} still exists`)
  } finally {
    try { child.kill('SIGKILL') } catch {}
    if (started) { try { process.kill(started.pid, 'SIGKILL') } catch {} }
    await sleepMs(500)
    // Tidy what the red run leaked, so the suite does not accumulate worktrees.
    for (const w of leftL) spawnSync('git', ['worktree', 'remove', '--force', w], { cwd: tmp, windowsHide: true })
    if (started) rm(started.cwd)
    spawnSync('git', ['worktree', 'prune'], { cwd: tmp, windowsHide: true })
    rm(dir)
    rm(tmp)
  }
}

if (process.platform === 'win32') {
  test('run-model: an interrupt (Ctrl-Break console event) mid-case leaves no temp worktree and no score line', (t) => interruptCase('CTRL_BREAK', t))
} else {
  test('run-model: an interrupt (SIGINT) mid-case leaves no temp worktree and no score line', (t) => interruptCase('SIGINT', t))
  test('run-model: SIGTERM mid-case leaves no temp worktree and no score line', (t) => interruptCase('SIGTERM', t))
}

test('run-model: cleanup that cannot remove the tree at once (a leftover process holds the cwd) does not abort the run, and nothing is left afterwards', async () => {
  const { tmp, rp } = synth([{ id: 'busy-one', input: 'x\n' }], {})
  const dir = mkdtempSync(join(tmpdir(), 'foundry-busy-'))
  const stub = join(dir, 'busy.mjs')
  writeFileSync(stub, `import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
try { readFileSync(0) } catch {}
writeFileSync(join(process.env.BUSY_DIR, 'cwd.txt'), process.cwd())
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { detached: true, stdio: 'ignore', cwd: process.cwd(), windowsHide: true }).unref()
process.stdout.write('VERDICT: PASS\\n\\n## Proof checked\\nbusy\\n')
`)
  try {
    const { r, stdout } = run({ BUSY_DIR: dir }, [], { runModel: rp, cwd: tmp, claude: stub })
    const cwd = readFileSync(join(dir, 'cwd.txt'), 'utf8')
    assert.ok(/^score 1\/1 at /m.test(stdout), `no score line (exit ${r.status}):\nstdout:\n${stdout}\nstderr:\n${r.stderr}`)
    assert.equal(r.status, 0, r.stderr)
    for (let i = 0; i < 100 && existsSync(cwd); i++) await sleepMs(100)
    await sleepMs(300)
    const g = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: tmp, encoding: 'utf8', windowsHide: true }).stdout
    const listed = g.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => norm(l.slice(9).trim()))
    assert.deepEqual(listed.filter((p) => p !== norm(realpathSync.native(tmp)) && p !== norm(tmp)), [], 'worktree still registered once the holder exited')
    assert.equal(existsSync(cwd), false, `${cwd} still exists once the holder exited`)
  } finally { rm(dir); rm(tmp) }
})
