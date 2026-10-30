// foundry ADR-0009 Decision 1: the factory CLI. Run as `node <plugin>/bin/factory.ts <command> [flags]`. Every command
// prints one JSON object on one line; exit 0 = done, 1 = a gate or expectation refused, 2 = usage or I/O error
// ({"error": "..."}). Node built-ins and ../hooks/register.ts only.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fencedBlock, judgeFails, localTime, parsePlan, planVerdict } from '../hooks/register.ts'
import type { JudgeFile } from '../hooks/register.ts'

// ==== core ====

export class CliError extends Error {
  code: number
  body: Record<string, unknown>
  constructor(code: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : JSON.stringify(body))
    this.code = code
    this.body = body
  }
}
const usage = (message: string): CliError => new CliError(2, { error: message })
const refuse = (body: Record<string, unknown>): CliError => new CliError(1, body)

type Flags = Record<string, string | boolean | string[]>
type Obj = Record<string, any>

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')
const flat = (p: string): string => String(p).replace(/\\/g, '/')

// Flags as `--key value`; a flag with no value is true; a repeated flag becomes a list.
function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw usage(`unexpected argument: ${a}`)
    const key = a.slice(2)
    const next = argv[i + 1]
    const value: string | boolean = next === undefined || next.startsWith('--') ? true : (i++, next)
    const old = flags[key]
    flags[key] = old === undefined ? value : [...(Array.isArray(old) ? old : [String(old)]), String(value)]
  }
  return flags
}
const str = (f: Flags, key: string): string | undefined => {
  const v = f[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw usage(`--${key} needs a value`)
  return v
}
const need = (f: Flags, key: string): string => {
  const v = str(f, key)
  if (v === undefined || v === '') throw usage(`missing --${key}`)
  return v
}
const listOf = (f: Flags, key: string): string[] => {
  const v = f[key]
  if (v === undefined) return []
  if (v === true) throw usage(`--${key} needs a value`)
  return Array.isArray(v) ? v : [String(v)]
}

// Runs git in `cwd` and returns status, trimmed stdout and stderr.
function run(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.error) throw usage(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
function gitOrFail(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (r.status !== 0) throw usage(`git ${args.join(' ')} failed: ${r.err || r.out}`)
  return r.out
}

function repoOf(f: Flags): string {
  const given = str(f, 'repo')
  if (given !== undefined && given !== '') return flat(given)
  const r = run(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (r.status !== 0) throw usage('no --repo and the cwd is not in a git repository')
  return flat(r.out)
}
const dirOf = (f: Flags): string => flat(need(f, 'dir'))

const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    throw usage(`cannot read ${flat(p)}: ${(e as Error).message}`)
  }
}
const readJson = (p: string): any => {
  const text = readText(p)
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
  } catch {
    throw usage(`${flat(p)} is not JSON`)
  }
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// A Workflow label as {slug, role, n}: strip a trailing -<n> (n >= 2) first, the last segment is the role, the rest the slug. Undefined when it has no role segment.
export function parseLabel(label: string): { slug: string; role: string; n: number } | undefined {
  if (typeof label !== 'string') return undefined
  let rest = label
  let n = 1
  const m = /-(\d+)$/.exec(rest)
  if (m) {
    n = Number(m[1])
    if (n < 2) return undefined
    rest = rest.slice(0, m.index)
  }
  const cut = rest.lastIndexOf('-')
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { slug: rest.slice(0, cut), role: rest.slice(cut + 1), n }
}

// The plan object from D/plan.json (usage error when missing or unreadable).
export function loadPlan(dir: string): Obj {
  const plan = readJson(`${dir}/plan.json`)
  if (!isObj(plan) || !Array.isArray(plan.crews)) throw usage(`${dir}/plan.json is not a plan`)
  return plan
}
// Writes the plan object back to D/plan.json, 2-space JSON with a trailing newline.
export function savePlan(dir: string, plan: Obj): void {
  writeFileSync(`${dir}/plan.json`, JSON.stringify(plan, null, 2) + '\n')
}

// The repo's merge mode and target branch, and where they came from, as `settings` prints them.
export function settingsOf(repo: string): { merge: string; target: string; source: string } {
  let cfg: Obj = {}
  const p = `${repo}/.claude/foundry.json`
  if (existsSync(p)) {
    const v = readJson(p)
    if (isObj(v)) cfg = v
  }
  const hasMerge = typeof cfg.merge === 'string' && cfg.merge !== ''
  const hasTarget = typeof cfg.target === 'string' && cfg.target !== ''
  const target = hasTarget ? cfg.target : run(repo, ['branch', '--show-current']).out
  return { merge: hasMerge ? cfg.merge : 'sequential', target, source: hasMerge && hasTarget ? '.claude/foundry.json' : hasMerge || hasTarget ? 'mixed' : 'default' }
}
// The repo's .claude/foundry.json as an object ({} when absent).
function configOf(repo: string): Obj {
  const p = `${repo}/.claude/foundry.json`
  if (!existsSync(p)) return {}
  const v = readJson(p)
  return isObj(v) ? v : {}
}
const intOr = (v: unknown, dflt: number, min: number): number => (Number.isInteger(v) && (v as number) >= min ? (v as number) : dflt)

// The crew worktree path <repo>/.claude/worktrees/foundry-<slug>.
export function crewWorktree(repo: string, slug: string): string {
  return `${repo}/.claude/worktrees/foundry-${slug}`
}
// `git merge-base <target> HEAD` in the worktree: the target head last merged into the crew branch.
export function baseOf(worktree: string, target: string): string {
  return gitOrFail(worktree, ['merge-base', target, 'HEAD'])
}

// Appends {"v":1,"ts":now,...obj} as one line to D/events.jsonl.
export function appendEvent(dir: string, obj: Obj): void {
  appendFileSync(`${dir}/events.jsonl`, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj }) + '\n')
}
// Appends `- HH:MM | <what | why> | none | followed` (local time, localTime from the hooks) to D/decisions.md; text is "what | why".
export function appendDecision(dir: string, text: string): void {
  const p = `${dir}/decisions.md`
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  appendFileSync(p, `${old === '' || old.endsWith('\n') ? '' : '\n'}- ${localTime(Date.now())} | ${text} | none | followed\n`)
}
// The roles table from <plugin>/workflows/roles.json.
export function readRoles(plugin: string): Obj {
  const v = readJson(`${plugin}/workflows/roles.json`)
  if (!isObj(v)) throw usage('roles.json is not an object')
  return v
}

