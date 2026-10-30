// foundry ADR-0007 section 7: the owner's optional model-eval runner. Never a gate, outside every suite.
// Run: node plugins/foundry/evals/run-model.ts   (CLAUDE=<path> picks the binary, else `claude`)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { score } from './score.ts'
import type { Expected } from './score.ts'

const CASE_TIMEOUT_MS = 600000
const TOOLS: Record<string, string[]> = {
  judge: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git rev-parse:*)'],
  cynic: ['Read', 'Grep', 'Glob'],
}

type Case = { id: string; role: string; input: string; expected: Expected }

const here = dirname(fileURLToPath(import.meta.url))

function fail(msg: string): never {
  process.stderr.write(`run-model: ${msg}\n`)
  process.exit(1)
}

function git(...args: string[]): string {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  const r = spawnSync('git', args, { cwd: here, encoding: 'utf8', env, windowsHide: true, shell: false })
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr ?? r.error?.message ?? ''}`)
  return r.stdout.trim()
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

const top = git('rev-parse', '--show-toplevel')
const head = git('rev-parse', 'HEAD')
const bin = process.env.CLAUDE || 'claude'
const script = /\.(?:js|mjs|cjs)$/.test(bin)
const out = mkdtempSync(join(tmpdir(), 'foundry-evals-'))

const results: { id: string; role: string; result: string; expected: string; got: string }[] = []
let ok = 0
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
    '--output-format', 'text',
    '--allowedTools', ...tools,
  ]
  const r = spawnSync(script ? process.execPath : bin, script ? [bin, ...args] : args, {
    cwd: top, input: c.input, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: CASE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  })
  const err = r.error as (Error & { code?: string }) | undefined
  const timedOut = err?.code === 'ETIMEDOUT'
  if (err && !timedOut) fail(`${c.id}: cannot run ${bin}: ${err.message}`)
  const report = (r.stdout ?? '').replace(/\r/g, '')
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
