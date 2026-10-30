// @ts-nocheck
// Shared harness for the factory CLI tests (foundry ADR-0009): tests/factory.check.ts and the *.cases.ts files in this
// folder import it. Node built-ins only. Every helper is documented by the comment above it.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/')
/** The real plugin dir (plugins/foundry) of this checkout, forward slashes. */
export const REAL_PLUGIN = resolve(HERE, '../../..').replace(/\\/g, '/')
/** The real checkout root. */
export const REAL_REPO = resolve(REAL_PLUGIN, '../..').replace(/\\/g, '/')
export const REAL_FACTORY = `${REAL_PLUGIN}/bin/factory.ts`
export const SCHEMA_PATH = `${REAL_PLUGIN}/docs/events.schema.json`

/** Forward-slash form of a path, for comparing what the CLI prints with what a test built. */
export const flat = (p: string): string => String(p).replace(/\\/g, '/')

const temps: string[] = []
process.on('exit', () => {
  for (const t of temps) {
    try {
      rmSync(t, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})

/** A fresh temp dir (removed when the test process exits); forward slashes. */
export function tmp(prefix = 'fcli-'): string {
  const d = flat(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(d)
  return d
}

/** Runs git in `cwd`, returns trimmed stdout; throws with stderr when git exits non-zero unless `allowFail`. */
export function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
  return (r.stdout ?? '').trim()
}

/** Git exit status only (for probes such as `rev-parse -q --verify MERGE_HEAD`). */
export function gitStatus(cwd: string, args: string[]): number {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status ?? -1
}

/** HEAD sha of `cwd`. */
export const head = (cwd: string): string => git(cwd, ['rev-parse', 'HEAD'])

/** Writes `rel` (creating dirs) under `root`, optionally committing it with message `msg`; returns the new HEAD when committed. */
export function putFile(root: string, rel: string, text: string, msg?: string): string | undefined {
  const p = `${root}/${rel}`
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  if (msg === undefined) return undefined
  git(root, ['add', '--', rel])
  git(root, ['commit', '-q', '-m', msg])
  return head(root)
}

/** A temp git repo: `git init -b main`, local user.name/email, an initial commit holding README.md (plus `.claude/foundry.json` when `config` is given and any `files` {path: text}, all committed). */
export function mkRepo(opts: { config?: unknown; files?: Record<string, string> } = {}): string {
  const repo = tmp('fcli-repo-')
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Test Writer'])
  git(repo, ['config', 'user.email', 'tw@example.invalid'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(`${repo}/README.md`, 'readme\n')
  if (opts.config !== undefined) {
    mkdirSync(`${repo}/.claude`, { recursive: true })
    writeFileSync(`${repo}/.claude/foundry.json`, JSON.stringify(opts.config, null, 2) + '\n')
  }
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(`${repo}/${rel}`), { recursive: true })
    writeFileSync(`${repo}/${rel}`, text)
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  return repo
}

/** Adds the crew worktree `<repo>/.claude/worktrees/foundry-<slug>` on branch `foundry-<slug>` from `from` (default main); returns its path. */
export function addCrewWorktree(repo: string, slug: string, from = 'main'): string {
  const wt = `${repo}/.claude/worktrees/foundry-${slug}`
  git(repo, ['worktree', 'add', '-q', '-b', `foundry-${slug}`, wt, from])
  git(wt, ['config', 'user.name', 'Test Writer'])
  git(wt, ['config', 'user.email', 'tw@example.invalid'])
  return wt
}

/** A plan crew entry with schema-valid defaults (wave 1, verdict change, owns src/<slug>/**, doneCheck "true", proved, planned). */
export function crew(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug, wave: 1, verdict: 'change', modules: [slug], owns: [`src/${slug}/**`], doneCheck: 'true', doneCheckProved: true, estAgents: 1, status: 'planned', ...over }
}

/** A plan object (version 2, approval auto, approvedAt now, maxParallelCrews 4, repairBudget 2) with `over` laid on top. For an unapproved plan pass `approvedAt: null, approval: 'owner'` and include a wave-0 `verdict: 'design'` crew. */
export function planObj(crews: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 2, goal: 'test goal', architecture: 'docs/architecture.md', approval: 'auto', approvedAt: new Date().toISOString(), maxParallelCrews: 4, repairBudget: 2, crews, ...over }
}

/** A temp foundry dir (with reports/, checks/ and goals/ made on use, plus empty decisions.md and events.jsonl). */
export function mkFoundryDir(): string {
  const d = tmp('fcli-fdir-')
  writeFileSync(`${d}/decisions.md`, '')
  writeFileSync(`${d}/events.jsonl`, '')
  return d
}

/** Writes `<dir>/plan.json` (2-space JSON, trailing newline). */
export function writePlan(dir: string, plan: unknown): void {
  writeFileSync(`${dir}/plan.json`, JSON.stringify(plan, null, 2) + '\n')
}

/** Reads `<dir>/plan.json` parsed. */
export const readPlan = (dir: string): any => JSON.parse(readFileSync(`${dir}/plan.json`, 'utf8'))

/** Writes `<dir>/goals/<slug>.md` with `## Approved scope`, `## High-impact paths`, `## Red team` and `## Engine` sections (defaults: scope text, no paths, "no", "workflow"). */
export function writeGoal(dir: string, slug: string, s: { goal?: string; scope?: string; highImpact?: string; redTeam?: string; engine?: string } = {}): string {
  mkdirSync(`${dir}/goals`, { recursive: true })
  const text = `# Goal: ${slug}\n\n${s.goal ?? `Build ${slug}.`}\n\n## Approved scope\n\n${s.scope ?? `Build ${slug} only.`}\n\n## High-impact paths\n\n${s.highImpact ?? 'None.'}\n\n## Red team\n\n${s.redTeam ?? 'no'}\n\n## Engine\n\n${s.engine ?? 'workflow'}\n`
  writeFileSync(`${dir}/goals/${slug}.md`, text)
  return `${dir}/goals/${slug}.md`
}

/** Appends one event object as a JSON line to `<dir>/events.jsonl`. */
export function appendEvent(dir: string, ev: Record<string, unknown>): void {
  appendFileSync(`${dir}/events.jsonl`, JSON.stringify(ev) + '\n')
}

/** Every parsed line of `<dir>/events.jsonl`. */
export function readEvents(dir: string): any[] {
  const p = `${dir}/events.jsonl`
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

/** The factory's own spawn line for a crew, as `start` writes it (ts defaults to now). */
export function factorySpawn(slug: string, ts = new Date().toISOString()): Record<string, unknown> {
  return { v: 1, ts, event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' }
}

/** A judge report body: first line the verdict, `## Findings` with `unscoped` UNSCOPED lines, `## Proof checked` with Head:/Patch: lines when given. */
export function judgeReport(o: { verdict?: 'PASS' | 'FAIL' | null; head?: string; patch?: string; unscoped?: number } = {}): string {
  const lines: string[] = []
  if (o.verdict !== null) lines.push(`VERDICT: ${o.verdict ?? 'PASS'}`, '')
  lines.push('## Findings')
  for (let i = 0; i < (o.unscoped ?? 0); i++) lines.push(`- UNSCOPED: stray change ${i + 1}`)
  lines.push('', '## Proof checked')
  if (o.head) lines.push(`Head: ${o.head}`)
  if (o.patch) lines.push(`Patch: ${o.patch}`)
  return lines.join('\n') + '\n'
}

/** Writes `<dir>/reports/<slug>/<name>.md` with `text` and sets its mtime to `mtimeMs` (default now); returns the path. */
export function writeReport(dir: string, slug: string, name: string, text: string, mtimeMs = Date.now()): string {
  mkdirSync(`${dir}/reports/${slug}`, { recursive: true })
  const p = `${dir}/reports/${slug}/${name}.md`
  writeFileSync(p, text)
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
  return p
}

export type RunAgent = {
  /** the agent id, e.g. "a1b2" (default derived from the label) */
  id?: string
  /** the Workflow label, e.g. "s-judge-2" */
  label: string
  /** meta agentType (default "general-purpose") */
  agentType?: string
  /** meta `model` key; omit the key entirely when undefined (the probe's no-model case) */
  metaModel?: string
  /** the model the transcript's assistant records carry (default "claude-opus-5-5"); null for no assistant record model */
  model?: string | null
  /** the request effort recorded in an api-request-blob record (omit record when undefined) */
  effort?: string
  /** the journal `result` value: text, or an object for a schema result (default "done") */
  result?: unknown
  /** ISO timestamp of the first transcript record (default 2026-10-29T10:00:00.000Z) */
  startTs?: string
  /** ISO timestamp of the last transcript record, which `finish` uses as the report mtime (default startTs + 60s) */
  endTs?: string
  /** file mtime of agent-<id>.jsonl in ms (default Date.parse(endTs)) */
  mtimeMs?: number
  /** tool uses the transcript holds: [{name: 'Write'|'Edit'|..., file_path}] */
  tools?: { name: string; file_path?: string }[]
  /** workflowPhase in the meta file */
  phase?: string
  /** leave out the journal `result` line (an agent that never returned) */
  noResult?: boolean
}

/** Builds a Workflow run dir `<transcripts>/<runId>/` in the real probe shapes: journal.jsonl (launched, started, result lines), agent-<id>.meta.json and agent-<id>.jsonl (records with timestamp, an api-request-blob with output_config.effort, assistant records with message.model and tool_use blocks). `journalMtimeMs` sets journal.jsonl's mtime (default newest agent end). Returns {dir, ids} with ids[label] = agent id. */
export function mkRun(transcripts: string, runId: string, agents: RunAgent[], opts: { journalMtimeMs?: number } = {}): { dir: string; ids: Record<string, string> } {
  const dir = `${transcripts}/${runId}`
  mkdirSync(dir, { recursive: true })
  const ids: Record<string, string> = {}
  const journal: string[] = [JSON.stringify({ type: 'launched' })]
  const results: string[] = []
  let newest = 0
  agents.forEach((a, i) => {
    const id = a.id ?? `a${String(i + 1).padStart(2, '0')}${a.label.replace(/[^a-z0-9]/g, '').slice(0, 10)}`
    ids[a.label] = id
    const startTs = a.startTs ?? '2026-10-29T10:00:00.000Z'
    const endTs = a.endTs ?? new Date(Date.parse(startTs) + 60_000).toISOString()
    const key = `v2:${id.padEnd(64, '0')}`
    journal.push(JSON.stringify({ type: 'started', key, agentId: id, label: a.label, phase: a.phase ?? 'Run' }))
    if (!a.noResult) results.push(JSON.stringify({ type: 'result', key, agentId: id, result: a.result ?? 'done' }))
    const meta: Record<string, unknown> = { agentType: a.agentType ?? 'general-purpose', isBuiltIn: false, description: a.label, workflowPhase: a.phase ?? 'Run', spawnDepth: 1, requestShape: 'foreground', requestNonInteractive: false }
    if (a.metaModel !== undefined) meta.model = a.metaModel
    writeFileSync(`${dir}/agent-${id}.meta.json`, JSON.stringify(meta))
    const rec = (o: Record<string, unknown>, ts: string) => JSON.stringify({ parentUuid: null, isSidechain: true, agentId: id, ...o, timestamp: ts, userType: 'external', entrypoint: 'cli' })
    const lines = [rec({ type: 'user', message: { role: 'user', content: 'task text' }, uuid: `u-${id}-1` }, startTs)]
    if (a.effort !== undefined) lines.push(rec({ type: 'api-request-blob', hash: 'h', message: { role: 'system', content: [{ type: 'text', text: 'sys' }], output_config: { effort: a.effort } } }, startTs))
    const model = a.model === undefined ? 'claude-opus-5-5' : a.model
    const content = (a.tools ?? []).map((t, k) => ({ type: 'tool_use', id: `t${k}`, name: t.name, input: t.file_path ? { file_path: t.file_path } : {} }))
    content.push({ type: 'text', text: 'ok' } as any)
    lines.push(rec({ type: 'assistant', message: { role: 'assistant', ...(model ? { model } : {}), content }, uuid: `u-${id}-2` }, endTs))
    const p = `${dir}/agent-${id}.jsonl`
    writeFileSync(p, lines.join('\n') + '\n')
    const mt = a.mtimeMs ?? Date.parse(endTs)
    utimesSync(p, mt / 1000, mt / 1000)
    newest = Math.max(newest, mt)
  })
  writeFileSync(`${dir}/journal.jsonl`, [...journal, ...results].join('\n') + '\n')
  const jm = opts.journalMtimeMs ?? newest
  if (jm) utimesSync(`${dir}/journal.jsonl`, jm / 1000, jm / 1000)
  return { dir: flat(dir), ids }
}

const COPY_DIRS = ['bin', 'hooks', 'docs', 'workflows']
let sharedCopy: string | undefined

/** A temp copy of the plugin (bin, hooks, docs, workflows from this checkout) where workflows/plan.js and wave.js are stub files (so tests do not depend on another crew's scripts); returns its dir. Built once per process and shared, so never write inside it. */
export function pluginCopy(): string {
  if (sharedCopy) return sharedCopy
  const d = tmp('fcli-plugin-')
  for (const sub of COPY_DIRS) if (existsSync(`${REAL_PLUGIN}/${sub}`)) cpSync(`${REAL_PLUGIN}/${sub}`, `${d}/${sub}`, { recursive: true })
  mkdirSync(`${d}/workflows`, { recursive: true })
  writeFileSync(`${d}/workflows/plan.js`, '// stub plan.js for factory tests\nexport default async function () {}\n')
  writeFileSync(`${d}/workflows/wave.js`, '// stub wave.js for factory tests\nexport default async function () {}\n')
  sharedCopy = d
  return d
}

export type CliResult = { status: number | null; json: any; stdout: string; stderr: string }

/** Runs `node <factory> <command> ...args` with spawnSync (cwd optional) and returns {status, json (parsed stdout when it is a single JSON line, else undefined), stdout, stderr}. */
export function runCli(factory: string, command: string, args: string[] = [], cwd?: string): CliResult {
  const r = spawnSync(process.execPath, [factory, command, ...args], { cwd, encoding: 'utf8', timeout: 120_000 })
  const stdout = r.stdout ?? ''
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  let json: any
  if (lines.length === 1) {
    try {
      json = JSON.parse(lines[0])
    } catch {}
  }
  return { status: r.status, json, stdout, stderr: r.stderr ?? '' }
}

/** Asserts stdout is exactly one JSON object line (ending in a newline) and returns the parsed object. */
export function assertOneLine(res: CliResult): any {
  const lines = res.stdout.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 1, `stdout must be exactly one line, got ${lines.length}: ${res.stdout.slice(0, 300)} | stderr: ${res.stderr.slice(0, 300)}`)
  assert.ok(res.stdout.endsWith('\n'), 'the line ends with a newline')
  assert.ok(res.json !== null && typeof res.json === 'object' && !Array.isArray(res.json), `stdout is not a JSON object: ${lines[0]}`)
  return res.json
}

/** Asserts a usage error: exit 2 and one line `{"error": "<non-empty message>"}`. */
export function assertUsageError(res: CliResult): void {
  const j = assertOneLine(res)
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stdout ${res.stdout.slice(0, 200)} stderr ${res.stderr.slice(0, 200)}`)
  assert.equal(typeof j.error, 'string')
  assert.ok(j.error.length > 0)
}

export type Env = {
  repo: string
  dir: string
  /** the plugin dir the CLI runs from */
  plugin: string
  factory: string
  /** <dir>/../ transcripts root: Workflow runs live in <transcripts>/<runId>/ */
  transcripts: string
  /** run a command; flags {k: v}: dir and repo are added unless set to null; true gives a bare flag, an array repeats it, null/false/undefined drops it; `extra` raw args are appended; cwd defaults to the repo */
  run(command: string, flags?: Record<string, unknown>, extra?: string[], cwd?: string): CliResult
}

/** One test world: a temp repo (optionally with .claude/foundry.json `config`), a temp foundry dir, a transcripts root, and the CLI bound to the shared plugin copy (or `useRealPlugin`: this checkout's own bin, hooks, docs and workflows). */
export function mkEnv(opts: { config?: unknown; files?: Record<string, string>; useRealPlugin?: boolean } = {}): Env {
  const repo = mkRepo({ config: opts.config, files: opts.files })
  const dir = mkFoundryDir()
  const transcripts = tmp('fcli-tr-')
  const plugin = opts.useRealPlugin ? REAL_PLUGIN : pluginCopy()
  const factory = `${plugin}/bin/factory.ts`
  const env: Env = {
    repo, dir, plugin, factory, transcripts,
    run(command, flags = {}, extra = [], cwd = repo) {
      const all: Record<string, unknown> = { dir, repo, ...flags }
      const args: string[] = []
      for (const [k, v] of Object.entries(all)) {
        if (v === null || v === undefined || v === false) continue
        for (const x of Array.isArray(v) ? v : [v]) args.push(`--${k}`, ...(x === true ? [] : [String(x)]))
      }
      return runCli(factory, command, [...args, ...extra], cwd)
    },
  }
  return env
}

// ---------------------------------------------------------------------------------------------------------------
// A small JSON Schema validator for plugins/foundry/docs/events.schema.json: only the keywords that file uses.

const typeOk = (t: string, v: unknown): boolean => {
  switch (t) {
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v)
    case 'array': return Array.isArray(v)
    case 'string': return typeof v === 'string'
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'number': return typeof v === 'number'
    case 'boolean': return typeof v === 'boolean'
    case 'null': return v === null
    default: return false
  }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Validates `value` against `schema` (keywords: type incl. arrays of types, required, properties, additionalProperties false, enum, const, minLength, maxLength, minimum, integer, allOf, if/then, oneOf, not, boolean schemas, format date-time); returns a list of error strings that name the path and the keyword (e.g. "/: required run"). */
export function validate(schema: any, value: unknown, path = ''): string[] {
  if (schema === true || schema === undefined) return []
  if (schema === false) return [`${path}/: schema is false`]
  const errs: string[] = []
  const at = path || '/'
  if (schema.type !== undefined) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!ts.some((t: string) => typeOk(t, value))) errs.push(`${at}: type ${ts.join('|')}`)
  }
  if (schema.const !== undefined && !same(schema.const, value)) errs.push(`${at}: const ${JSON.stringify(schema.const)}`)
  if (schema.enum !== undefined && !schema.enum.some((e: unknown) => same(e, value))) errs.push(`${at}: enum ${JSON.stringify(schema.enum)}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: minLength ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: maxLength ${schema.maxLength}`)
    if (schema.format === 'date-time' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(value)) errs.push(`${at}: format date-time`)
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: minimum ${schema.minimum}`)
  if (typeOk('object', value)) {
    const obj = value as Record<string, unknown>
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${at}: required ${r}`)
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in obj) errs.push(...validate(sub, obj[k], `${path}/${k}`))
    if (schema.additionalProperties === false) for (const k of Object.keys(obj)) if (!(k in (schema.properties ?? {}))) errs.push(`${at}: additionalProperties ${k}`)
  }
  for (const sub of schema.allOf ?? []) errs.push(...validate(sub, value, path))
  if (schema.if !== undefined && validate(schema.if, value, path).length === 0 && schema.then !== undefined) errs.push(...validate(schema.then, value, path))
  if (schema.oneOf !== undefined) {
    const n = schema.oneOf.filter((s: unknown) => validate(s, value, path).length === 0).length
    if (n !== 1) errs.push(`${at}: oneOf matched ${n}`)
  }
  if (schema.not !== undefined && validate(schema.not, value, path).length === 0) errs.push(`${at}: not`)
  return errs
}

let schemaCache: any
/** Validates one events.jsonl line (a JSON string, or an already parsed object) against the real docs/events.schema.json; returns the error list (empty = valid). A line that is not JSON gives one error. */
export function validateEvent(line: string | Record<string, unknown>): string[] {
  schemaCache ??= JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  let value: unknown = line
  if (typeof line === 'string') {
    try {
      value = JSON.parse(line)
    } catch {
      return ['/: not JSON']
    }
  }
  return validate(schemaCache, value)
}

/** Lists the `*.cases.ts` files in this folder (sorted), as absolute forward-slash paths. */
export function caseFiles(): string[] {
  return readdirSync(HERE).filter((f) => f.endsWith('.cases.ts')).sort().map((f) => `${HERE}${f}`)
}