export type RunAgent = { agentId: string; label: string; phase: string | undefined; hasResult: boolean; result: unknown; meta: Obj | undefined; transcript: string }
export type WfRun = { id: string; dir: string; journal: Obj[]; agents: RunAgent[] }
const jsonLines = (p: string): Obj[] =>
  readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').flatMap((l) => {
    try {
      const v = JSON.parse(l)
      return isObj(v) ? [v] : []
    } catch {
      return []
    }
  })
// One Workflow run dir read: its journal lines and, per `started` line, the agent's label, last result, meta file and transcript path.
export function runOf(runDir: string): WfRun {
  const dir = flat(runDir)
  const journalPath = `${dir}/journal.jsonl`
  const journal = existsSync(journalPath) ? jsonLines(journalPath) : []
  const agents: RunAgent[] = []
  for (const line of journal) {
    if (line.type !== 'started' || typeof line.agentId !== 'string' || typeof line.label !== 'string') continue
    const results = journal.filter((l) => l.type === 'result' && l.agentId === line.agentId)
    const metaPath = `${dir}/agent-${line.agentId}.meta.json`
    agents.push({
      agentId: line.agentId, label: line.label, phase: typeof line.phase === 'string' ? line.phase : undefined,
      hasResult: results.length > 0, result: results.length > 0 ? results[results.length - 1].result : undefined,
      meta: existsSync(metaPath) ? readJson(metaPath) : undefined, transcript: `${dir}/agent-${line.agentId}.jsonl`,
    })
  }
  return { id: path.basename(dir), dir, journal, agents }
}
// Every run dir under the transcripts root (sorted by name), each read with runOf.
export function runsOf(transcriptsDir: string): WfRun[] {
  const root = flat(transcriptsDir)
  if (!existsSync(root)) return []
  return readdirSync(root).sort().filter((n) => statSync(`${root}/${n}`).isDirectory()).map((n) => runOf(`${root}/${n}`))
}

