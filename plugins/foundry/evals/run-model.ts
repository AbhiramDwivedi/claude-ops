// foundry ADR-0007 section 7: the owner's optional model-eval runner. Never a gate, outside every suite.
// Run: node plugins/foundry/evals/run-model.ts   (CLAUDE=<path> picks the binary, else `claude`)
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, statSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { score } from './score.ts'
import type { Expected } from './score.ts'

const CASE_TIMEOUT_MS = 600000
const TOOLS: Record<string, string[]> = {
  judge: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git rev-parse:*)'],
  cynic: ['Read', 'Grep', 'Glob'],
}

const BUILT_IN: Record<string, string[]> = { judge: ['Read', 'Grep', 'Glob', 'Bash'], cynic: ['Read', 'Grep', 'Glob'] }
const DISALLOWED = [
  'Bash(git diff --output*)', 'Bash(git add:*)', 'Bash(git commit:*)',
  'Bash(git push:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)',
]

type Case = { id: string; role: string; input: string; expected: Expected }

const here = dirname(fileURLToPath(import.meta.url))

function fail(msg: string): never {
  process.stderr.write(`run-model: ${msg}\n`)
  process.exit(1)
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: here, encoding: 'utf8', env: gitEnv(), windowsHide: true, shell: false })
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr ?? r.error?.message ?? ''}`)
  return r.stdout.trim()
}

// Each case runs in a throwaway detached worktree of HEAD with the golden cases removed, so the model cannot read
// the expected answers. Best effort and never exits; it also runs from the exit hook, so fail() leaves nothing behind.
let live = ''
function dropWorktree(wt: string): void {
  const run = (...a: string[]) => spawnSync('git', a, { cwd: here, encoding: 'utf8', env: gitEnv(), windowsHide: true, shell: false })
  run('worktree', 'remove', '--force', wt)
  // A leftover process can hold the tree for a few seconds (EBUSY/EPERM/ENOTEMPTY): retry about 5 s, then warn.
  for (let i = 0; ; i++) {
    try {
      rmSync(wt, { recursive: true, force: true })
      break
    } catch (e) {
      if (i < 25) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); continue }
      process.stderr.write(`run-model: could not remove ${wt}: ${(e as Error).message}\n`)
      break
    }
  }
  run('worktree', 'prune')
}
process.on('exit', () => { if (live) dropWorktree(live) })
// An interrupt kills the live model child, gives it 1.5 s to let go of its cwd, then the exit hook above removes the
// worktree. It prints no score line and exits 130. The case runs async so these handlers can fire mid-case.
let child: ChildProcess | undefined
let stopping = false
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { stopping = true; child?.kill('SIGKILL'); setTimeout(() => process.exit(130), 1500) })
}

type Run = { status: number | null; stdout: string; stderr: string; error?: Error & { code?: string }; timedOut: boolean }
function runCase(cmd: string, argv: string[], cwd: string, input: string): Promise<Run> {
  return new Promise((done) => {
    const ch = spawn(cmd, argv, { cwd, shell: false, windowsHide: true })
    child = ch
    let stdout = ''
    let stderr = ''
    let timedOut = false
    ch.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
    ch.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL') }, CASE_TIMEOUT_MS)
    ch.on('error', (error) => { clearTimeout(timer); done({ status: null, stdout, stderr, error, timedOut }) })
    ch.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr, timedOut }) })
    ch.stdin.on('error', () => {})
    ch.stdin.end(input)
  })
}

// Frontmatter sits between the first two --- lines; the body is what follows.
function agent(role: string): { body: string; model: string; effort: string } {
  const text = readFileSync(join(here, '..', 'agents', `${role}.md`), 'utf8').replace(/\r/g, '').replace(/^﻿/, '')
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!m) fail(`agents/${role}.md has no frontmatter`)
  const field = (k: string) => new RegExp(`^${k}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(m[1])?.[1]
  const model = field('model')
  const effort = field('effort')
  if (!model || !effort) fail(`agents/${role}.md frontmatter lacks model or effort`)
  return { body: m[2], model, effort }
}

