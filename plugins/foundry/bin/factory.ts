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

type StartCtx = { dir: string; repo: string; roles: Obj; settings: { merge: string; target: string; source: string }; plan: Obj; scriptPath: string; arch: string; adrs: string[] }
const NEED_TRANSCRIPT = 'start needs --transcript T (a Workflow run dir; the runs root is its parent) to read the runs of this session'

// A crew entry for wave.js; `resume`, `tasks`, `done` and `answers` are the restart facts (fresh start: null and empty).
function crewEntry(c: StartCtx, crew: Obj, wt: string, extra: { resume: string | null; tasks?: unknown[]; done?: string[]; answers?: unknown[] }): Obj {
  const slug = String(crew.slug)
  const goalFile = `${c.dir}/goals/${slug}.md`
  const sections = goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '')
  return {
    slug, wave: crew.wave, goalFile, goal: (sections[''] ?? '').replace(/^# .*\n?/, '').trim(), owns: crew.owns ?? [], doneCheck: crew.doneCheck ?? '',
    highImpact: (sections['High-impact paths'] ?? '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/`/g, '').trim()).filter((l) => l !== '' && !/^none\.?$/i.test(l)),
    redTeam: /^(yes|true)\b/i.test(sections['Red team'] ?? ''), scope: sections['Approved scope'] ?? '', worktree: wt, branch: `foundry-${slug}`,
    base: baseOf(wt, c.settings.target), architecture: c.arch, adrs: c.adrs, resume: extra.resume, tasks: extra.tasks ?? [], done: extra.done ?? [], answers: extra.answers ?? [],
    spent: spentOf(c.dir, slug), labelFrom: labelFromOf(c.dir, slug),
  }
}
function waveOut(c: StartCtx, entries: Obj[], leads: Obj[], refused: Obj[], stale: Obj[], unfinished: Obj[]): Obj {
  return {
    foundry: { kind: 'wave', dir: c.dir, repo: c.repo, plugin: PLUGIN, target: c.settings.target, repairBudget: intOr(c.plan.repairBudget, 2, 0), roles: c.roles, scriptPath: c.scriptPath, crews: entries },
    leads, refused, stale, unfinished,
  }
}

// The runs of this session: the dirs next to the transcript dir T (T's parent is the runs root).
const runsNextTo = (transcript: string): WfRun[] => runsOf(path.dirname(flat(transcript).replace(/\/+$/, '')))
const eventsOf = (dir: string): Obj[] => (existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : [])

type CrewState = { kind: 'none' } | { kind: 'unfinished'; run: string | null } | { kind: 'returned' } | { kind: 'live' } | { kind: 'stale'; wfRun: WfRun | undefined; since: string }
// The state of a running workflow crew, read from files (ADR-0009 "start, stale runs"); `none` when rule 1 fails.
// runs undefined means no --transcript was given: nothing can be read, so the crew fails closed as unfinished.
function crewState(dir: string, crew: Obj, runs: WfRun[] | undefined, events: Obj[], now: number): CrewState {
  const slug = String(crew.slug)
  const spawn = factorySpawned(dir, slug)
  if (crew.status !== 'running' || spawn === undefined) return { kind: 'none' }
  if (runs === undefined) return { kind: 'unfinished', run: null }
  const holding = runs.filter((r) => r.agents.some((a) => parseLabel(a.label)?.slug === slug)).sort((a, b) => newestMtime(a.dir) - newestMtime(b.dir) || (a.id < b.id ? -1 : 1))
  const newest = holding[holding.length - 1]
  if (newest !== undefined) {
    if (!events.some((e) => e.event === 'spawn' && e.crew === slug && e.by === `workflow:${newest.id}`)) return { kind: 'unfinished', run: newest.id }
    if (!events.some((e) => e.event === 'incomplete' && e.crew === slug && e.run === newest.id)) return { kind: 'returned' }
  }
  if (isLive(String(spawn.ts), newest?.dir, now)) return { kind: 'live' }
  return { kind: 'stale', wfRun: newest, since: String(spawn.ts) }
}

// The tasks of the highest-numbered `<slug>-planner*` result in a run.
function plannerTasks(wfRun: WfRun | undefined, slug: string): unknown[] {
  let best = 0
  let tasks: unknown[] = []
  for (const a of wfRun?.agents ?? []) {
    const p = parseLabel(a.label)
    if (p === undefined || p.slug !== slug || p.role !== 'planner' || !a.hasResult || p.n < best) continue
    let r = a.result
    if (typeof r === 'string') {
      try {
        r = JSON.parse(r)
      } catch {
        continue
      }
    }
    if (isObj(r) && Array.isArray(r.tasks)) {
      best = p.n
      tasks = r.tasks
    }
  }
  return tasks
}
// Names of the tasks whose member result is DONE and whose branch is an ancestor of the crew branch (git decides, not the report).
function doneTasks(wfRun: WfRun | undefined, slug: string, wt: string): string[] {
  const done: string[] = []
  for (const a of wfRun?.agents ?? []) {
    const r = a.result
    if (parseLabel(a.label)?.slug !== slug || !isObj(r) || r.marker !== 'DONE' || typeof r.branch !== 'string' || typeof r.task !== 'string') continue
    if (run(wt, ['merge-base', '--is-ancestor', r.branch, `foundry-${slug}`]).status === 0 && !done.includes(r.task)) done.push(r.task)
  }
  return done
}

// start --slug S --resume answers|merge-ready|stale: one crew entry, or a refusal {slug, why}.
function cmdStartResume(f: Flags, c: StartCtx, slug: string, kind: string): Obj {
  if (!['answers', 'merge-ready', 'stale'].includes(kind)) throw usage(`--resume needs answers, merge-ready or stale, got ${kind}`)
  const transcript = str(f, 'transcript') ?? ''
  if ((kind === 'answers' || kind === 'stale') && transcript === '') throw usage(`--resume ${kind} needs --transcript T: ${NEED_TRANSCRIPT}`)
  let answers: unknown[] = []
  if (kind === 'answers') {
    const a = readJson(need(f, 'answers'))
    if (!Array.isArray(a) || !a.every((x) => isObj(x) && typeof x.at === 'string' && typeof x.text === 'string')) throw usage('--answers must be a JSON array of {"at","text"}')
    answers = a
  }
  const crew = c.plan.crews.find((x: unknown) => isObj(x) && x.slug === slug)
  if (crew === undefined || crew.status !== 'running' || factorySpawned(c.dir, slug) === undefined) throw refuse({ slug, why: kind === 'stale' ? 'not stale' : 'not restartable' })
  let wfRun: WfRun | undefined
  if (kind === 'stale') {
    const st = crewState(c.dir, crew, runsNextTo(transcript), eventsOf(c.dir), Date.now())
    if (st.kind === 'returned' || st.kind === 'none') throw refuse({ slug, why: 'not stale' })
    if (st.kind === 'unfinished') throw refuse({ slug, why: 'run not finished' })
    if (st.kind === 'live') throw refuse({ slug, why: 'run may be live' })
    wfRun = st.wfRun
  } else if (kind === 'answers') wfRun = runOf(transcript)
  const wt = ensureWorktree(c.repo, slug, c.settings.target)
  // A stale crew whose branch has no commit beyond the base starts from step 1.
  const noWork = kind === 'stale' && Number(run(wt, ['rev-list', '--count', `${baseOf(wt, c.settings.target)}..HEAD`]).out) === 0
  const rebuild = kind !== 'merge-ready' && !noWork
  const entry = crewEntry(c, crew, wt, { resume: kind, tasks: rebuild ? plannerTasks(wfRun, slug) : [], done: rebuild ? doneTasks(wfRun, slug, wt) : [], answers })
  if (kind === 'stale') {
    appendEvent(c.dir, { event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' })
    appendDecision(c.dir, `restarted stale workflow crew ${slug} | its wave.js run died; same worktree and branch; ${entry.spent} repair round(s) already spent`)
  }
  return waveOut(c, [entry], [], [], [], [])
}

function cmdStart(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const roles = rolesWithTypes(PLUGIN, listOf(f, 'type'))
  const settings = settingsOf(repo)
  const plan = loadPlan(dir)
  const scriptPath = scriptPathFor(PLUGIN, 'wave.js', str(f, 'scripts-dir'))
  const arch = archPath(repo, plan.architecture)
  const adrDir = `${path.posix.dirname(arch)}/adr`
  const adrs = existsSync(adrDir) ? readdirSync(adrDir).filter((n) => n.endsWith('.md')).sort().map((n) => `${adrDir}/${n}`) : []
  const ctx: StartCtx = { dir, repo, roles, settings, plan, scriptPath, arch, adrs }
  const slugFlag = str(f, 'slug')
  const resumeFlag = str(f, 'resume')
  if (slugFlag !== undefined || resumeFlag !== undefined) {
    if (!slugFlag || !resumeFlag) throw usage('start --slug and --resume go together')
    return cmdStartResume(f, ctx, slugFlag, resumeFlag)
  }
  const waveArg = need(f, 'wave')
  const noWorkflow = f['no-workflow'] === true
  const crews: Obj[] = plan.crews.filter(isObj)
  const open = crews.filter((c) => c.status === 'planned' || c.status === 'running').map((c) => c.wave).filter((w) => typeof w === 'number')
  if (open.length === 0) throw refuse({ error: 'no wave has a planned or running crew' })
  const next = Math.min(...open)
  if (waveArg !== 'next' && Number(waveArg) !== next) throw refuse({ error: `wave ${waveArg} is not the next wave: ${next}` })
  const cap = intOr(plan.maxParallelCrews, 4, 1)
  let slots = cap - crews.filter((c) => c.status === 'running').length
  const wasRunning = crews.filter((c) => c.status === 'running')
  const leads: Obj[] = []
  const refused: Obj[] = []
  const entries: Obj[] = []
  for (const crew of crews) {
    if (crew.wave !== next || crew.status !== 'planned') continue
    if (slots <= 0) break
    const slug = String(crew.slug)
    const goalFile = `${dir}/goals/${slug}.md`
    const sections = goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '')
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
    entries.push(crewEntry(ctx, crew, wt, { resume: null }))
  }
  // Running workflow crews that were already running before this call. --transcript T names the runs root (its parent); without it nothing can be read.
  const transcript = str(f, 'transcript')
  const runs = transcript ? runsNextTo(transcript) : undefined
  const events = eventsOf(dir)
  const stale: Obj[] = []
  const unfinished: Obj[] = []
  for (const crew of wasRunning) {
    const st = crewState(dir, crew, runs, events, Date.now())
    if (st.kind === 'stale') stale.push({ slug: crew.slug, since: st.since })
    else if (st.kind === 'unfinished') unfinished.push({ slug: crew.slug, run: st.run })
  }
  return waveOut(ctx, entries, leads, refused, stale, unfinished)
}

// ==== finish ====

import { utimesSync } from 'node:fs'
import { NO_HEAD_REASON, NO_PASS_REASON, PATCH_COMMAND, family, headVerdict, judgeRuling, latestJudge, markerOf, patchIdOf, planAtLeastV2, runStart } from '../hooks/register.ts'
import type { JudgeRuling } from '../hooks/register.ts'

// The merge step's head rule (ADR-0009 step 3), failing closed. headVerdict is fail-open for the stop gate (it passes an undefined head
// or patch, and a plan below v2), so this refuses first when the judge, head or patch is missing, whatever the plan version, and then
// asks headVerdict about a v2 view of the plan. Returns {block} to refuse, undefined when the PASS stands.
export function mergeHeadVerdict(plan: any, judge: JudgeRuling | undefined, head: string | undefined, patch: string | undefined): { block: string } | undefined {
  if (judge === undefined || judge.verdict !== 'PASS' || judge.unscoped > 0) return { block: NO_PASS_REASON }
  if (judge.head === undefined || judge.patch === undefined) return { block: NO_HEAD_REASON }
  if (head === undefined || patch === undefined) return { block: 'Refused: patch id unavailable: the merged head or its patch id could not be computed.' }
  return headVerdict(planAtLeastV2(plan) ? plan : { ...(isObj(plan) ? plan : {}), version: 2 }, judge, head, patch)
}

type Audit = { label: string; why: string; slug?: string }

const textOfResult = (r: unknown): string | undefined => {
  if (typeof r === 'string') return r
  if (isObj(r) && typeof r.report === 'string') return r.report
  return r === undefined ? undefined : JSON.stringify(r)
}

// Record step: files each crew agent's result under reports/, appends spawn and report lines (once), and audits every agent of the run.
function recordRun(dir: string, wfRun: WfRun, crewSlugs: Set<string>, roles: Obj): Audit[] {
  const audits: Audit[] = []
  const events = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
  for (const a of wfRun.agents) {
    const parsed = parseLabel(a.label)
    const facts = transcriptFacts(a.transcript)
    const agentType = typeof a.meta?.agentType === 'string' ? a.meta.agentType : undefined
    const slug = parsed !== undefined && crewSlugs.has(parsed.slug) ? parsed.slug : undefined
    const bad = (why: string): void => void audits.push({ label: a.label, why, ...(slug !== undefined ? { slug } : {}) })
    if (a.meta === undefined || typeof a.meta.model !== 'string' || a.meta.model === '') bad('the meta file has no model')
    const fam = family(facts.model)
    if (fam !== 'opus' && fam !== 'sonnet') bad(`the transcript model family is ${fam}, not opus or sonnet`)
    if (facts.effort === 'max') bad('effort max')
    if ((facts.effort === 'high' || facts.effort === 'xhigh') && parsed !== undefined) bad(`effort ${facts.effort} on role ${parsed.role}`)
    if (parsed !== undefined && (parsed.role === 'judge' || parsed.role === 'redteam') && agentType !== 'foundry:judge') bad(`${parsed.role} ran as ${agentType ?? 'an unknown type'}, not foundry:judge`)
    if (parsed !== undefined && parsed.role === 'judge' && facts.tools.some((t) => t.name === 'Write' || t.name === 'Edit')) bad('a judge used Write or Edit')
    if (parsed === undefined) {
      bad('the label does not parse as <slug>-<role>')
      continue
    }
    if (slug === undefined) {
      bad(`the label names no running factory crew (slug ${parsed.slug})`)
      continue
    }
    if (!isObj(roles[parsed.role])) {
      bad(`unknown role ${parsed.role}`)
      continue
    }
    if (!a.hasResult) continue
    const text = textOfResult(a.result)
    if (text === undefined) continue
    const file = `${dir}/reports/${slug}/${a.label}.md`
    mkdirSync(`${dir}/reports/${slug}`, { recursive: true })
    if (existsSync(file) && readFileSync(file, 'utf8') !== text) {
      bad('a report file with different text already exists; not overwritten')
    } else {
      if (!existsSync(file)) writeFileSync(file, text)
      const when = facts.lastTs === undefined ? NaN : Date.parse(facts.lastTs)
      if (Number.isFinite(when)) utimesSync(file, when / 1000, when / 1000)
    }
    const by = `workflow:${wfRun.id}`
    if (!events.some((e) => e.event === 'spawn' && e.agentId === a.agentId && e.by === by)) {
      appendEvent(dir, { event: 'spawn', crew: slug, agent: a.label, agentId: a.agentId, type: agentType ?? 'general-purpose', model: facts.model ?? null, effort: facts.effort ?? null, by })
    }
    const marker = markerOf(text)
    if (!events.some((e) => e.event === 'report' && e.crew === slug && e.agent === a.label && (e.marker ?? null) === marker)) {
      appendEvent(dir, { event: 'report', crew: slug, agent: a.label, marker })
    }
  }
  return audits
}

// Session audit: every Workflow run of the session at or after the run start, in scope as ADR-0009 "finish, session audit" says.
function sessionAudit(dir: string, rootDir: string, thisRunId: string, factorySlugs: Set<string>, waived: Set<string>): Audit[] {
  const audits: Audit[] = []
  const log = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
  const starts = [...log.matchAll(/^## Run (\S+)/gm)].map((m) => Date.parse(m[1] ?? '')).filter((n) => Number.isFinite(n))
  const start = starts.length === 0 ? undefined : Math.max(...starts)
  for (const r of runsOf(rootDir)) {
    if (waived.has(r.id)) continue
    const firsts = r.agents.map((a) => Date.parse(transcriptFacts(a.transcript).firstTs ?? '')).filter((n) => Number.isFinite(n))
    if (start !== undefined && firsts.length > 0 && Math.min(...firsts) < start) continue
    const foundryRun = r.agents.every((a) => {
      const p = parseLabel(a.label)
      return p !== undefined && (p.slug === 'foundry' || factorySlugs.has(p.slug))
    })
    const typeOf = (a: RunAgent): string => (typeof a.meta?.agentType === 'string' ? a.meta.agentType : '')
    if (!foundryRun && !r.agents.some((a) => typeOf(a).startsWith('foundry:'))) continue
    for (const a of r.agents) {
      const label = `${r.id}/${a.label}`
      if (!foundryRun && typeOf(a).startsWith('foundry:')) audits.push({ label, why: `${typeOf(a)} agent in a run that is not foundry's` })
      if (typeof a.meta?.model !== 'string' || a.meta.model === '') audits.push({ label, why: 'the meta file has no model' })
      else {
        const fam = family(transcriptFacts(a.transcript).model)
        if (fam !== 'opus' && fam !== 'sonnet') audits.push({ label, why: `the transcript model family is ${fam}, not opus or sonnet` })
      }
    }
  }
  return audits
}

// The git worktrees of the repo as {path, branch}.
function worktreesOf(repo: string): { path: string; branch: string | undefined }[] {
  const out: { path: string; branch: string | undefined }[] = []
  for (const block of run(repo, ['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const p = lines.find((l) => l.startsWith('worktree '))
    if (p === undefined) continue
    const b = lines.find((l) => l.startsWith('branch '))
    out.push({ path: flat(p.slice('worktree '.length)), branch: b === undefined ? undefined : b.slice('branch refs/heads/'.length) })
  }
  return out
}

// The patch id of base...head by PATCH_COMMAND, or undefined when the diff or patch-id fails or is empty.
function patchOf(wt: string, base: string, head: string): string | undefined {
  const [diffCmd, idCmd] = PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', head).split(' '))
  if (diffCmd === undefined || idCmd === undefined) return undefined
  const d = spawnSync(diffCmd[0] as string, diffCmd.slice(1), { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 29 })
  if (d.error || d.status !== 0) return undefined
  const p = spawnSync(idCmd[0] as string, idCmd.slice(1), { cwd: wt, input: d.stdout, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (p.error || p.status !== 0) return undefined
  return patchIdOf(p.stdout)
}

// The lowest-numbered D/checks/<slug>-<n>.json: the red record. undefined when none.
function redRecord(dir: string, slug: string): Obj | undefined {
  const d = `${dir}/checks`
  if (!existsSync(d)) return undefined
  const re = new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`)
  const found = readdirSync(d).flatMap((n) => {
    const m = re.exec(n)
    return m?.[1] === undefined ? [] : [{ n: Number(m[1]), name: n }]
  }).sort((x, y) => x.n - y.n)[0]
  if (found === undefined) return undefined
  try {
    const v = JSON.parse(readFileSync(`${d}/${found.name}`, 'utf8'))
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

type Outcome = { merged?: true; rework?: string; blocked?: string; refused?: string }

// Merge step for one crew whose newest judge is a clean PASS (ADR-0009 steps 1 to 5). Fails closed: any doubt is a refusal.
function mergeCrew(f: Flags, dir: string, repo: string, target: string, crew: Obj, ruling: JudgeRuling, audits: Audit[], fails: number): Outcome {
  const slug: string = crew.slug
  const wt = crewWorktree(repo, slug)
  const plan = loadPlan(dir)
  // step 1: gates
  const named = audits.filter((a) => a.slug === slug)
  if (named.length > 0) return { refused: `audit: ${named.map((a) => `${a.label} (${a.why})`).join('; ')}` }
  if (!existsSync(wt)) return { refused: `no crew worktree at ${wt}` }
  try {
    cmdOwnsCheck({ ...f, dir, repo, slug })
  } catch (e) {
    return { refused: e instanceof CliError && Array.isArray(e.body.outside) ? `owns-check: outside ${(e.body.outside as string[]).join(', ')}` : `owns-check failed: ${(e as Error).message}` }
  }
  const budget = intOr(plan.repairBudget, 2, 0)
  if (fails > budget) return { refused: `repair budget spent: ${fails} judge FAILs, budget ${budget}` }
  const red = redRecord(dir, slug)
  if (red === undefined || !Number.isInteger(red.exit) || red.exit === 0) return { refused: 'no red record: the lowest-numbered checks file is missing or has exit 0' }
  if (run(wt, ['rev-parse', `refs/heads/foundry-${slug}`]).out !== run(wt, ['rev-parse', 'HEAD']).out) return { refused: `the crew worktree is not on branch foundry-${slug}` }
  // step 2: resolve the target once, fully qualified (a same-named tag must not win), and merge that commit in, never a rebase
  const targetRef = `refs/heads/${target}`
  const resolved = run(repo, ['rev-parse', '--verify', `${targetRef}^{commit}`])
  if (resolved.status !== 0 || resolved.out === '') return { refused: `target branch ${target} does not resolve` }
  const oldSha = resolved.out
  const m = run(wt, ['merge', '--no-edit', oldSha])
  if (m.status !== 0) {
    const conflict = run(wt, ['diff', '--name-only', '--diff-filter=U']).out !== ''
    run(wt, ['merge', '--abort'])
    return conflict ? { rework: 'conflict' } : { refused: `git merge ${target} failed: ${m.err || m.out}` }
  }
  // step 3: the patch is always computed on the merged head, against the target head just merged in
  const head = run(wt, ['rev-parse', 'HEAD']).out
  const base = run(wt, ['merge-base', oldSha, 'HEAD']).out
  const patch = head === '' || base === '' ? undefined : patchOf(wt, base, head)
  if (ruling.head === undefined || ruling.patch === undefined || head === '' || patch === undefined) return { refused: 'patch id unavailable' }
  if (mergeHeadVerdict(plan, ruling, head, patch) !== undefined) return { rework: 'rejudge' }
  if (head !== ruling.head) {
    try {
      cmdCheck({ dir, slug, cwd: wt, expect: 'green' })
    } catch {
      return { rework: 'rejudge' }
    }
  }
  // step 4: fast-forward the target
  const onTarget = worktreesOf(repo).find((w) => w.branch === target)
  if (onTarget !== undefined) {
    const dirty = run(onTarget.path, ['status', '--porcelain', '--untracked-files=no']).out
    if (dirty !== '') return { blocked: `target checked out dirty: ${dirty.split('\n')[0]?.trim().replace(/^\S+\s+/, '')}` }
    if (run(onTarget.path, ['rev-parse', 'HEAD']).out !== oldSha) return { rework: 'target moved' }
    if (run(onTarget.path, ['merge', '--ff-only', `refs/heads/foundry-${slug}`]).status !== 0) return { rework: 'target moved' }
  } else if (run(repo, ['update-ref', targetRef, head, oldSha]).status !== 0) return { rework: 'target moved' }
  // step 5: record, then clean up
  const fresh = loadPlan(dir)
  const entry = fresh.crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (entry !== undefined) entry.status = 'merged'
  savePlan(dir, fresh)
  appendDecision(dir, `crew ${slug} merged into ${target} at ${head} | judge PASS on ${ruling.head}, red record exit ${red.exit}, patch ${patch}, done-check green on the merged head`)
  const own = new Set(fresh.crews.filter(isObj).map((c: Obj) => `foundry-${c.slug}`))
  for (const w of worktreesOf(repo)) {
    if (w.path === wt || w.branch === undefined || own.has(w.branch) || !w.branch.startsWith(`foundry-${slug}-`)) continue
    if (run(repo, ['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/foundry-${slug}`]).status === 0) run(repo, ['worktree', 'remove', w.path])
  }
  run(repo, ['worktree', 'remove', wt])
  return { merged: true }
}

function cmdFinish(f: Flags): Obj {
  const repo = repoOf(f)
  need(f, 'transcript')
  const settings = settingsOf(repo)
  if (settings.merge === 'single') throw usage('single merge mode runs on the lead path')
  const dir = dirOf(f)
  const tdir = flat(need(f, 'transcript')).replace(/\/+$/, '')
  const resultPath = str(f, 'result')
  let results: Obj[] | undefined
  if (resultPath !== undefined) {
    const v = readJson(flat(resultPath))
    if (!Array.isArray(v)) throw usage('--result must hold the JSON array wave.js returned')
    results = v.filter(isObj)
  }
  const plan = loadPlan(dir)
  const roles = readRoles(PLUGIN)
  const wfRun = runOf(tdir)
  const factoryCrews: Obj[] = plan.crews.filter((c: Obj) => isObj(c) && typeof c.slug === 'string' && c.status === 'running' && factorySpawned(dir, c.slug) !== undefined)
  const factorySlugs = new Set(factoryCrews.map((c) => c.slug as string))
  const inRun = factoryCrews.filter((c) => wfRun.agents.some((a) => parseLabel(a.label)?.slug === c.slug))
  const out = { merged: [] as string[], rework: [] as Obj[], blocked: [] as Obj[], refused: [] as Obj[], audit: [] as Obj[], incomplete: [] as string[] }
  const finishWith = (): Obj => {
    const body = { merged: out.merged, rework: out.rework, blocked: out.blocked, refused: out.refused, audit: out.audit, incomplete: out.incomplete }
    if (out.refused.length > 0 || out.rework.length > 0 || out.blocked.length > 0 || out.audit.length > 0) throw refuse(body)
    return body
  }

  if (results === undefined) {
    // no result: the liveness rule first, writing nothing while it fails
    const now = Date.now()
    for (const c of inRun) if (isLive(factorySpawned(dir, c.slug)?.ts ?? now, tdir, now)) out.refused.push({ slug: c.slug, why: 'run may be live' })
    if (out.refused.length > 0) return finishWith()
  }

  const audits = recordRun(dir, wfRun, factorySlugs, roles)
  for (const a of audits) out.audit.push({ label: a.label, why: a.why })

  if (results === undefined) {
    const have = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
    for (const c of inRun) {
      if (!have.some((e) => e.event === 'incomplete' && e.crew === c.slug && e.run === wfRun.id)) appendEvent(dir, { event: 'incomplete', crew: c.slug, agent: c.slug, run: wfRun.id })
      out.incomplete.push(c.slug)
    }
    return finishWith()
  }

  // session audit: while an entry stands, nothing merges
  const log = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
  const waived = new Set([...log.matchAll(/^- [^|]*\|\s*audit waived: ([A-Za-z0-9._-]+)/gm)].map((m) => m[1] as string))
  const stand = sessionAudit(dir, path.dirname(tdir), wfRun.id, new Set(plan.crews.filter((c: Obj) => isObj(c) && factorySpawned(dir, c.slug) !== undefined).map((c: Obj) => c.slug as string)), waived)
  for (const a of stand) if (!out.audit.some((x) => x.label === a.label && x.why === a.why)) out.audit.push({ label: a.label, why: a.why })
  if (stand.length > 0) {
    const what = `session audit stands, nothing merged: ${stand.map((a) => `${a.label} (${a.why})`).join('; ')}`
    if (!log.includes(what)) appendDecision(dir, `${what} | the owner rules, then a decision line "audit waived: <run id>" or the offending run goes`)
    for (const c of inRun) out.refused.push({ slug: c.slug, why: 'session audit' })
    return finishWith()
  }

  const since = runStart(plan) ?? 0
  for (const c of inRun) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined || res.state !== 'passed') continue
    const files = reportsOf(dir, c.slug)
    const newest = latestJudge(c.slug, files, since)
    const ruling = newest === undefined ? undefined : judgeRuling(newest.text)
    if (ruling === undefined || ruling.verdict !== 'PASS' || ruling.unscoped > 0) continue
    const r = mergeCrew(f, dir, repo, settings.target, c, ruling, audits, judgeFails(c.slug, files, since))
    if (r.merged) out.merged.push(c.slug)
    else if (r.rework !== undefined) out.rework.push({ slug: c.slug, why: r.rework })
    else if (r.blocked !== undefined) out.blocked.push({ slug: c.slug, why: r.blocked })
    else out.refused.push({ slug: c.slug, why: r.refused ?? 'refused' })
  }
  return finishWith()
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