// First and last record timestamp, the model, the request effort and the tool uses of an agent transcript.
export function transcriptFacts(agentJsonl: string): { firstTs: string | undefined; lastTs: string | undefined; model: string | undefined; effort: string | undefined; tools: { name: string; input: Obj }[] } {
  const facts = { firstTs: undefined as string | undefined, lastTs: undefined as string | undefined, model: undefined as string | undefined, effort: undefined as string | undefined, tools: [] as { name: string; input: Obj }[] }
  if (!existsSync(agentJsonl)) return facts
  for (const rec of jsonLines(agentJsonl)) {
    if (typeof rec.timestamp === 'string') {
      facts.firstTs ??= rec.timestamp
      facts.lastTs = rec.timestamp
    }
    const effort = rec.message?.output_config?.effort ?? rec.output_config?.effort
    if (typeof effort === 'string') facts.effort = effort
    if (rec.type === 'assistant' && isObj(rec.message)) {
      if (typeof rec.message.model === 'string') facts.model = rec.message.model
      if (Array.isArray(rec.message.content)) for (const c of rec.message.content) if (isObj(c) && c.type === 'tool_use') facts.tools.push({ name: String(c.name), input: isObj(c.input) ? c.input : {} })
    }
  }
  return facts
}

// The newest mtime (ms) over a run's journal.jsonl and every agent-*.jsonl; 0 when none.
export function newestMtime(runDir: string): number {
  const dir = flat(runDir)
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const n of readdirSync(dir)) if (n === 'journal.jsonl' || (n.startsWith('agent-') && n.endsWith('.jsonl'))) newest = Math.max(newest, statSync(`${dir}/${n}`).mtimeMs)
  return newest
}
// 30 minutes: a run with nothing newer than this is not live (ADR-0009 "start, stale runs", rule 3).
export const STALE_MS = 1800000
// Rule 3: live unless the crew's newest factory spawn (ISO string or ms) and the run's newest mtime are both more than STALE_MS before `now`.
export function isLive(spawnTs: string | number, runDir: string | undefined, now: number): boolean {
  const spawn = typeof spawnTs === 'number' ? spawnTs : Date.parse(spawnTs)
  const newest = runDir === undefined ? 0 : newestMtime(runDir)
  return !(now - spawn > STALE_MS && now - newest > STALE_MS)
}

// The crew's report files D/reports/<slug>/*.md as JudgeFile[] ({name with .md, text, mtimeMs}), sorted by name.
export function reportsOf(dir: string, slug: string): JudgeFile[] {
  const d = `${dir}/reports/${slug}`
  if (!existsSync(d)) return []
  return readdirSync(d).filter((n) => n.endsWith('.md')).sort().map((name) => ({ name, text: readFileSync(`${d}/${name}`, 'utf8'), mtimeMs: statSync(`${d}/${name}`).mtimeMs }))
}
// The crew's repair spend: its judge FAIL reports only (owner ruling: red-team rounds add nothing).
export function spentOf(dir: string, slug: string, since = 0): number {
  return judgeFails(slug, reportsOf(dir, slug), since)
}
// {role: next free label number} from the crew's report files: `<slug>-judge.md` and `-judge-2.md` give {"judge": 3}.
export function labelFromOf(dir: string, slug: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of reportsOf(dir, slug)) {
    const p = parseLabel(f.name.replace(/\.md$/, ''))
    if (p !== undefined && p.slug === slug) out[p.role] = Math.max(out[p.role] ?? 1, p.n + 1)
  }
  return out
}
// The crew's newest `by: "factory"` spawn line in D/events.jsonl, or undefined when it has none.
export function factorySpawned(dir: string, slug: string): Obj | undefined {
  const p = `${dir}/events.jsonl`
  if (!existsSync(p)) return undefined
  const lines = jsonLines(p).filter((e) => e.event === 'spawn' && e.crew === slug && e.by === 'factory')
  return lines[lines.length - 1]
}