if (process.argv.length > 2) {
  process.stderr.write('usage: node run-model.ts   (takes no arguments; set CLAUDE to pick the binary)\n')
  process.exit(2)
}

const dir = join(here, 'golden')
const cases: Case[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Case)
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
if (cases.length === 0) fail('no golden cases')

const common = resolve(here, git('rev-parse', '--git-common-dir'))
const head = git('rev-parse', 'HEAD')
const bin = process.env.CLAUDE || 'claude'
const script = /\.(?:js|mjs|cjs)$/.test(bin)
const out = mkdtempSync(join(tmpdir(), 'foundry-evals-'))

const results: { id: string; role: string; result: string; expected: string; got: string }[] = []
let ok = 0
let childFailed = false
for (const c of cases) {
  const { body, model, effort } = agent(c.role)
  const tools = TOOLS[c.role]
  if (!tools) fail(`${c.id}: unknown role ${c.role}`)
  const args = [
    '-p',
    '--system-prompt', body,
    '--model', model,
    '--effort', effort,
    '--no-session-persistence',
    '--tools', ...BUILT_IN[c.role],
    '--disallowedTools', ...DISALLOWED,
    '--output-format', 'text',
    '--allowedTools', ...tools,
  ]
  live = mkdtempSync(join(tmpdir(), 'foundry-evals-wt-'))
  const wt = live
  git('worktree', 'add', '--detach', wt, 'HEAD')
  rmSync(join(wt, 'plugins', 'foundry', 'evals', 'golden'), { recursive: true, force: true })
  // Files under .git/foundry are copied in and named by relative path, so the input points nowhere outside the tree.
  const copied = new Map<string, string>()
  c.input = c.input.replace(/\S*\.git[\\/]foundry[^\s"'`)]*/g, (p) => {
    const tail = /[,;.:!?]*$/.exec(p)![0]
    const rel = p.slice(0, p.length - tail.length).replace(/\\/g, '/').replace(/^.*?\.git\//, '')
    const src = join(common, rel)
    const known = copied.get(src)
    if (known) return known + tail
    let name = basename(rel)
    if (existsSync(src)) {
      for (let n = 2; [...copied.values()].includes(`inputs/${name}`); n++) name = `${n}-${basename(rel)}`
      mkdirSync(join(wt, 'inputs'), { recursive: true })
      if (statSync(src).isDirectory()) cpSync(src, join(wt, 'inputs', name), { recursive: true })
      else copyFileSync(src, join(wt, 'inputs', name))
    }
    copied.set(src, `inputs/${name}`)
    return `inputs/${name}` + tail
  })
  const r = await runCase(script ? process.execPath : bin, script ? [bin, ...args] : args, wt, c.input)
  if (stopping) await new Promise(() => {}) // the interrupt timer exits; the exit hook removes the worktree
  child = undefined
  dropWorktree(wt)
  live = ''
  const err = r.error
  const timedOut = r.timedOut
  if (err && !timedOut) {
    rmSync(out, { recursive: true, force: true })
    fail(`${c.id}: cannot run ${bin}: ${err.message}`)
  }
  const report = r.stdout.replace(/\r/g, '')
  if (!timedOut && r.status !== 0 && report === '') {
    childFailed = true
    process.stderr.write(r.stderr)
  }
  writeFileSync(join(out, `${c.id}.txt`), report)
  const s = timedOut ? { ok: false, got: undefined } : score(report, c.expected)
  const result = timedOut ? 'timeout' : s.ok ? 'ok' : 'miss'
  if (s.ok) ok++
  const got = s.got ?? 'none'
  results.push({ id: c.id, role: c.role, result, expected: c.expected.kind, got })
  process.stdout.write(`${c.id} ${result} expected=${c.expected.kind} got=${got}\n`)
}
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
process.stdout.write(`score ${ok}/${cases.length} at ${head}\n`)
process.stdout.write(`results ${out}\n`)
if (childFailed) process.exit(1)