// The roles table copied for args, with `--type role=agentType` laid on the roles marked typeFromProject: true; resolver follows the role its typeFromProject names.
function rolesWithTypes(plugin: string, types: string[]): Obj {
  const roles = readRoles(plugin)
  for (const t of types) {
    const eq = t.indexOf('=')
    if (eq <= 0 || eq === t.length - 1) throw usage(`--type needs role=agentType, got ${t}`)
    const role = t.slice(0, eq)
    if (!isObj(roles[role])) throw usage(`--type: unknown role ${role}`)
    if (roles[role].typeFromProject !== true) throw usage(`--type: role ${role} does not take a project agent type`)
    roles[role].agentType = t.slice(eq + 1)
  }
  for (const r of Object.values(roles)) if (isObj(r) && typeof r.typeFromProject === 'string' && isObj(roles[r.typeFromProject])) r.agentType = roles[r.typeFromProject].agentType
  return roles
}
// Copies <plugin>/workflows/<script> byte for byte to <scriptsDir>/foundry-<script> and returns that path; without scriptsDir returns the plugin path.
function scriptPathFor(plugin: string, script: string, scriptsDir: string | undefined): string {
  const src = `${plugin}/workflows/${script}`
  if (scriptsDir === undefined) return src
  if (!existsSync(src)) throw usage(`${src} does not exist`)
  mkdirSync(scriptsDir, { recursive: true })
  const to = `${flat(scriptsDir)}/foundry-${script}`
  copyFileSync(src, to)
  return to
}
// The architecture doc as an absolute path (the key `architecture` of foundry.json, repo-relative, default docs/architecture.md).
const archPath = (repo: string, rel: unknown): string => path.isAbsolute(String(rel)) ? flat(String(rel)) : `${repo}/${typeof rel === 'string' && rel !== '' ? rel : 'docs/architecture.md'}`

function cmdSettings(f: Flags): Obj {
  return settingsOf(repoOf(f))
}

function cmdPlanArgs(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const brief = readText(need(f, 'brief-file'))
  const fix = str(f, 'fix')
  if (fix !== undefined) readText(fix)
  const cfg = configOf(repo)
  return {
    foundry: {
      kind: 'plan', dir, repo, plugin: PLUGIN, schema: `${PLUGIN}/docs/plan.schema.json`, architecture: archPath(repo, cfg.architecture),
      maxParallelCrews: intOr(cfg.maxParallelCrews, 4, 1), repairBudget: intOr(cfg.repairBudget, 2, 0), roles: readRoles(PLUGIN),
      scriptPath: scriptPathFor(PLUGIN, 'plan.js', str(f, 'scripts-dir')),
    },
    brief,
  }
}

// The result text of the agent labelled `label` in a run: the last `result` journal line; a schema result is its `report` field.
function cmdPlanWrite(f: Flags): Obj {
  const dir = dirOf(f)
  const run_ = runOf(need(f, 'transcript'))
  const label = need(f, 'label')
  const ids = new Set(run_.journal.filter((l) => l.type === 'started' && l.label === label).map((l) => l.agentId))
  const results = run_.journal.filter((l) => l.type === 'result' && ids.has(l.agentId))
  if (results.length === 0) throw usage(`no result for an agent labelled ${label} in ${run_.dir}`)
  const raw = results[results.length - 1].result
  const message = typeof raw === 'string' ? raw : isObj(raw) && typeof raw.report === 'string' ? raw.report : JSON.stringify(raw)
  const no = (reason: string): never => { throw refuse({ written: false, reason }) }
  const json = fencedBlock(message, '````json plan.json')
  const md = fencedBlock(message, '````markdown plan.md')
  if (json === undefined || md === undefined) no(json === undefined ? 'no plan.json block' : 'no plan.md block')
  if (parsePlan(json as string) === undefined) no('the plan.json block is not a plan')
  const carried = JSON.parse((json as string).startsWith('﻿') ? (json as string).slice(1) : (json as string))
  if (!isObj(carried)) no('the plan.json block is not an object')
  if (existsSync(`${dir}/plan.json`)) {
    let existing
    try {
      existing = parsePlan(readFileSync(`${dir}/plan.json`, 'utf8'))
    } catch {
      return no('kept the existing plan: it could not be read')
    }
    if (existing === undefined) no('kept the existing plan: it is not a readable plan')
    else if (existing.approvedAt !== null) no('kept the existing plan: it is approved')
  }
  writeFileSync(`${dir}/plan.json`, JSON.stringify({ ...carried, approvedAt: null }, null, 2) + '\n')
  writeFileSync(`${dir}/plan.md`, md as string)
  return { written: true }
}

const SLUG = /^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$/
const literalOf = (g: string): string => g.slice(0, g.search(/[*?[]/) === -1 ? g.length : g.search(/[*?[]/))
const globsOverlap = (a: string, b: string): boolean => a === b || literalOf(a).startsWith(literalOf(b)) || literalOf(b).startsWith(literalOf(a))

function cmdPlanCheck(f: Flags): Obj {
  const plan = loadPlan(dirOf(f))
  const errors: string[] = []
  const crews: Obj[] = plan.crews.filter(isObj)
  const name = (c: Obj): string => (typeof c.slug === 'string' ? c.slug : '?')
  if (plan.version !== 2) errors.push('plan: version must be 2')
  const hasWave0 = crews.some((c) => c.wave === 0)
  if ((plan.approval === 'owner') !== hasWave0) errors.push(`plan: approval must be owner exactly when a wave-0 crew exists (approval ${JSON.stringify(plan.approval)}, wave-0 crews ${hasWave0 ? 'exist' : 'do not'})`)
  for (const c of crews) {
    const s = name(c)
    if (typeof c.slug !== 'string' || !SLUG.test(c.slug)) errors.push(`${s}: slug does not match the slug pattern`)
    else if (c.slug === 'foundry') errors.push(`${s}: foundry is a reserved slug`)
    if (plan.approvedAt === null && c.status !== 'planned') errors.push(`${s}: status must be planned on an unapproved plan, not ${JSON.stringify(c.status)}`)
  }
  for (let i = 0; i < crews.length; i++) {
    for (let j = i + 1; j < crews.length; j++) {
      if (crews[i].wave !== crews[j].wave) continue
      for (const ga of Array.isArray(crews[i].owns) ? crews[i].owns : []) {
        for (const gb of Array.isArray(crews[j].owns) ? crews[j].owns : []) {
          if (typeof ga === 'string' && typeof gb === 'string' && globsOverlap(ga, gb)) errors.push(`${name(crews[i])}: owns ${ga} overlaps ${name(crews[j])}'s ${gb} in wave ${crews[i].wave}`)
        }
      }
    }
  }
  if (errors.length > 0) throw refuse({ ok: false, errors })
  return { ok: true, unproved: crews.filter((c) => c.doneCheckProved === false).map(name) }
}

function cmdApprove(f: Flags): Obj {
  const dir = dirOf(f)
  const by = need(f, 'by')
  if (by !== 'owner' && by !== 'auto') throw usage('--by must be owner or auto')
  const repo = repoOf(f)
  const plan = loadPlan(dir)
  if (plan.approvedAt !== null && plan.approvedAt !== undefined) throw refuse({ error: `the plan is already approved (${String(plan.approvedAt)})` })
  const s = settingsOf(repo)
  const approvedAt = new Date().toISOString()
  savePlan(dir, { ...plan, approvedAt })
  appendDecision(dir, `plan approved (${by}): merge ${s.merge}, target ${s.target} from ${s.source}; approvedAt ${approvedAt}; scope frozen | the plan is approved by ${by}, so crews may start`)
  return { approvedAt }
}

function cmdCheck(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const cwd = flat(need(f, 'cwd'))
  const expect = need(f, 'expect')
  if (expect !== 'red' && expect !== 'green') throw usage('--expect must be red or green')
  const crew = loadPlan(dir).crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  if (typeof crew.doneCheck !== 'string' || crew.doneCheck === '') throw usage(`crew ${slug} has no doneCheck`)
  const scratch = mkdtempSync(`${tmpdir()}/factory-check-`)
  let text: string
  let exit: number
  try {
    const fd = openSync(`${scratch}/out.txt`, 'w')
    const r = spawnSync('bash', ['-c', crew.doneCheck], { cwd, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    if (r.error) throw usage(`cannot run bash in ${cwd}: ${r.error.message}`)
    exit = r.status ?? 1
    text = readFileSync(`${scratch}/out.txt`, 'utf8')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-40).join('\n')
  const head = gitOrFail(cwd, ['rev-parse', 'HEAD'])
  mkdirSync(`${dir}/checks`, { recursive: true })
  const used = readdirSync(`${dir}/checks`).map((n) => new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`).exec(n)?.[1]).filter((n) => n !== undefined).map(Number)
  const n = (used.length === 0 ? 0 : Math.max(...used)) + 1
  writeFileSync(`${dir}/checks/${slug}-${n}.json`, JSON.stringify({ command: crew.doneCheck, exit, head, tail }) + '\n', { flag: 'wx' })
  const ok = expect === 'red' ? exit !== 0 : exit === 0
  const body = { ok, exit, head, tail }
  if (!ok) throw refuse(body)
  return body
}

// The existing crew worktree for --slug, and the repo and target it belongs to.
function crewCtx(f: Flags): { dir: string; repo: string; slug: string; wt: string; target: string } {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const repo = repoOf(f)
  const wt = crewWorktree(repo, slug)
  if (!existsSync(wt)) throw usage(`no crew worktree for ${slug} at ${wt}`)
  return { dir, repo, slug, wt, target: settingsOf(repo).target }
}
// Runs a merge in the worktree; on conflict leaves it in progress and refuses with the conflicting paths.
function mergeIn(wt: string, args: string[]): Obj {
  const r = run(wt, ['merge', '--no-edit', ...args])
  if (r.status !== 0) {
    const conflicts = run(wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    if (conflicts.length === 0) throw usage(`git merge ${args.join(' ')} failed: ${r.err || r.out}`)
    throw refuse({ merged: false, conflicts })
  }
  return { merged: true, head: gitOrFail(wt, ['rev-parse', 'HEAD']) }
}
function cmdSync(f: Flags): Obj {
  const c = crewCtx(f)
  return mergeIn(c.wt, [c.target])
}
function cmdIntegrate(f: Flags): Obj {
  const branch = need(f, 'branch')
  const c = crewCtx(f)
  return mergeIn(c.wt, ['--no-ff', branch])
}
function cmdOwnsCheck(f: Flags): Obj {
  const c = crewCtx(f)
  const crew = loadPlan(c.dir).crews.find((x: Obj) => isObj(x) && x.slug === c.slug)
  if (crew === undefined) throw usage(`no crew ${c.slug} in the plan`)
  const owns: string[] = Array.isArray(crew.owns) ? crew.owns.filter((g: unknown) => typeof g === 'string') : []
  const files = gitOrFail(c.wt, ['diff', '--name-only', `${baseOf(c.wt, c.target)}...HEAD`]).split('\n').filter(Boolean)
  const outside = files.filter((file) => !owns.some((g) => path.matchesGlob(file, g)))
  if (outside.length > 0) throw refuse({ ok: false, outside })
  return { ok: true }
}

// ==== start ====

// A goal file's `## Heading` sections as {heading: text}; the text before the first heading is under "".
function goalSections(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key = ''
  let buf: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      out[key] = buf.join('\n').trim()
      key = m[1]
      buf = []
    } else buf.push(line)
  }
  out[key] = buf.join('\n').trim()
  return out
}
// The engine a goal file asks for: workflow only when `## Engine` starts with the word workflow; else lead with the reason.
function engineOf(sections: Record<string, string>, merge: string, noWorkflow: boolean): { engine: 'workflow' | 'lead'; reason: string } {
  if (merge === 'single') return { engine: 'lead', reason: 'merge mode single runs on the lead path' }
  if (noWorkflow) return { engine: 'lead', reason: 'no Workflow tool in this session' }
  const text = sections.Engine
  if (text === undefined || text === '') return { engine: 'lead', reason: 'the goal file has no ## Engine section' }
  const m = /^(\w+)[\s:,.\-]*([\s\S]*)$/.exec(text)
  if (m?.[1].toLowerCase() === 'workflow') return { engine: 'workflow', reason: '' }
  return { engine: 'lead', reason: (m?.[2] ?? '').trim() || 'the goal file says lead' }
}

// Creates the crew worktree on branch foundry-<slug> from the target head, or reuses it when it is already there.
function ensureWorktree(repo: string, slug: string, target: string): string {
  const wt = crewWorktree(repo, slug)
  if (existsSync(wt)) return wt
  mkdirSync(path.dirname(wt), { recursive: true })
  const branch = `foundry-${slug}`
  const exists = run(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).status === 0
  gitOrFail(repo, exists ? ['worktree', 'add', '-q', wt, branch] : ['worktree', 'add', '-q', '-b', branch, wt, target])
  return wt
}

function cmdStart(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  // start: resumes and stale rules go here
  if (f.resume !== undefined || f.slug !== undefined) throw usage('start --slug and --resume are not built yet')
  const waveArg = need(f, 'wave')
  const roles = rolesWithTypes(PLUGIN, listOf(f, 'type'))
  const noWorkflow = f['no-workflow'] === true
  const settings = settingsOf(repo)
  const plan = loadPlan(dir)
  const crews: Obj[] = plan.crews.filter(isObj)
  const open = crews.filter((c) => c.status === 'planned' || c.status === 'running').map((c) => c.wave).filter((w) => typeof w === 'number')
  if (open.length === 0) throw refuse({ error: 'no wave has a planned or running crew' })
  const next = Math.min(...open)
  if (waveArg !== 'next' && Number(waveArg) !== next) throw refuse({ error: `wave ${waveArg} is not the next wave: ${next}` })
  const cap = intOr(plan.maxParallelCrews, 4, 1)
  let slots = cap - crews.filter((c) => c.status === 'running').length
  const scriptPath = scriptPathFor(PLUGIN, 'wave.js', str(f, 'scripts-dir'))
  const arch = archPath(repo, plan.architecture)
  const adrDir = `${path.posix.dirname(arch)}/adr`
  const adrs = existsSync(adrDir) ? readdirSync(adrDir).filter((n) => n.endsWith('.md')).sort().map((n) => `${adrDir}/${n}`) : []
  const leads: Obj[] = []
  const refused: Obj[] = []
  const entries: Obj[] = []
  for (const crew of crews) {
    if (crew.wave !== next || crew.status !== 'planned') continue
    if (slots <= 0) break
    const slug = String(crew.slug)
    const goalFile = `${dir}/goals/${slug}.md`
    const text = existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : ''
    const sections = goalSections(text)
    const { engine, reason } = engineOf(sections, settings.merge, noWorkflow)
    if (engine === 'lead') {
      leads.push({ slug, reason })
      slots--
      continue
    }
    const verdict = planVerdict(parsePlan(JSON.stringify(plan)) as any, slug)
    if (verdict !== undefined) {
      refused.push({ slug, reason: verdict.deny })
      continue
    }
    const wt = ensureWorktree(repo, slug, settings.target)
    crew.status = 'running'
    savePlan(dir, plan)
    appendEvent(dir, { event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' })
    appendDecision(dir, `started workflow crew ${slug} in wave ${next} | worktree foundry-${slug} from ${settings.target}; the cap leaves ${slots - 1} slot(s)`)
    slots--
    entries.push({
      slug, wave: crew.wave, goalFile, goal: (sections[''] ?? '').replace(/^# .*\n?/, '').trim(), owns: crew.owns ?? [], doneCheck: crew.doneCheck ?? '',
      highImpact: (sections['High-impact paths'] ?? '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/`/g, '').trim()).filter((l) => l !== '' && !/^none\.?$/i.test(l)),
      redTeam: /^(yes|true)\b/i.test(sections['Red team'] ?? ''), scope: sections['Approved scope'] ?? '', worktree: wt, branch: `foundry-${slug}`,
      base: baseOf(wt, settings.target), architecture: arch, adrs, resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
    })
  }
  return {
    foundry: { kind: 'wave', dir, repo, plugin: PLUGIN, target: settings.target, repairBudget: intOr(plan.repairBudget, 2, 0), roles, scriptPath, crews: entries },
    leads, refused, stale: [], unfinished: [],
  }
}

// ==== finish ====

function cmdFinish(f: Flags): Obj {
  const repo = repoOf(f)
  need(f, 'transcript')
  if (settingsOf(repo).merge === 'single') throw usage('single merge mode runs on the lead path')
  // finish: record, audit and merge steps go here
  throw usage('finish not built yet')
}

// ==== main ====

const COMMANDS: Record<string, (f: Flags) => Obj> = {
  settings: cmdSettings, 'plan-args': cmdPlanArgs, 'plan-write': cmdPlanWrite, 'plan-check': cmdPlanCheck, approve: cmdApprove, start: cmdStart,
  sync: cmdSync, check: cmdCheck, integrate: cmdIntegrate, 'owns-check': cmdOwnsCheck, finish: cmdFinish,
}

// Runs one command and returns what it printed and its exit code.
export function main(argv: string[]): { body: Obj; code: number } {
  try {
    const [command, ...rest] = argv
    const fn = command === undefined ? undefined : COMMANDS[command]
    if (fn === undefined) throw usage(`unknown command: ${command ?? '(none)'}; commands: ${Object.keys(COMMANDS).join(', ')}`)
    return { body: fn(parseFlags(rest)), code: 0 }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}

const isMain = ((): boolean => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return false
  }
})()
if (isMain) {
  const { body, code } = main(process.argv.slice(2))
  process.stdout.write(JSON.stringify(body) + '\n')
  process.exitCode = code
}
