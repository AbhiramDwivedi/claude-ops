import type { EngineInterface, Register } from 'claude-code'

// ---------------------------------------------------------------------------------------------------------------
// Pure logic: every decision the hooks make, kept apart from the commands that gather facts and act on them.
// ---------------------------------------------------------------------------------------------------------------

// agent types that only read, so they run in the session's own checkout
export const READ_ONLY_AGENTS = ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'scout', 'reviewer']

// the Agent tool's own arguments, the ones an updatedInput may carry back
const AGENT_KEYS = ['description', 'prompt', 'subagent_type', 'model', 'effort', 'name', 'team_name', 'mode', 'run_in_background', 'isolation']

// The agent types that never get a worktree: the built-in read-only ones plus each configured list, each a
// comma-separated string or a list. `noIsolateAgents` is the option; `readOnlyAgents` is its deprecated old name.
export function noIsolateTypes(...extras: unknown[]): Set<string> {
  const more = extras.flatMap(extra => (Array.isArray(extra) ? extra.map(String) : typeof extra === 'string' ? extra.split(',') : []))
  return new Set([...READ_ONLY_AGENTS, ...more].map(t => t.trim().toLowerCase()).filter(t => t !== ''))
}

// The ignored directories worth checking for a nested repo, from `git ls-files --others --ignored
// --exclude-standard --directory` run with core.quotePath off: only directory entries, at most `cap` of them,
// without the trailing slash. A name git still quotes (a quote or newline in it) is skipped.
export function ignoredDirs(lsFilesOut: string, cap = 200): string[] {
  return lsFilesOut
    .replace(/\r/g, '')
    .split('\n')
    .filter(entry => entry.endsWith('/') && !entry.startsWith('"') && !entry.split('/').includes('..'))
    .map(entry => entry.slice(0, -1))
    .slice(0, cap)
}

// The subdirectories of an ignored directory that is no repo itself, to check one level down (`services/` ignored
// whole, holding `services/a/.git`): real directories only, no links, at most `cap`.
export function childDirs(dir: string, entries: readonly { name: string; kind: string; isLink?: boolean }[], cap = 200): string[] {
  return entries
    .filter(entry => entry.kind === 'dir' && !entry.isLink && entry.name !== '.git')
    .slice(0, cap)
    .map(entry => `${dir}/${entry.name}`)
}

// A repo whose ignored directories hold their own git repos (a workspace of service repos) keeps its code
// outside what a worktree of it would contain. Agents then stay in the main checkout, unless the repo has a setup
// script (expected to make the nested worktrees). isolateNestedRepos skips this check altogether.
export function skipForNested(f: { nested: readonly string[]; hasSetup: boolean }): boolean {
  return f.nested.length > 0 && !f.hasSetup
}

export function nestedToast(nested: readonly string[], script: string): string {
  const named = nested.slice(0, 3).join(', ') + (nested.length > 3 ? `, +${nested.length - 3} more` : '')
  return `worktrees: agents run in the main checkout, as this repo ignores nested git repos (${named}) a worktree would not contain. To isolate them, add ${script} to make their worktrees, or set isolateNestedRepos.`
}

// An Agent call gets a worktree when nothing chose its isolation, the session is in a git repo, and its type can
// edit. An unset type is general-purpose, which can.
export function needsWorktree(input: { isolation?: unknown; subagent_type?: unknown }, inRepo: boolean, readOnly: Set<string>): boolean {
  if (input.isolation !== undefined && input.isolation !== null) return false
  if (!inRepo) return false
  const type = (typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : 'general-purpose').toLowerCase()
  // a plugin's agent is `plugin:name`; listing the bare name covers it
  return !readOnly.has(type) && !readOnly.has(type.slice(type.lastIndexOf(':') + 1))
}

// the agent name pattern of kit's manifest (plugins/kit/docs/manifest.schema.json)
const MANIFEST_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9_-]{1,64})?$/

// Folds A-Z only. Declared manifest names are ASCII (MANIFEST_AGENT_NAME), and toLowerCase() would also fold U+212A
// KELVIN SIGN into "k", letting a lookalike call type borrow a declared name's read-only exemption.
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, c => c.toLowerCase())

// The agent types kit's manifest declares read-only (repo ADR-0014), from the text of `.claude/kit/manifest.json`:
// the case-folded full name of each entry with `readOnly: true` and a name the schema allows. A bad entry adds
// nothing and the rest still count. A file that isn't JSON, isn't an object, has a version other than 1 or has no
// agents array declares nothing and says why in `error`.
// Types that edit files, so a manifest can't make them skip their worktree (ADR-0014, amendment of 2026-10-27).
// ADR-0013 carries the same list; plugins share no code, so this is its own copy.
export const REFUSED_READ_ONLY_TYPES = ['general-purpose', 'kit:builder', 'kit:test-writer', 'foundry:architect', 'foundry:devops', 'foundry:lead', 'foundry:writer']

// An entry naming a refused type (full name, case-folded) is left out of `types` and its name, as written, goes to
// `refused` in file order; `refused` is [] when `error` is set.
export function declaredReadOnly(text: string): { types: Set<string>; refused: string[]; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { types: new Set(), refused: [], error: String(error) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { types: new Set(), refused: [], error: 'not a JSON object' }
  const file = parsed as { version?: unknown; agents?: unknown }
  if (file.version !== 1) return { types: new Set(), refused: [], error: `version ${JSON.stringify(file.version)}, not 1` }
  if (!Array.isArray(file.agents)) return { types: new Set(), refused: [], error: 'no agents array' }
  const types = new Set<string>()
  const refused: string[] = []
  for (const entry of file.agents as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, readOnly } = entry as { name?: unknown; readOnly?: unknown }
    if (readOnly === true && typeof name === 'string' && MANIFEST_AGENT_NAME.test(name)) {
      if (REFUSED_READ_ONLY_TYPES.includes(asciiLower(name))) refused.push(name)
      else types.add(asciiLower(name))
    }
  }
  return { types, refused }
}

// the Agent call's arguments with isolation set, and nothing else of the envelope
export function withWorktree(e: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const key of AGENT_KEYS) if (e[key] !== undefined) input[key] = e[key]
  input.isolation = 'worktree'
  return input
}

// A path as matching compares it: forward slashes, no trailing slash, and on Windows lower case.
export function normPath(path: string, windows: boolean): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return windows ? slashed.toLowerCase() : slashed
}

// The worktree root a path lies in, when it lies under a `.claude/worktrees/<name>` folder.
export function worktreeRootOf(path: string): string | undefined {
  const m = /^(.*[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)/.exec(path)
  return m?.[1]
}

const PATH_CHAR = /[A-Za-z0-9._-]/

// True when the command line names this path, or something under it: `.../agent-a1` does not match `.../agent-a12`.
export function mentions(command: string, path: string, windows: boolean): boolean {
  const cmd = normPath(command, windows)
  const target = normPath(path, windows)
  if (target === '') return false
  for (let at = cmd.indexOf(target); at !== -1; at = cmd.indexOf(target, at + 1)) {
    const before = at === 0 ? '' : (cmd[at - 1] ?? '')
    const after = cmd[at + target.length] ?? ''
    if ((before === '' || !(PATH_CHAR.test(before) || before === '/')) && (after === '' || !PATH_CHAR.test(after))) return true
  }
  return false
}

// Every `<prefix><name>` path the command line names, `prefix` already normalised and ending in `/`.
export function worktreeMentions(command: string, prefix: string, windows: boolean): string[] {
  const cmd = normPath(command, windows)
  const found = new Set<string>()
  for (let at = cmd.indexOf(prefix); at !== -1; at = cmd.indexOf(prefix, at + 1)) {
    const m = /^[^/"'\s;,]+/.exec(cmd.slice(at + prefix.length))
    if (m) found.add(prefix + m[0])
  }
  return [...found]
}

// a Claude Code process, which this plugin never stops
export function isClaude(command: string): boolean {
  return /(^|[\\/\s"'])claude(\.exe)?(["'\s]|$)/i.test(command) || /@anthropic-ai[\\/]claude-code/i.test(command)
}

export type Proc = { pid: number; ppid: number; pgid?: number; cmd: string }
export type Listener = { port: number; pid: number }
// the processes and listening sockets, and the pid of the probe that listed them (a child of this Claude process)
export type Snapshot = { self: number; procs: Proc[]; listeners: Listener[] }

export function ancestors(pid: number, procs: readonly Proc[]): number[] {
  const parent = new Map(procs.map(p => [p.pid, p.ppid]))
  const seen: number[] = []
  for (let at = parent.get(pid); at !== undefined && at > 0 && !seen.includes(at); at = parent.get(at)) seen.push(at)
  return seen
}

export function descendants(pid: number, procs: readonly Proc[]): number[] {
  const out: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const at = queue.shift() as number
    for (const p of procs) {
      if (p.ppid === at && p.pid !== pid && !out.includes(p.pid)) {
        out.push(p.pid)
        queue.push(p.pid)
      }
    }
  }
  return out
}

export type Victims = {
  // the processes to stop with their trees: none is a descendant of another
  roots: number[]
  // every process in those trees
  tree: number[]
  // matched, and left alive because its tree holds Claude or the probe
  spared: number[]
}

// The processes to stop for these worktree paths and ports: those whose command line names a path, or that listen
// on a port. Never the probe, its ancestors (this Claude), any Claude process, or a process whose tree holds one.
export function selectVictims(snapshot: Snapshot, paths: readonly string[], ports: readonly number[], windows: boolean): Victims {
  const { procs } = snapshot
  const shielded = new Set([snapshot.self, ...ancestors(snapshot.self, procs)])
  for (const p of procs) if (isClaude(p.cmd)) shielded.add(p.pid)
  const listening = new Set(snapshot.listeners.filter(l => ports.includes(l.port)).map(l => l.pid))
  const matched = procs.filter(
    p => !shielded.has(p.pid) && p.pid > 4 && (listening.has(p.pid) || paths.some(path => mentions(p.cmd, path, windows))),
  )
  const spared: number[] = []
  const safe = new Set<number>()
  for (const p of matched) {
    if (descendants(p.pid, procs).some(d => shielded.has(d))) spared.push(p.pid)
    else safe.add(p.pid)
  }
  const roots = [...safe].filter(pid => !ancestors(pid, procs).some(a => safe.has(a)))
  const tree = new Set<number>()
  for (const root of roots) for (const pid of [root, ...descendants(root, procs)]) if (!shielded.has(pid)) tree.add(pid)
  return { roots: roots.sort((a, b) => a - b), tree: [...tree].sort((a, b) => a - b), spared }
}

// Process groups safe to signal whole: led by a root, and holding no shielded process.
export function safeGroups(snapshot: Snapshot, roots: readonly number[]): number[] {
  const shielded = new Set([snapshot.self, ...ancestors(snapshot.self, snapshot.procs)])
  for (const p of snapshot.procs) if (isClaude(p.cmd)) shielded.add(p.pid)
  const shieldedGroups = new Set(snapshot.procs.filter(p => shielded.has(p.pid)).map(p => p.pgid))
  return roots.filter(pid => {
    const p = snapshot.procs.find(q => q.pid === pid)
    return p !== undefined && p.pgid === pid && pid > 1 && !shieldedGroups.has(pid)
  })
}

// Windows: one JSON object `{ self, procs: [{ ProcessId, ParentProcessId, CommandLine }], listen: [{ LocalPort, OwningProcess }] }`
export function parseWindowsSnapshot(json: string): Snapshot {
  const raw = JSON.parse(json) as { self: number; procs?: unknown; listen?: unknown }
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : v ? [v] : []) as Record<string, unknown>[]
  return {
    self: Number(raw.self),
    procs: list(raw.procs).map(p => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), cmd: String(p.CommandLine ?? '') })),
    listeners: list(raw.listen).map(l => ({ port: Number(l.LocalPort), pid: Number(l.OwningProcess) })),
  }
}

// Linux: `SELF <pid>`, then `ps -eo pid=,ppid=,pgid=,args=` lines, then `---`, then `ss -ltnpH` lines
export function parseLinuxSnapshot(text: string): Snapshot {
  const lines = text.split('\n')
  let self = 0
  const procs: Proc[] = []
  const listeners: Listener[] = []
  let inSockets = false
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('SELF ')) self = Number(t.slice(5))
    else if (t === '---') inSockets = true
    else if (!inSockets) {
      const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(t)
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[4] ?? '' })
    } else if (t !== '') {
      const cols = t.split(/\s+/)
      const port = Number(cols[3]?.slice(cols[3].lastIndexOf(':') + 1))
      for (const pm of t.matchAll(/pid=(\d+)/g)) if (Number.isFinite(port)) listeners.push({ port, pid: Number(pm[1]) })
    }
  }
  return { self, procs, listeners }
}

// --- port slots ---

export type Slot = { path: string; name: string; at: number }
export type SlotTable = { slots: Record<string, Slot> }

export const MAX_SLOT = 99

export function portRange(base: number, slot: number): [number, number] {
  return [base + slot * 10, base + slot * 10 + 9]
}

export function ports(base: number, slot: number): number[] {
  const [from] = portRange(base, slot)
  return Array.from({ length: 10 }, (_, i) => from + i)
}

export function slotOf(table: SlotTable, path: string, windows: boolean): number | undefined {
  const key = normPath(path, windows)
  const hit = Object.entries(table.slots).find(([, s]) => normPath(s.path, windows) === key)
  return hit === undefined ? undefined : Number(hit[0])
}

// The path's slot: the one it holds, else the lowest free from 1 (slot 0's ports stay with the main checkout).
export function claimSlot(table: SlotTable, path: string, name: string, at: number, windows: boolean): { table: SlotTable; slot: number } {
  const held = slotOf(table, path, windows)
  if (held !== undefined) return { table, slot: held }
  let slot = 1
  while (table.slots[String(slot)] !== undefined) slot++
  if (slot > MAX_SLOT) throw new Error(`all ${MAX_SLOT} worktree slots are taken`)
  return { table: { slots: { ...table.slots, [String(slot)]: { path, name, at } } }, slot }
}

export function releaseSlot(table: SlotTable, path: string, windows: boolean): SlotTable {
  const slot = slotOf(table, path, windows)
  if (slot === undefined) return table
  const slots = { ...table.slots }
  delete slots[String(slot)]
  return { slots }
}

export function parseSlots(text: string | undefined): SlotTable {
  try {
    const raw = JSON.parse(text ?? '') as SlotTable
    return raw && typeof raw.slots === 'object' && raw.slots !== null ? { slots: raw.slots } : { slots: {} }
  } catch {
    return { slots: {} }
  }
}

// The `.worktreeinclude` files to copy: those the include patterns listed that `git check-ignore` also printed
// (so .gitignore ignores them), relative, and never reaching outside the checkout.
export function includedFiles(candidates: readonly string[], checkIgnoreOut: string): string[] {
  const ignored = new Set(checkIgnoreOut.replace(/\r/g, '').split('\n').filter(Boolean))
  return candidates.filter(f => ignored.has(f) && !/^([\\/]|[A-Za-z]:)/.test(f) && !f.split(/[\\/]/).includes('..'))
}

// How WorktreeCreate makes the worktree: reuse its folder, check out its existing branch, or branch from the
// HEAD commit of the checkout the hook runs in, detached or not. No HEAD (an empty repo): Claude Code's default.
export type CreatePlan = { kind: 'reuse' } | { kind: 'add-branch' } | { kind: 'add-new'; base: string } | { kind: 'default' }

export function planCreate(f: { pathExists: boolean; branchExists: boolean; head?: string }): CreatePlan {
  if (f.pathExists) return { kind: 'reuse' }
  if (f.branchExists) return { kind: 'add-branch' }
  if (f.head === undefined || !/^[0-9a-f]{7,64}$/i.test(f.head.trim())) return { kind: 'default' }
  return { kind: 'add-new', base: f.head.trim() }
}

// What slots.json holds: the slots, and the worktrees this plugin created whose agent has not stopped yet.
export type State = { slots: SlotTable; active: Record<string, { path: string; at: number }> }

// a worktree created this long ago counts as idle even when no stop was seen (the session died)
export const ACTIVE_FOR_MS = 24 * 60 * 60_000

export function parseState(text: string | undefined): State {
  let active: State['active'] = {}
  try {
    const raw = JSON.parse(text ?? '') as { active?: State['active'] }
    if (raw && typeof raw.active === 'object' && raw.active !== null) active = raw.active
  } catch {
    // an unreadable file starts over
  }
  return { slots: parseSlots(text), active }
}

export function serializeState(state: State): string {
  return JSON.stringify({ slots: state.slots.slots, active: state.active }, null, 2) + '\n'
}

export function markActive(state: State, path: string, at: number, windows: boolean): State {
  return { ...state, active: { ...state.active, [normPath(path, windows)]: { path, at } } }
}

export function markDone(state: State, path: string, windows: boolean): State {
  const active = { ...state.active }
  delete active[normPath(path, windows)]
  return { ...state, active }
}

export function isActive(state: State, path: string, now: number, windows: boolean): boolean {
  const hit = state.active[normPath(path, windows)]
  return hit !== undefined && now - hit.at < ACTIVE_FOR_MS
}

// The main checkout, from the output of `git rev-parse --path-format=absolute --git-common-dir`; undefined when
// the output is not a `<checkout>/.git` (empty, a bare repo, a worktree's own git dir).
export function mainCheckoutOf(commonDirOut: string): string | undefined {
  const m = /^(.+)[\\/]\.git$/.exec(commonDirOut.trim())
  return m ? m[1] : undefined
}

// Where a subagent's meta file lives, from the event's transcript path and the bare agent id.
export function metaPathFor(transcriptPath: string, id: string): string {
  const path = transcriptPath.replace(/\\/g, '/')
  const parts = path.split('/')
  // a subagent's transcript is `<session>/subagents/agent-<id>.jsonl`; a session transcript in a folder named subagents is not
  const inSubagents = parts[parts.length - 2] === 'subagents' && /^agent-[^/]*\.jsonl$/.test(parts[parts.length - 1])
  const sessionDir = inSubagents ?parts.slice(0, -2).join('/') : path.replace(/\.jsonl$/, '')
  return `${sessionDir}/subagents/agent-${id}.meta.json`
}

// A meta file that says its agent finished: a JSON object with `finished` exactly true. Never throws.
export function metaFinished(text: string | undefined): boolean {
  try {
    const raw: unknown = JSON.parse(text ?? '')
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as { finished?: unknown }).finished === true
  } catch {
    return false
  }
}

// `git cherry` output where every commit of the branch has an equivalent upstream (every line starts `- `).
export function cherryMerged(r: { exitCode: number; stdout: string }): boolean {
  if (r.exitCode !== 0) return false
  const lines = r.stdout.replace(/\r/g, '').split('\n').filter(l => l !== '')
  return lines.length > 0 && lines.every(l => l.startsWith('- '))
}

// The id of an `agent-<id>` worktree directly under the main checkout's .claude/worktrees; undefined for any other path.
export function agentWorktreeId(path: string, main: string, windows: boolean): string | undefined {
  const prefix = normPath(main, windows) + '/.claude/worktrees/agent-'
  const p = normPath(path, windows)
  if (!p.startsWith(prefix)) return undefined
  const id = p.slice(prefix.length)
  return /^[0-9a-z]+$/.test(id) ? id : undefined
}

// The state without the entries that are stale, whose agent finished, or whose worktree is gone.
export function sweepActive(state: State, f: { now: number; finished: readonly string[]; gone: readonly string[] }, windows: boolean): State {
  const drop = new Set([...f.finished, ...f.gone].map(p => normPath(p, windows)))
  const active: State['active'] = {}
  for (const [key, v] of Object.entries(state.active)) if (f.now - v.at < ACTIVE_FOR_MS && !drop.has(key)) active[key] = v
  return { ...state, active }
}

// the lock beside slots.json: a lock older than this was left by a process that died holding it
export const LOCK_STALE_MS = 10_000

// what a writer does when it finds the lock taken, by the lock's age
export function lockStep(ageMs: number): 'break' | 'wait' {
  return ageMs > LOCK_STALE_MS ? 'break' : 'wait'
}

// --- merged-branch tidy ---

export type Worktree = { path: string; head?: string; branch?: string; locked?: string; prunable: boolean; bare: boolean }

export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  let cur: Worktree | undefined
  for (const line of porcelain.replace(/\r/g, '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), prunable: false, bare: false }
      out.push(cur)
    } else if (cur === undefined) continue
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = line.slice(7) || 'locked'
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
    else if (line === 'bare') cur.bare = true
  }
  return out
}

export type BranchFacts = {
  branch: string
  // the default branch, main/master, or the branch the session or the main checkout has checked out
  isProtected: boolean
  // gh's merged PRs for this head branch; undefined when gh could not answer
  pr?: { numbers: number[] }
  // its tip is in origin/<default> (`git branch --merged`); counts as merged without a PR only for worktree-* branches
  gitMerged: boolean
  // commits on it that are neither on any remote branch nor in a merged PR's head
  unpushed: number
  // worktree-* branches only: commits on it not in origin/<default>
  ahead?: number
  // worktree-* branches only: a merged PR whose head commit contains its tip, as when the feature branch an agent
  // branch was merged into reached the default branch by a squash merge
  inMergedPr?: number
  // worktree-* branches only: merging it into origin/<default> (`git merge-tree --write-tree`) gives origin/<default>'s
  // own tree. undefined when the check could not run (git before 2.38, or another error)
  contentMerged?: boolean
  // isActive: this plugin created it for an agent that has not stopped yet
  worktree?: { path: string; exists: boolean; dirty: boolean; locked?: string; isMain: boolean; isSession: boolean; isActive?: boolean }
  // origin's branch of the same name; safe when every commit on it is in a merged PR's head or in origin/<default>
  remote?: { safe: boolean }
}

export type BranchPlan =
  | { kind: 'skip'; branch: string; reason: string }
  | {
      kind: 'delete'
      branch: string
      via: string
      // the worktree folder to remove; `prune` when its folder is already gone
      worktreePath?: string
      prune: boolean
      // `git branch -D` is allowed after `-d` refuses: only when gh confirmed the merge or the tip is in origin/<default>
      allowForce: boolean
      deleteRemote: boolean
      remoteNote?: string
    }

export function decideBranch(f: BranchFacts): BranchPlan {
  const skip = (reason: string): BranchPlan => ({ kind: 'skip', branch: f.branch, reason })
  if (f.isProtected) return skip('default or checked-out branch')
  if (f.worktree?.isMain) return skip('checked out in the main checkout')
  if (f.worktree?.isSession) return skip('this session works in its worktree')
  const prMerged = f.pr !== undefined && f.pr.numbers.length > 0
  // a tip in origin/<default> counts as merged without a PR only on the branches agent worktrees get:
  // a branch made by hand with `git branch foo` sits on the default branch too
  const agent = f.branch.startsWith('worktree-')
  const byAncestry = f.gitMerged && agent
  // agent branches only, in this order: merging it into origin/<default> would change nothing (squash, cherry-pick,
  // rebase); or, when that check could not run, its tip is in a merged PR's head
  const byContent = !prMerged && !byAncestry && agent && f.contentMerged === true
  const bySquash = !prMerged && !byAncestry && agent && f.contentMerged === undefined && f.inMergedPr !== undefined
  if (!prMerged && !byAncestry && !byContent && !bySquash) {
    if (agent && f.contentMerged === false) return skip('not merged: merging it into the default branch would change files')
    const gh = f.pr === undefined ? ' (gh unavailable)' : ''
    return skip(f.gitMerged ? `no merged PR${gh}; only worktree-* branches count as merged by being in the default branch` : f.pr !== undefined ? 'no merged PR, and not in the default branch' : 'not in the default branch (gh unavailable)')
  }
  const via = prMerged
    ? `PR #${f.pr?.numbers[0]}`
    : byAncestry
      ? 'in the default branch'
      : byContent
        ? 'content in the default branch'
        : `in merged PR #${f.inMergedPr}`
  const also = byContent || bySquash ? ` (${via})` : ''
  if (f.worktree?.locked !== undefined) return skip(`worktree is locked (${f.worktree.locked})${also}`)
  if (f.worktree?.isActive) return skip(`its agent has not stopped yet${also}`)
  if (f.worktree?.dirty) return skip(`worktree has uncommitted changes${also}`)
  // a squash leaves the branch's own commits on no remote; its content check already proved nothing would be lost
  if (f.unpushed > 0 && !byContent) return skip(`${f.unpushed} commit${f.unpushed === 1 ? '' : 's'} on no remote and in no merged PR`)
  return {
    kind: 'delete',
    branch: f.branch,
    via,
    worktreePath: f.worktree?.exists ? f.worktree.path : undefined,
    prune: f.worktree !== undefined && !f.worktree.exists,
    allowForce: true,
    deleteRemote: f.remote?.safe === true,
    remoteNote: f.remote !== undefined && !f.remote.safe ? 'remote branch has commits outside the merge; left it' : undefined,
  }
}

// The merged PR whose head commit is, or contains, `tip`. `present`: the heads that exist locally; `contains`: those
// of them `tip` is an ancestor of. A head missing locally (its branch deleted, never fetched) proves nothing.
export type MergedHead = { number: number; head: string }
export function findMergedPr(tip: string, heads: readonly MergedHead[], present: ReadonlySet<string>, contains: ReadonlySet<string>): number | undefined {
  return heads.find(h => present.has(h.head) && (h.head === tip || contains.has(h.head)))?.number
}

// Local default branch fast-forward: only when strictly behind origin's, and not checked out with changes.
export type MainSync =
  | { kind: 'none'; reason?: string }
  | { kind: 'update-ref'; from: string; to: string }
  | { kind: 'merge-ff'; worktree: string; to: string }

export function decideMainSync(f: {
  branch: string
  local?: string
  remote?: string
  // local is an ancestor of remote
  behind: boolean
  checkedOut?: { path: string; dirty: boolean }
}): MainSync {
  if (f.local === undefined || f.remote === undefined || f.local === f.remote) return { kind: 'none' }
  if (!f.behind) return { kind: 'none', reason: `${f.branch} has commits not on origin/${f.branch}; not fast-forwarded` }
  if (f.checkedOut === undefined) return { kind: 'update-ref', from: f.local, to: f.remote }
  if (f.checkedOut.dirty) return { kind: 'none', reason: `${f.branch} is behind origin but its checkout has uncommitted changes; not fast-forwarded` }
  return { kind: 'merge-ff', worktree: f.checkedOut.path, to: f.remote }
}

export function describePlan(plan: BranchPlan): string {
  if (plan.kind === 'skip') return `skip ${plan.branch}: ${plan.reason}`
  const parts = [plan.worktreePath ? `remove worktree ${plan.worktreePath}` : plan.prune ? 'prune its missing worktree' : '', `delete branch`]
  if (plan.deleteRemote) parts.push('delete origin/' + plan.branch)
  if (plan.remoteNote) parts.push(plan.remoteNote)
  return `${plan.branch} (${plan.via}): ${parts.filter(Boolean).join('; ')}`
}

// --- self-cleanup after a merge ---

// What the sweep knows of a worktree this session's WorktreeCreate made or reused. `branch` and `locked` come
// from `git worktree list`; `dirty` and `merged` are only gathered for a registered worktree-* branch.
export type SelfCleanFacts = {
  path: string
  registered: boolean
  branch?: string
  locked?: string
  // the session's own checkout
  isSession: boolean
  // its agent has not stopped yet
  active: boolean
  // `git status --porcelain` printed something, or failed
  dirty: boolean
  // its branch is in the session checkout's HEAD: an ancestor, or merging it gives HEAD's own tree
  merged: boolean
  // how it was found merged
  mergedBy?: 'ancestor' | 'tree' | 'cherry'
}

// `forget`: the path drops out of the session's tracking, as it can never qualify again
export type SelfCleanPlan = { kind: 'remove'; path: string; branch: string; deleteFlag: '-d' | '-D' } | { kind: 'skip'; path: string; reason: string; forget: boolean }

export function decideSelfClean(f: SelfCleanFacts): SelfCleanPlan {
  const skip = (reason: string, forget = false): SelfCleanPlan => ({ kind: 'skip', path: f.path, reason, forget })
  if (f.isSession) return skip('the session works in it', true)
  if (!f.registered) return skip('no longer a registered worktree', true)
  if (f.branch === undefined || !f.branch.startsWith('worktree-')) return skip(`not on a worktree-* branch (${f.branch ?? 'detached'})`)
  if (f.active) return skip('its agent has not stopped yet')
  if (f.locked !== undefined) return skip(`locked (${f.locked})`)
  if (f.dirty) return skip('uncommitted changes')
  if (!f.merged) return skip(`${f.branch} is not merged into the session's HEAD`)
  return { kind: 'remove', path: f.path, branch: f.branch, deleteFlag: f.mergedBy === 'tree' || f.mergedBy === 'cherry' ? '-D' : '-d' }
}

// ---------------------------------------------------------------------------------------------------------------
// Effects: commands on the host.
// ---------------------------------------------------------------------------------------------------------------

type $ = EngineInterface

// Windows: processes with command lines and, when asked (it is the slow part), the listening sockets
export function windowsProbe(withPorts: boolean): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine)',
    withPorts ? '$l = @(Get-NetTCPConnection -State Listen | Select-Object LocalPort, OwningProcess)' : '$l = @()',
    '[pscustomobject]@{ self = $PID; procs = $p; listen = $l } | ConvertTo-Json -Compress -Depth 3',
  ].join('; ')
}

export const LINUX_PROBE = 'echo "SELF $$"; ps -eo pid=,ppid=,pgid=,args=; echo ---; ss -ltnpH 2>/dev/null || true'

// --- background work an agent leaves running ---

export type BackgroundTask = { id: string; type: string; status: string; description: string; command?: string }

const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'done', 'error'])

// shells and monitors still going; subagents and other task types are not this agent's to stop
export function liveWork(tasks: readonly BackgroundTask[] | undefined): BackgroundTask[] {
  return (tasks ?? []).filter(t => (t.type === 'shell' || t.type === 'monitor') && !FINISHED.has(t.status))
}

export type StopDecision =
  | { kind: 'allow'; owned: BackgroundTask[]; commit: boolean }
  | { kind: 'block'; owned: BackgroundTask[]; reason: string }

// The agent's worktree with uncommitted changes: tracked edits or untracked files .gitignore does not cover.
export type DirtyWorktree = { path: string; branch: string; files: number }

const REPORT_SENT = "Your report was already delivered; don't send it again."

// `inTranscript`: the task ids found in the agent's own transcript, undefined when it could not be read.
// The task list may cover the whole session; an id in the agent's transcript is one its own tool started.
// `dirty`: the agent's worktree when it has uncommitted changes. An allowed stop with a dirty worktree is
// committed for the agent (`commit`).
export function decideStop(f: {
  stopHookActive: boolean
  tasks: readonly BackgroundTask[] | undefined
  inTranscript: ReadonlySet<string> | undefined
  dirty?: DirtyWorktree
}): StopDecision {
  const owned = f.inTranscript === undefined ? [] : liveWork(f.tasks).filter(t => f.inTranscript!.has(t.id))
  const dirty = f.dirty !== undefined && f.dirty.files > 0 ? f.dirty : undefined
  // a stop that follows our own block goes through, so it cannot loop
  if ((owned.length === 0 && dirty === undefined) || f.stopHookActive) return { kind: 'allow', owned, commit: dirty !== undefined }
  const parts: string[] = []
  if (owned.length > 0) {
    const list = owned.map(t => `${t.id} ${(t.command ?? t.description).split('\n')[0]}`).join('\n')
    parts.push(`You still have background work running:\n${list}\nStop each with TaskStop, unless it is meant to outlive you; then say so in one line.`)
  }
  if (dirty !== undefined) {
    parts.push(
      `Your worktree \`${dirty.path}\` has uncommitted changes (${dirty.files} file${dirty.files === 1 ? '' : 's'}). ` +
        `Commit them on \`${dirty.branch}\` with a message that says what they are, then finish.`,
    )
  }
  return { kind: 'block', owned, reason: `${parts.join('\n')} ${REPORT_SENT}` }
}

// Lines of `git status --porcelain`: one per changed or untracked file.
export function countChanges(porcelain: string): number {
  return porcelain.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '').length
}

export const WIP_MESSAGE = (agentType: string, agentId: string) => `WIP: uncommitted changes left by ${agentType} ${agentId}`

// Told to an editing agent when it starts in a worktree.
export function startContext(branch: string): string {
  return (
    `You are working in a git worktree on branch \`${branch}\`. Commit your changes on that branch before you finish, ` +
    "with a message that says what they are; uncommitted work doesn't reach the main session. Don't push."
  )
}

// Told to the main thread at session start.
export const SESSION_CONTEXT =
  "Editing agents work in git worktrees on `worktree-*` branches; before relying on an agent's work or starting an agent that " +
  'depends on it, review and merge its branch: `git merge --ff-only worktree-<name>` for a relay leg, a normal merge otherwise. ' +
  "Once you merge it, that agent's worktree and branch are removed for you; leave other worktrees alone (`/tidy` is for those)."

// `worktree-*` branches with commits outside origin's default branch and no merged PR: agent work nobody merged yet.
export function unmergedAgentWork(facts: readonly BranchFacts[]): string[] {
  return facts
    .filter(f => f.branch.startsWith('worktree-') && !f.isProtected && !f.gitMerged && (f.pr?.numbers.length ?? 0) === 0)
    .filter(f => f.contentMerged === false || (f.contentMerged === undefined && f.inMergedPr === undefined))
    .filter(f => !f.worktree?.isMain && !f.worktree?.isSession && !f.worktree?.isActive && (f.ahead ?? 0) > 0)
    .map(f => `unmerged agent work: ${f.branch} (${f.ahead} commit${f.ahead === 1 ? '' : 's'})`)
}

async function isWindows($: $): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function run($: $, argv: string[], cwd?: string, timeoutMs?: number) {
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error), isStdoutTruncated: false, isStderrTruncated: false }
  }
}

async function git($: $, cwd: string | undefined, ...args: string[]) {
  const r = await run($, ['git', ...args], cwd, 120_000)
  return { ok: r.exitCode === 0, out: r.stdout.replace(/\r/g, '').trim(), err: r.stderr.replace(/\r/g, '').trim() }
}

// Which of `ids` the transcript mentions, without reading it into memory: transcripts grow past what $.fs.read takes.
// undefined when the file cannot be searched.
async function idsInTranscript($: $, path: string, ids: readonly string[]): Promise<Set<string> | undefined> {
  if (ids.length === 0) return new Set()
  if (!path || !(await $.fs.exists(path).catch(() => false))) return undefined
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = cut > 0 ? path.slice(0, cut) : cut === 0 ? '/' : undefined
  const r = await run($, ['git', 'grep', '--no-index', '-h', '-o', '-F', ...ids.flatMap(id => ['-e', id]), '--', path.slice(cut + 1)], dir, 30_000)
  if (r.exitCode === 1) return new Set()
  if (r.exitCode === 0) return new Set(r.stdout.replace(/\r/g, '').split('\n').filter(Boolean))
  // git could not search it: a transcript small enough is read whole
  try {
    const text = await $.fs.read(path)
    return new Set(ids.filter(id => text.includes(id)))
  } catch {
    return undefined
  }
}

async function snapshot($: $, windows: boolean, withPorts: boolean): Promise<Snapshot | undefined> {
  const r = windows
    ? await run($, ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', windowsProbe(withPorts)], undefined, 60_000)
    : await run($, ['sh', '-c', LINUX_PROBE], undefined, 30_000)
  if (r.exitCode !== 0 || r.stdout.trim() === '') return undefined
  try {
    return windows ? parseWindowsSnapshot(r.stdout) : parseLinuxSnapshot(r.stdout)
  } catch {
    return undefined
  }
}

// Stops what runs in these worktrees or listens on these ports. Answers what it stopped, for the report.
async function stopProcesses($: $, windows: boolean, paths: string[], portList: number[], dryRun = false): Promise<string[]> {
  if (paths.length === 0 && portList.length === 0) return []
  const snap = await snapshot($, windows, portList.length > 0)
  if (snap === undefined) return ['could not list processes; stopped nothing']
  const victims = selectVictims(snap, paths, portList, windows)
  const label = (pid: number) => `${pid} ${(snap.procs.find(p => p.pid === pid)?.cmd ?? '').slice(0, 80)}`
  const notes = victims.spared.map(pid => `spared ${label(pid)}: its tree holds a Claude process`)
  if (victims.roots.length === 0) return notes
  if (dryRun) return [...notes, ...victims.roots.map(pid => `would stop ${label(pid)}`)]
  if (windows) {
    for (const pid of victims.roots) await run($, ['taskkill', '/T', '/F', '/PID', String(pid)])
  } else {
    const groups = safeGroups(snap, victims.roots)
    for (const g of groups) await run($, ['kill', '-TERM', '--', `-${g}`])
    await run($, ['kill', '-TERM', ...victims.tree.map(String)])
    await $.clock.sleep(1500)
    for (const g of groups) await run($, ['kill', '-KILL', '--', `-${g}`])
    await run($, ['kill', '-KILL', ...victims.tree.map(String)])
  }
  return [...notes, ...victims.roots.map(pid => `stopped ${label(pid)}`)]
}

type Repo = { top: string; common: string; mainRoot: string }

// The checkout `cwd` is in, its git common dir, and the main checkout; undefined outside a non-bare repo.
async function repoAt($: $, cwd?: string): Promise<Repo | undefined> {
  const top = await git($, cwd, 'rev-parse', '--show-toplevel')
  if (!top.ok || top.out === '') return undefined
  const common = await git($, cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common.ok || !/[\\/]\.git$/.test(common.out)) return undefined
  return { top: top.out, common: common.out, mainRoot: common.out.replace(/[\\/]\.git$/, '') }
}

export type ProjectRepo = { main: string; common: string }

// The repo the session works for: the first of the project dir, the event's cwd and the session cwd whose git
// common dir is a `<checkout>/.git`. The hook may run from inside the common dir or any folder that is not a work
// tree, so there is no `--is-inside-work-tree` check. undefined when no candidate is in a repo.
export async function projectRepo($: $, eventCwd?: string): Promise<ProjectRepo | undefined> {
  const candidates: string[] = []
  const project = await $.env.get('CLAUDE_PROJECT_DIR')
  if (typeof project === 'string' && project !== '') candidates.push(project)
  if (typeof eventCwd === 'string' && eventCwd !== '') candidates.push(eventCwd)
  const session = await $.session.cwd()
  if (typeof session === 'string' && session !== '') candidates.push(session)
  for (const cwd of new Set(candidates)) {
    const r = await git($, cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    if (!r.ok) continue
    const main = mainCheckoutOf(r.out)
    if (main !== undefined) return { main, common: r.out }
  }
  return undefined
}

// Whether kit's manifest in the main checkout declares this Agent call's type read-only (repo ADR-0014). Read on
// every call, never cached. A full-name match only: no bare-name fallback. Anything that goes wrong is false, so the
// call keeps today's behaviour; an absent file is silent, any other failure goes to the debug log.
async function declaredByKit($: $, input: Record<string, unknown>, main: string): Promise<boolean> {
  try {
    const type = typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : 'general-purpose'
    const path = `${main}/.claude/kit/manifest.json`
    if (!(await $.fs.exists(path))) return false
    let text: string
    try {
      text = await $.fs.read(path)
    } catch (error) {
      if (String(error).includes('ENOENT')) return false
      throw error
    }
    const declared = declaredReadOnly(text)
    if (declared.error !== undefined) throw new Error(declared.error)
    if (declared.refused.length > 0) {
      try {
        await $.ui.log(`worktrees: kit manifest declares editing types read-only, ignoring them: ${declared.refused.join(', ')}`, { to: 'debug' })
      } catch {
        // the log is best effort: the call goes on as today
      }
    }
    return declared.types.has(asciiLower(type))
  } catch (error) {
    try {
      await $.ui.log(`worktrees: kit manifest unreadable, ignoring it: ${String(error)}`, { to: 'debug' })
    } catch {
      // the log is best effort: the call goes on as today
    }
    return false
  }
}

type AgentWorktree = { repo: Repo; path: string; branch: string }

// The worktree an agent runs in, when the plugin can identify it: the `.claude/worktrees/<name>` folder `cwd` lies
// in, or `agent-<id>` there. Never the main checkout or the worktree the session itself works in, and only a folder
// that is the top of its own checkout with a branch checked out.
async function agentWorktree($: $, cwd: string, agentId: string): Promise<AgentWorktree | undefined> {
  const repo = await repoAt($, cwd)
  if (repo === undefined) return undefined
  const windows = await isWindows($)
  const prefix = normPath(`${repo.mainRoot}/.claude/worktrees`, windows) + '/'
  const own = worktreeRootOf(await $.session.cwd())
  for (const path of [worktreeRootOf(cwd), `${repo.mainRoot}/.claude/worktrees/agent-${agentId}`]) {
    if (path === undefined) continue
    const n = normPath(path, windows)
    if (!n.startsWith(prefix) || n === normPath(repo.mainRoot, windows)) continue
    if (own !== undefined && normPath(own, windows) === n) continue
    if (!(await $.fs.exists(path))) continue
    const top = await git($, path, 'rev-parse', '--show-toplevel')
    if (!top.ok || normPath(top.out, windows) !== n) continue
    const branch = await git($, path, 'branch', '--show-current')
    if (!branch.ok || branch.out === '') continue
    return { repo, path, branch: branch.out }
  }
  return undefined
}

// The worktree's uncommitted changes, undefined when it is clean or git cannot say.
async function dirtyOf($: $, wt: AgentWorktree): Promise<DirtyWorktree | undefined> {
  const status = await git($, wt.path, 'status', '--porcelain', '--untracked-files=all')
  const files = status.ok ? countChanges(status.out) : 0
  return files > 0 ? { path: wt.path, branch: wt.branch, files } : undefined
}

// Commits what an agent left uncommitted, so it reaches the main session. --no-verify: a failing pre-commit hook
// must not leave the work behind.
async function commitLeftovers($: $, wt: AgentWorktree, dirty: DirtyWorktree, agentType: string, agentId: string): Promise<void> {
  const added = await git($, wt.path, 'add', '-A')
  const done = added.ok ? await git($, wt.path, 'commit', '--no-verify', '--quiet', '-m', WIP_MESSAGE(agentType, agentId)) : added
  const what = `${dirty.files} uncommitted file${dirty.files === 1 ? '' : 's'} left by ${agentType} ${agentId} in ${wt.path}`
  if (done.ok) {
    await $.ui.log(`worktrees: committed ${what} on ${wt.branch}`, { to: 'debug' })
    await $.ui.toast(`worktrees: ${agentType} left changes uncommitted; committed them as WIP on ${wt.branch}`)
  } else {
    await $.ui.log(`worktrees: could not commit ${what}: ${done.err}`, { to: 'debug' })
    await $.ui.toast(`worktrees: ${agentType} left uncommitted changes in ${wt.path}; committing them failed`)
  }
}

const stateFile = (repo: Repo) => `${repo.common}/claude-worktrees/slots.json`
const lockDir = (repo: Repo) => `${repo.common}/claude-worktrees/slots.lock`

// slots.json exists but its text is not a JSON object: the sweep must not read that as "nothing is live"
async function stateUnreadable($: $, repo: Repo): Promise<boolean> {
  if (!(await $.fs.exists(stateFile(repo)))) return false
  try {
    const raw = JSON.parse((await $.fs.read(stateFile(repo))) as string) as unknown
    return typeof raw !== 'object' || raw === null || Array.isArray(raw)
  } catch {
    return true
  }
}

async function readState($: $, repo: Repo): Promise<State> {
  return parseState((await $.fs.exists(stateFile(repo))) ? ((await $.fs.read(stateFile(repo))) as string) : undefined)
}

// Creating a directory either succeeds or finds it there, atomically: the lock across sessions.
async function takeLock($: $, repo: Repo, windows: boolean): Promise<boolean> {
  const dir = lockDir(repo)
  const r = windows
    ? await run($, ['cmd.exe', '/d', '/c', 'mkdir', dir.replace(/\//g, '\\')])
    : await run($, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && mkdir "$1"', 'sh', dir])
  return r.exitCode === 0
}

async function dropLock($: $, repo: Repo, windows: boolean): Promise<void> {
  const dir = lockDir(repo)
  await (windows ? run($, ['cmd.exe', '/d', '/c', 'rmdir', dir.replace(/\//g, '\\')]) : run($, ['rmdir', dir]))
}

// State writes run one at a time: in this process by a promise chain, across sessions by the lock directory,
// with slots.json read again under the lock, so parallel agents never draw the same slot.
let stateChain: Promise<unknown> = Promise.resolve()
// `keepUnreadable`: a slots.json that does not parse is left alone and fn does not run (answers undefined).
function withState<T>($: $, repo: Repo, fn: (state: State) => Promise<{ state: State; value: T }>, keepUnreadable = false): Promise<T> {
  const step = stateChain.then(async () => {
    const windows = await isWindows($)
    for (let tries = 0; !(await takeLock($, repo, windows)); tries++) {
      const stat = await $.fs.stat(lockDir(repo)).catch(() => undefined)
      if (stat !== undefined && lockStep((await $.clock.now()) - stat.mtimeMs) === 'break') await dropLock($, repo, windows)
      else if (tries > 200) throw new Error('slots.lock stayed taken')
      else await $.clock.sleep(100)
    }
    try {
      if (keepUnreadable && (await stateUnreadable($, repo))) return undefined as T
      const { state, value } = await fn(await readState($, repo))
      await $.fs.write(stateFile(repo), serializeState(state))
      return value
    } finally {
      await dropLock($, repo, windows)
    }
  })
  stateChain = step.catch(() => undefined)
  return step
}

// Copies the gitignored files `.worktreeinclude` names from the main checkout into a new worktree. Answers a
// note for the debug log, or '' when the repo has no such file.
async function copyIncluded($: $, repo: Repo, path: string, windows: boolean): Promise<string> {
  const include = `${repo.mainRoot}/.worktreeinclude`
  if (!(await $.fs.exists(include))) return ''
  // untracked files the include patterns match, kept only where .gitignore ignores them too
  const listed = await git($, repo.mainRoot, 'ls-files', '--others', '--ignored', `--exclude-from=${include}`)
  const candidates = listed.out.split('\n').filter(Boolean)
  if (candidates.length === 0) return '.worktreeinclude matched no files'
  const checked = await $.process.run(['git', 'check-ignore', '--stdin'], { cwd: repo.mainRoot, stdin: candidates.join('\n') + '\n' })
  const files = includedFiles(candidates, checked.stdout)
  if (files.length === 0) return '.worktreeinclude matched no ignored files'
  const r = windows
    ? await $.process.run(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$src = $env:WT_SRC; $dst = $env:WT_DST; $input | ForEach-Object { if ($_) { $t = Join-Path $dst $_; New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null; Copy-Item -LiteralPath (Join-Path $src $_) -Destination $t -Force } }',
        ],
        { env: { WT_SRC: repo.mainRoot, WT_DST: path }, stdin: files.join('\n') + '\n', timeoutMs: 600_000 },
      )
    : await $.process.run(
        ['sh', '-c', 'while IFS= read -r f; do [ -n "$f" ] || continue; mkdir -p "$2/$(dirname "$f")" && cp -p "$1/$f" "$2/$f"; done', 'sh', repo.mainRoot, path],
        { stdin: files.join('\n') + '\n', timeoutMs: 600_000 },
      )
  return r.exitCode === 0 ? `copied ${files.length} .worktreeinclude file(s)` : `.worktreeinclude copy failed: ${r.stderr.slice(0, 300)}`
}

// The nested repos of the session's repo that its .gitignore hides, and whether agents stay in the main checkout
// for them: only when the repo has no setup script for this platform.
async function nestedRepos($: $, main: string): Promise<{ skip: boolean; toast: string }> {
  const top = { out: main }
  const ls = await git($, top.out, '-c', 'core.quotePath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory')
  if (!ls.ok) return { skip: false, toast: '' }
  const nested: string[] = []
  for (const dir of ignoredDirs(ls.out)) {
    if (await $.fs.exists(`${top.out}/${dir}/.git`)) {
      nested.push(dir)
      continue
    }
    let entries: { name: string; kind: string; isLink?: boolean }[] = []
    try {
      entries = await $.fs.list(`${top.out}/${dir}`)
    } catch {
      continue
    }
    for (const child of childDirs(dir, entries)) if (await $.fs.exists(`${top.out}/${child}/.git`)) nested.push(child)
  }
  if (nested.length === 0) return { skip: false, toast: '' }
  const script = `.claude/worktree-setup.${(await isWindows($)) ? 'ps1' : 'sh'}`
  const hasSetup = await $.fs.exists(`${top.out}/${script}`)
  await $.ui.log(`worktrees: nested repos ${nested.join(', ')}; setup script ${hasSetup ? 'present' : 'absent'}`, { to: 'debug' })
  return { skip: skipForNested({ nested, hasSetup }), toast: nestedToast(nested, script) }
}

function portBaseOf(options: Record<string, unknown>): number {
  const n = Number(options.portBase ?? 4000)
  return Number.isFinite(n) && n >= 1024 && n <= 64_000 ? Math.floor(n) : 4000
}

// Stops a worktree's processes and the ones on its slot's ports. The slot is released when `release` is set,
// or when the worktree folder is gone.
async function cleanWorktree($: $, repo: Repo, path: string, base: number, release: boolean): Promise<string[]> {
  const windows = await isWindows($)
  const state = await readState($, repo)
  const slot = slotOf(state.slots, path, windows)
  const notes = await stopProcesses($, windows, [path], slot === undefined ? [] : ports(base, slot))
  const freeSlot = slot !== undefined && (release || !(await $.fs.exists(path)))
  if (freeSlot || state.active[normPath(path, windows)] !== undefined) {
    await withState($, repo, async s => ({
      state: markDone(freeSlot ? { ...s, slots: releaseSlot(s.slots, path, windows) } : s, path, windows),
      value: undefined,
    }))
  }
  return notes
}

// Merging `branch` into `into` would change nothing: `git merge-tree --write-tree` gives `into`'s own tree. undefined
// when the check could not run (git before 2.38, or another error).
async function mergesToSameTree($: $, cwd: string, into: string, intoTree: string, branch: string): Promise<boolean | undefined> {
  const m = await run($, ['git', 'merge-tree', '--write-tree', into, branch], cwd, 60_000)
  if (m.exitCode === 0) return m.stdout.replace(/\r/g, '').split('\n')[0]?.trim() === intoTree
  if (m.exitCode === 1) return false
  return undefined
}

// `git worktree remove`, never --force. On Windows an ignored path past MAX_PATH (node_modules) makes a plain remove
// fail after git has already unregistered the worktree and deleted its tracked files, so core.longpaths is always on,
// and a failure that leaves the worktree unregistered is finished here: what is left is ignored files git was deleting.
async function removeWorktree($: $, cwd: string, path: string, windows: boolean): Promise<{ ok: boolean; err: string; note?: string }> {
  const removed = await run($, ['git', ...(windows ? ['-c', 'core.longpaths=true'] : []), 'worktree', 'remove', path], cwd, 600_000)
  if (removed.exitCode === 0) return { ok: true, err: '' }
  const err = removed.stderr.replace(/\r/g, '').trim().split('\n')[0] ?? ''
  const listed = await git($, cwd, 'worktree', 'list', '--porcelain')
  const key = normPath(path, windows)
  if (!listed.ok || parseWorktrees(listed.out).some(w => normPath(w.path, windows) === key)) return { ok: false, err }
  // the \\?\ prefix lifts MAX_PATH for rd
  const deleted = windows
    ? await run($, ['cmd.exe', '/d', '/c', 'rd', '/s', '/q', `\\\\?\\${path.replace(/\//g, '\\')}`], undefined, 600_000)
    : await run($, ['rm', '-rf', '--', path], undefined, 600_000)
  await git($, cwd, 'worktree', 'prune')
  if (await $.fs.exists(path)) return { ok: false, err: `${err}; git unregistered it, and deleting the rest failed: ${deleted.stderr.trim().split('\n')[0] ?? ''}` }
  const note = `git worktree remove ${path} failed (${err}) after unregistering it; deleted the ignored files left behind`
  await $.ui.log(`worktrees: ${note}`, { to: 'debug' })
  return { ok: true, err: '', note }
}

// --- self-cleanup ---

// What a sweep knows of the merge that started it: the event's cwd and the session transcript (for the metas).
type SweepEvent = { cwd?: string; transcriptPath?: string }

// Removes the agent worktrees (`<main checkout>/.claude/worktrees/agent-<id>`, from `git worktree list`, so native
// and auto-isolated ones count and a restart loses nothing) whose agent is done, that are clean, and whose branch is
// merged into the HEAD of the merge checkout or of the main checkout (repo ADR-0015); then their branch. A dirty or
// locked one is kept and reported. One write of slots.json retires finished, gone and stale `active` entries.
// `tracked` is only a hint: removed paths drop out of it. Answers what it removed and what it kept, for the toasts.
async function selfClean($: $, tracked: Map<string, string>, base: number, ev: SweepEvent): Promise<{ removed: string[]; kept: string[] }> {
  const windows = await isWindows($)
  const found = await projectRepo($, ev.cwd)
  if (found === undefined) return { removed: [], kept: [] }
  const repo: Repo = { top: found.main, common: found.common, mainRoot: found.main }
  const log = (line: string) => $.ui.log(`worktrees: ${line}`, { to: 'debug' })
  if (await stateUnreadable($, repo)) {
    await log('self-clean skipped: slots.json unreadable')
    return { removed: [], kept: [] }
  }
  // the refs: the checkout the merge ran in (when it is in a work tree), then the main checkout; each ref is that
  // checkout's HEAD, and every git command for it runs there
  const refs: string[] = []
  if (typeof ev.cwd === 'string' && ev.cwd !== '') {
    const top = await git($, ev.cwd, 'rev-parse', '--show-toplevel')
    if (top.ok && top.out !== '') refs.push(top.out)
  }
  if (!refs.some(r => normPath(r, windows) === normPath(found.main, windows))) refs.push(found.main)
  const isRef = (path: string) => refs.some(r => normPath(r, windows) === normPath(path, windows))
  const trees = new Map<string, string>()
  const treeOf = async (ref: string) => {
    if (!trees.has(ref)) {
      const t = await git($, ref, 'rev-parse', 'HEAD^{tree}')
      trees.set(ref, t.ok ? t.out : '')
    }
    return trees.get(ref) as string
  }
  // how the branch counts as merged: an ancestor, the same tree, then (when allowed) patch-equivalent
  const mergedBy = async (branch: string, cherry: boolean): Promise<'ancestor' | 'tree' | 'cherry' | undefined> => {
    for (const ref of refs) if ((await git($, ref, 'merge-base', '--is-ancestor', branch, 'HEAD')).ok) return 'ancestor'
    for (const ref of refs) {
      const tree = await treeOf(ref)
      if (tree !== '' && (await mergesToSameTree($, ref, 'HEAD', tree, branch)) === true) return 'tree'
    }
    if (cherry) {
      for (const ref of refs) {
        const r = await run($, ['git', 'cherry', 'HEAD', branch], ref, 60_000)
        if (cherryMerged({ exitCode: r.exitCode, stdout: r.stdout })) return 'cherry'
      }
    }
    return undefined
  }

  const worktrees = parseWorktrees((await git($, found.main, 'worktree', 'list', '--porcelain')).out)
  const state = await readState($, repo)
  const now = await $.clock.now()
  const finishedPaths: string[] = []
  const removed: string[] = []
  const kept: string[] = []
  for (const wt of worktrees) {
    const id = agentWorktreeId(wt.path, found.main, windows)
    if (id === undefined || isRef(wt.path)) continue
    const key = normPath(wt.path, windows)
    let finished = false
    if (typeof ev.transcriptPath === 'string' && ev.transcriptPath !== '') {
      const meta = metaPathFor(ev.transcriptPath, id)
      try {
        finished = (await $.fs.exists(meta)) && metaFinished((await $.fs.read(meta)) as string)
      } catch {
        finished = false // fail open: the entry stays and the agent counts as live
      }
    }
    if (finished) finishedPaths.push(wt.path)
    const live = !finished && isActive(state, wt.path, now, windows)
    if (live || !wt.branch?.startsWith('worktree-')) continue
    const branch = wt.branch
    let dirty = false
    if (wt.locked === undefined) {
      const status = await git($, wt.path, 'status', '--porcelain')
      dirty = !status.ok || status.out !== ''
    }
    // a dirty or locked worktree is reported only when its branch is merged: unmerged work is not a leak
    const by = await mergedBy(branch, wt.locked === undefined && !dirty)
    if (by === undefined) continue
    const plan = decideSelfClean({
      path: wt.path,
      registered: true,
      branch,
      locked: wt.locked,
      isSession: false,
      active: false,
      dirty,
      merged: true,
      mergedBy: by,
    })
    if (plan.kind === 'skip') {
      await log(`self-clean kept ${wt.path}: ${plan.reason}`)
      kept.push(`${wt.path} (${plan.reason})`)
      continue
    }
    const notes = await cleanWorktree($, repo, wt.path, base, true)
    if (notes.length > 0) await log(notes.join('\n'))
    const done = await removeWorktree($, found.main, wt.path, windows)
    if (!done.ok) {
      await log(`self-clean could not remove ${wt.path}: ${done.err}`)
      continue
    }
    tracked.delete(key)
    finishedPaths.push(wt.path)
    const deleted = await git($, found.main, 'branch', plan.deleteFlag, plan.branch)
    if (deleted.ok) removed.push(plan.branch)
    else {
      await log(`self-clean removed ${wt.path}; git branch ${plan.deleteFlag} ${plan.branch} refused: ${deleted.err.split('\n')[0]}`)
      removed.push(`${plan.branch}'s worktree (branch kept: git branch ${plan.deleteFlag} refused)`)
    }
  }
  // an entry whose folder is gone and that git does not list can never be worked in again
  const registered = new Set(worktrees.map(w => normPath(w.path, windows)))
  const gone: string[] = []
  for (const [key, v] of Object.entries(state.active)) {
    if (!registered.has(key) && !(await $.fs.exists(v.path))) gone.push(v.path)
  }
  await withState($, repo, async s => ({ state: sweepActive(s, { now, finished: finishedPaths, gone }, windows), value: undefined }), true)
  return { removed, kept }
}

// a session's tracked worktrees (normalised path to path) and its sweeps, which run one at a time
type Sweeps = { tracked: Map<string, string>; chain: Promise<void> }

function sweep($: $, s: Sweeps, base: number, ev: SweepEvent): Promise<void> {
  s.chain = s.chain
    .then(async () => {
      const { removed, kept } = await selfClean($, s.tracked, base, ev)
      if (removed.length > 0) await $.ui.toast(`worktrees: removed merged ${removed.join(', ')}`)
      if (kept.length > 0) await $.ui.toast(`worktrees: kept merged worktrees that need a look: ${kept.join('; ')}`)
    })
    .catch(error => $.ui.log(`worktrees: self-clean failed: ${String(error)}`, { to: 'debug' }))
  return s.chain
}

// --- tidy ---

type TidyReport = { plans: BranchPlan[]; lines: string[]; acted: boolean; removed: string[]; unmerged: string[] }

type Facts = { facts: BranchFacts[]; worktrees: Worktree[]; sync: MainSync; defaultBranch: string }

async function gatherFacts($: $, repo: Repo, windows: boolean): Promise<Facts> {
  const head = await git($, repo.top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const defaultBranch = head.ok ? head.out.replace(/^origin\//, '') : 'main'
  const state = await readState($, repo)
  const now = await $.clock.now()
  const current = (await git($, repo.top, 'branch', '--show-current')).out
  const worktrees = parseWorktrees((await git($, repo.top, 'worktree', 'list', '--porcelain')).out)
  const main = worktrees[0]
  const locals = (await git($, repo.top, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads')).out
    .split('\n')
    .filter(Boolean)
    .map(l => l.split(' ') as [string, string])
  const remotes = new Map(
    (await git($, repo.top, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin')).out
      .split('\n')
      .filter(Boolean)
      .map(l => l.split(' ') as [string, string]),
  )
  const mergedRef = remotes.has(`origin/${defaultBranch}`) ? `origin/${defaultBranch}` : defaultBranch
  const gitMerged = new Set((await git($, repo.top, 'branch', '--merged', mergedRef, '--format=%(refname:short)')).out.split('\n'))
  const hasGh = (await run($, ['gh', 'auth', 'status'], repo.top)).exitCode === 0
  const isAncestor = async (a: string, b: string) => (await git($, repo.top, 'merge-base', '--is-ancestor', a, b)).ok

  // origin/<default>'s tree, for the content check of agent branches
  const treeOf = await git($, repo.top, 'rev-parse', `${mergedRef}^{tree}`)
  const mainTree = treeOf.ok && treeOf.out !== '' ? treeOf.out : undefined

  // recently merged PRs' head commits, for agent branches merged into a branch whose PR was squash-merged:
  // one gh call per run, the heads present locally in one cat-file, and the commits they hold outside the default branch
  let mergedHeads: MergedHead[] = []
  const present = new Set<string>()
  let inHeads = new Set<string>()
  if (hasGh && locals.some(([b]) => b.startsWith('worktree-'))) {
    const r = await run($, ['gh', 'pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,headRefOid,headRefName'], repo.top, 60_000)
    try {
      if (r.exitCode === 0) mergedHeads = (JSON.parse(r.stdout) as { number: number; headRefOid: string }[]).map(p => ({ number: p.number, head: p.headRefOid }))
    } catch {
      mergedHeads = []
    }
    if (mergedHeads.length > 0) {
      const check = await $.process.run(['git', 'cat-file', '--batch-check=%(objectname) %(objecttype)'], {
        cwd: repo.top,
        stdin: mergedHeads.map(h => h.head).join('\n') + '\n',
        timeoutMs: 60_000,
      })
      for (const line of check.stdout.replace(/\r/g, '').split('\n')) {
        const [sha, type] = line.split(' ')
        if (sha && type === 'commit') present.add(sha)
      }
      if (present.size > 0) {
        const argv = ['git', 'rev-list', ...present, '--not', mergedRef]
        const listed = await run($, argv, repo.top, 120_000)
        if (listed.exitCode === 0) inHeads = new Set(listed.stdout.replace(/\r/g, '').split('\n').filter(Boolean))
      }
    }
  }

  // the local default branch, fast-forwarded when strictly behind origin's
  const localMain = locals.find(([b]) => b === defaultBranch)?.[1]
  const remoteMain = remotes.get(`origin/${defaultBranch}`)
  const mainWt = worktrees.find(w => w.branch === defaultBranch)
  const mainStatus = mainWt !== undefined && (await $.fs.exists(mainWt.path)) ? await git($, mainWt.path, 'status', '--porcelain', '--untracked-files=no') : undefined
  const sync = decideMainSync({
    branch: defaultBranch,
    local: localMain,
    remote: remoteMain,
    behind: localMain !== undefined && remoteMain !== undefined && (await isAncestor(localMain, remoteMain)),
    checkedOut: mainWt === undefined ? undefined : { path: mainWt.path, dirty: mainStatus === undefined || !mainStatus.ok || mainStatus.out !== '' },
  })

  const facts: BranchFacts[] = []
  for (const [branch, tip] of locals) {
    const wt = worktrees.find(w => w.branch === branch)
    const isProtected = [defaultBranch, 'main', 'master', current, main?.branch].includes(branch)
    let pr: BranchFacts['pr']
    let heads: string[] = []
    if (hasGh && !isProtected) {
      const r = await run($, ['gh', 'pr', 'list', '--state', 'merged', '--head', branch, '--json', 'number,headRefOid', '--limit', '10'], repo.top, 60_000)
      if (r.exitCode === 0) {
        try {
          const list = JSON.parse(r.stdout) as { number: number; headRefOid: string }[]
          pr = { numbers: list.map(p => p.number) }
          heads = list.map(p => p.headRefOid)
        } catch {
          pr = undefined
        }
      }
    }
    let unpushed = 0
    let inMergedPr: number | undefined
    let contentMerged: boolean | undefined
    if (branch.startsWith('worktree-') && !isProtected && !gitMerged.has(branch) && mainTree !== undefined) {
      contentMerged = await mergesToSameTree($, repo.top, mergedRef, mainTree, branch)
    }
    if (!isProtected) {
      let inMergedHead = false
      if (contentMerged === undefined && branch.startsWith('worktree-') && !(pr?.numbers.length) && !gitMerged.has(branch) && (inHeads.has(tip) || present.has(tip))) {
        const contains = new Set<string>()
        for (const h of mergedHeads) if (present.has(h.head) && h.head !== tip && (await isAncestor(tip, h.head))) contains.add(h.head)
        inMergedPr = findMergedPr(tip, mergedHeads, present, contains)
        if (inMergedPr !== undefined) {
          inMergedHead = true
          heads = [...heads, mergedHeads.find(h => h.number === inMergedPr)!.head]
        }
      }
      for (const h of heads) if (h === tip || (await isAncestor(tip, h))) inMergedHead = true
      if (!inMergedHead) unpushed = Number((await git($, repo.top, 'rev-list', '--count', branch, '--not', '--remotes')).out) || 0
    }
    const ahead = branch.startsWith('worktree-') && !isProtected ? Number((await git($, repo.top, 'rev-list', '--count', branch, '--not', mergedRef)).out) || 0 : undefined
    let worktree: BranchFacts['worktree']
    if (wt !== undefined) {
      const exists = !wt.prunable && (await $.fs.exists(wt.path))
      const status = exists ? await git($, wt.path, 'status', '--porcelain') : { ok: true, out: '' }
      worktree = {
        path: wt.path,
        exists,
        dirty: !status.ok || status.out !== '',
        locked: wt.locked,
        isMain: wt === main,
        isSession: normPath(wt.path, windows) === normPath(repo.top, windows),
        isActive: isActive(state, wt.path, now, windows),
      }
    }
    let remote: BranchFacts['remote']
    const remoteTip = remotes.get(`origin/${branch}`)
    if (remoteTip !== undefined) {
      let safe = false
      if (pr !== undefined || inMergedPr !== undefined) for (const h of heads) if (h === remoteTip || (await isAncestor(remoteTip, h))) safe = true
      if (!safe) safe = await isAncestor(remoteTip, mergedRef)
      // content already in the default branch: the remote branch is safe when it holds nothing the local one lacks
      if (!safe && contentMerged === true) safe = await isAncestor(remoteTip, tip)
      remote = { safe }
    }
    facts.push({ branch, isProtected, pr, gitMerged: gitMerged.has(branch), unpushed, ahead, inMergedPr, contentMerged, worktree, remote })
  }
  return { facts, worktrees, sync, defaultBranch }
}

export async function tidy($: $, options: Record<string, unknown>, dryRun: boolean): Promise<TidyReport | undefined> {
  const repo = await repoAt($)
  if (repo === undefined) return undefined
  const windows = await isWindows($)
  const lines: string[] = []
  let acted = false
  if (!(await git($, repo.top, 'fetch', '--prune', 'origin')).ok) lines.push('git fetch failed; using the remote branches as last fetched')
  const { facts, worktrees, sync, defaultBranch } = await gatherFacts($, repo, windows)
  const plans = facts.map(decideBranch)
  const removed: string[] = []

  if (sync.kind === 'none' && sync.reason) lines.push(sync.reason)
  if (sync.kind !== 'none') {
    const what = `fast-forward ${defaultBranch} to origin/${defaultBranch} (${sync.to.slice(0, 7)})`
    if (dryRun) lines.push(`would: ${what}`)
    else {
      const done =
        sync.kind === 'update-ref'
          ? await git($, repo.top, 'update-ref', `refs/heads/${defaultBranch}`, sync.to, sync.from)
          : await git($, sync.worktree, 'merge', '--ff-only', '--quiet', `origin/${defaultBranch}`)
      lines.push(done.ok ? `${what}: done` : `${what} failed: ${done.err.split('\n')[0]}`)
      if (done.ok) acted = true
    }
  }

  if (!dryRun && plans.some(p => p.kind === 'delete' && p.prune)) await git($, repo.top, 'worktree', 'prune')
  const base = portBaseOf(options)
  for (const plan of plans) {
    if (plan.kind === 'skip') continue
    if (dryRun) {
      lines.push(`would: ${describePlan(plan)}`)
      if (plan.worktreePath) lines.push(...(await stopProcesses($, windows, [plan.worktreePath], [], true)).map(l => `  ${l}`))
      continue
    }
    acted = true
    if (plan.worktreePath) {
      lines.push(...(await cleanWorktree($, repo, plan.worktreePath, base, false)))
      const removed = await removeWorktree($, repo.top, plan.worktreePath, windows)
      if (!removed.ok) {
        lines.push(`${plan.branch}: worktree remove failed, left the branch: ${removed.err}`)
        continue
      }
      if (removed.note !== undefined) lines.push(`${plan.branch}: ${removed.note}`)
      const gone = plan.worktreePath
      await withState($, repo, async s => ({ state: markDone({ ...s, slots: releaseSlot(s.slots, gone, windows) }, gone, windows), value: undefined }))
    }
    let deleted = await git($, repo.top, 'branch', '-d', plan.branch)
    if (!deleted.ok && plan.allowForce) deleted = await git($, repo.top, 'branch', '-D', plan.branch)
    if (!deleted.ok) {
      lines.push(`${plan.branch}: branch delete failed: ${deleted.err.split('\n')[0]}`)
      continue
    }
    let line = `removed ${describePlan(plan)}`
    if (plan.deleteRemote) {
      const pushed = await git($, repo.top, 'push', 'origin', '--delete', plan.branch)
      if (!pushed.ok) line += ` (remote delete failed: ${pushed.err.split('\n')[0]})`
    }
    lines.push(line)
    removed.push(plan.branch)
  }
  if (acted) await git($, repo.top, 'fetch', '--prune', 'origin')

  // orphans: processes naming a worktree folder of this repo that no longer exists, and slots whose folder is gone
  const prefix = normPath(`${repo.mainRoot}/.claude/worktrees`, windows) + '/'
  const live = new Set(worktrees.map(w => normPath(w.path, windows)))
  const snap = await snapshot($, windows, false)
  const dead = new Set<string>()
  for (const p of snap?.procs ?? []) {
    for (const path of worktreeMentions(p.cmd, prefix, windows)) {
      if (!live.has(path) && !dead.has(path) && !(await $.fs.exists(path))) dead.add(path)
    }
  }
  const table = (await readState($, repo)).slots
  const deadSlots: [number, Slot][] = []
  for (const [n, s] of Object.entries(table.slots)) if (!(await $.fs.exists(s.path))) deadSlots.push([Number(n), s])
  const orphanPorts = deadSlots.flatMap(([n]) => ports(base, n))
  const orphanPaths = [...dead, ...deadSlots.map(([, s]) => s.path)]
  if (orphanPaths.length > 0) {
    const stopped = await stopProcesses($, windows, orphanPaths, orphanPorts, dryRun)
    lines.push(...stopped.map(l => `orphan: ${l}`))
    if (!dryRun && stopped.some(l => l.startsWith('stopped'))) acted = true
    if (!dryRun && deadSlots.length > 0) {
      await withState($, repo, async t => ({
        state: deadSlots.reduce((acc, [, s]) => markDone({ ...acc, slots: releaseSlot(acc.slots, s.path, windows) }, s.path, windows), t),
        value: undefined,
      }))
      lines.push(`released slot${deadSlots.length === 1 ? '' : 's'} ${deadSlots.map(([n]) => n).join(', ')} (worktree gone)`)
    }
  }
  // agent branches never merged: reported, never deleted
  const unmerged = unmergedAgentWork(facts)
  lines.push(...unmerged)
  for (const plan of plans) if (plan.kind === 'skip') lines.push(describePlan(plan))
  return { plans, lines, acted, removed, unmerged }
}

// ---------------------------------------------------------------------------------------------------------------

// a hook of this plugin that fails leaves the call to the hooks beneath and the engine
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const passThrough = ($: unknown, e: any, next: any) => next(e)

export const register: Register = (on, options) => {
  const noIsolate = noIsolateTypes(options.noIsolateAgents, options.readOnlyAgents)
  const isolateNested = options.isolateNestedRepos === true || options.isolateNestedRepos === 'true'
  const base = portBaseOf(options)
  // the repo this session works for, kept once found; a failed search is never kept
  let repoFound: ProjectRepo | undefined
  // whether this session's repo keeps its agents in the main checkout for its nested repos, found once; and
  // whether the session was told so
  let nested: Promise<{ skip: boolean; toast: string }> | undefined
  let toldNested = false
  // the worktrees this session's WorktreeCreate made or reused; in memory on purpose: what a resumed or crashed
  // session left is for /tidy
  const own: Sweeps = { tracked: new Map(), chain: Promise.resolve() }
  const tracked = own.tracked

  // 1. Every Agent call that can edit gets a worktree.
  let toldFailed = false
  on('classic.PreToolUse', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const type = typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : 'general-purpose'
    const log = async (text: string) => {
      try {
        await $.ui.log(text, { to: 'debug' })
      } catch {
        // the log is best effort
      }
    }
    const skipped = (reason: string) => log(`worktrees: isolation skipped ${type}: ${reason}`)
    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      if (input.isolation !== undefined) {
        await skipped('explicit isolation')
        return next(e)
      }
      repoFound ??= await projectRepo($, (e as unknown as { cwd?: string }).cwd)
      const repo = repoFound
      if (repo === undefined) {
        await skipped('no repo found')
        return next(e)
      }
      if (!needsWorktree(input, true, noIsolate)) {
        await skipped('no-isolate type')
        return next(e)
      }
      if (!isolateNested) {
        nested ??= nestedRepos($, repo.main).catch(error => {
          nested = undefined
          throw error
        })
        const found = await nested
        if (found.skip) {
          if (!toldNested) {
            toldNested = true
            await $.ui.toast(found.toast)
          }
          await skipped('nested repos')
          return next(e)
        }
      }
      if (await declaredByKit($, input, repo.main)) {
        await skipped('kit manifest declares it read-only')
        return next(e)
      }
      result = await next(e)
      if (result.deny !== undefined || result.updatedInput !== undefined) {
        await skipped('another hook answered')
        return result
      }
      await log(`worktrees: isolating ${type}`)
      return { ...result, updatedInput: withWorktree(input) }
    } catch (error) {
      await log(`worktrees: isolation failed for ${type}: ${String(error)}`)
      if (!toldFailed) {
        toldFailed = true
        try {
          await $.ui.toast(`worktrees: could not give ${type} a worktree; it runs in the current checkout. See the debug log.`)
        } catch {
          // the toast is best effort
        }
      }
      return result ?? next(e)
    }
  }).catch(passThrough)

  // 2. The plugin creates every worktree itself, from the HEAD of the checkout the hook runs in: Claude Code's
  // default starts from origin/HEAD and misses the session's unmerged work. Then `.worktreeinclude` files are
  // copied, and the repo's setup script runs with a slot of ports.
  on('classic.WorktreeCreate', async ($, e, next) => {
    const windows = await isWindows($)
    // ADR-0015 section 4: the checkout the hook runs in, else the project repo (cwd may be inside the git dir)
    let repo = await repoAt($, e.cwd)
    if (repo === undefined) {
      const found = await projectRepo($, e.cwd)
      if (found !== undefined) repo = { top: found.main, common: found.common, mainRoot: found.main }
    }
    if (repo === undefined || !/^[A-Za-z0-9._-]+$/.test(e.name)) return next(e)
    const path = `${repo.mainRoot}/.claude/worktrees/${e.name}`
    const branch = `worktree-${e.name}`
    // recorded before anything is created, so a sweep while git and the file copies run sees the agent as live
    const now = await $.clock.now()
    await withState($, repo, async state => ({ state: markActive(state, path, now, windows), value: undefined }))
    tracked.set(normPath(path, windows), path)
    const head = await git($, e.cwd, 'rev-parse', '--verify', '--quiet', 'HEAD')
    const plan = planCreate({
      pathExists: await $.fs.exists(path),
      branchExists: (await git($, repo.top, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).ok,
      head: head.ok ? head.out : undefined,
    })
    if (plan.kind === 'default') return next(e)
    if (plan.kind !== 'reuse') {
      const added =
        plan.kind === 'add-branch'
          ? await git($, repo.top, 'worktree', 'add', path, branch)
          : await git($, repo.top, 'worktree', 'add', '-b', branch, path, plan.base)
      if (!added.ok) {
        await $.ui.toast(`worktrees: git worktree add failed; using the default worktree`)
        await $.ui.log(`worktrees: git worktree add ${path}: ${added.err}`, { to: 'debug' })
        await withState($, repo, async state => ({ state: markDone(state, path, windows), value: undefined }))
        tracked.delete(normPath(path, windows))
        return next(e)
      }
      const copied = await copyIncluded($, repo, path, windows)
      if (copied !== '') await $.ui.log(`worktrees: ${copied}`, { to: 'debug' })
    }
    const script = `${repo.top}/.claude/worktree-setup.${windows ? 'ps1' : 'sh'}`
    if (!(await $.fs.exists(script))) return { worktreePath: path }

    const slot = await withState($, repo, async state => {
      const claimed = claimSlot(state.slots, path, e.name, now, windows)
      return { state: { ...state, slots: claimed.table }, value: claimed.slot }
    })
    const [from, to] = portRange(base, slot)
    const env = { WORKTREE_PATH: path, WORKTREE_NAME: e.name, WORKTREE_SLOT: String(slot), PORT_BASE: String(from), REPO_ROOT: repo.mainRoot }
    const argvs = windows
      ? [
          ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        ]
      : [['bash', script]]
    let ran: { exitCode: number; stderr: string } = { exitCode: -1, stderr: 'no shell started' }
    for (const argv of argvs) {
      try {
        ran = await $.process.run(argv, { cwd: path, env, timeoutMs: 600_000 })
        break
      } catch (error) {
        ran = { exitCode: -1, stderr: String(error) }
      }
    }
    if (ran.exitCode !== 0) {
      await $.ui.toast(`worktrees: setup script failed in ${e.name} (exit ${ran.exitCode}); the worktree is there without it`)
      await $.ui.log(`worktrees: ${script} in ${path}: ${ran.stderr.slice(-2000)}`, { to: 'debug' })
    } else {
      await $.ui.log(`worktrees: ${e.name} set up in slot ${slot}, ports ${from}-${to}`, { to: 'debug' })
    }
    return { worktreePath: path }
  }).catch(passThrough)

  // 3. Removing a worktree first stops what runs in it, then releases its slot.
  on('classic.WorktreeRemove', async ($, e, next) => {
    const repo = await repoAt($, e.cwd)
    if (repo !== undefined && worktreeRootOf(e.worktree_path) !== undefined) {
      const notes = await cleanWorktree($, repo, e.worktree_path, base, true)
      if (notes.length > 0) await $.ui.log(`worktrees: ${notes.join('\n')}`, { to: 'debug' })
    }
    return next(e)
  }).catch(passThrough)

  // ...and so does an agent that ran in one ending. Its slot stays while its folder does.
  // An agent that still runs a background shell or monitor of its own, or leaves uncommitted changes in its worktree,
  // is sent back once to deal with them. Changes still uncommitted when the stop goes through are committed for it.
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    const live = liveWork(e.background_tasks)
    const inTranscript = live.length > 0 ? await idsInTranscript($, e.agent_transcript_path, live.map(t => t.id)) : new Set<string>()
    const wt = await agentWorktree($, e.cwd, e.agent_id)
    const dirty = wt === undefined ? undefined : await dirtyOf($, wt)
    // nothing is cleaned up for a refused stop
    const decision = decideStop({ stopHookActive: e.stop_hook_active, tasks: live, inTranscript, dirty })
    if (decision.kind === 'block') return { ...result, block: result.block ? `${result.block}\n\n${decision.reason}` : decision.reason }
    if (decision.owned.length > 0) {
      const left = decision.owned.map(t => `${t.id} ${t.command ?? t.description}`).join('; ')
      await $.ui.log(`worktrees: ${e.agent_type} ${e.agent_id} stopped again with background work still running: ${left}`, { to: 'debug' })
    }
    // before the processes are stopped and the slot released
    if (decision.commit && wt !== undefined && dirty !== undefined) await commitLeftovers($, wt, dirty, e.agent_type, e.agent_id)
    const repo = await repoAt($, e.cwd)
    if (repo === undefined) return result
    const candidates = [worktreeRootOf(e.cwd), `${repo.mainRoot}/.claude/worktrees/agent-${e.agent_id}`]
    const windows = await isWindows($)
    const seen = new Set<string>()
    for (const path of candidates) {
      if (path === undefined || seen.has(normPath(path, windows))) continue
      seen.add(normPath(path, windows))
      if (normPath(path, windows) === normPath(repo.mainRoot, windows)) continue
      // a session that itself runs in a worktree keeps what it started there
      const own = worktreeRootOf(await $.session.cwd())
      if (own !== undefined && normPath(own, windows) === normPath(path, windows)) continue
      const table = (await readState($, repo)).slots
      if (!(await $.fs.exists(path)) && slotOf(table, path, windows) === undefined) continue
      // the process probe takes seconds on Windows: run it after the agent's stop, not inside it
      $.clock.after(0, () => {
        void (async () => {
          const notes = await cleanWorktree($, repo, path, base, false)
          const stopped = notes.filter(n => n.startsWith('stopped')).length
          if (stopped > 0) await $.ui.toast(`worktrees: stopped ${stopped} process${stopped === 1 ? '' : 'es'} left by ${e.agent_type}`)
          if (notes.length > 0) await $.ui.log(`worktrees: ${notes.join('\n')}`, { to: 'debug' })
        })().catch(error => $.ui.log(`worktrees: cleanup failed: ${String(error)}`, { to: 'debug' }))
      })
    }
    return result
  }).catch(passThrough)

  // 4. An editing agent is told to commit on its branch; the main thread, to merge an agent's branch before using it.
  // SubagentStart's cwd may be the session's, not the worktree's: agentWorktree also looks for agent-<id>.
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    const wt = await agentWorktree($, e.cwd, e.agent_id)
    await $.ui.log(`worktrees: ${e.agent_type} ${e.agent_id} started; cwd ${e.cwd}; worktree ${wt?.path ?? 'none'}`, { to: 'debug' })
    if (wt === undefined) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), startContext(wt.branch)] }
  }).catch(passThrough)

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if ((await git($, e.cwd, 'rev-parse', '--is-inside-work-tree')).out !== 'true') return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), SESSION_CONTEXT] }
  }).catch(passThrough)

  // 5. After the session runs a merge, its own agents' worktrees whose branch is now merged are removed, in the
  // background: the process probe takes seconds on Windows. Everything else is /tidy's, on demand.
  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if ((e.tool_name !== 'Bash' && e.tool_name !== 'PowerShell')) return result
    const command = (e.tool_input as { command?: unknown } | null)?.command
    if (typeof command !== 'string' || !/\bmerge\b/.test(command)) return result
    const ev = e as unknown as { cwd?: string; transcript_path?: string }
    $.clock.after(0, () => void sweep($, own, base, { cwd: ev.cwd, transcriptPath: ev.transcript_path }))
    return result
  }).catch(passThrough)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tidy',
      description: 'Remove worktrees and branches whose PR merged, and stop processes left in deleted worktrees',
      argumentHint: '[dry-run]',
    })
    return started
  })

  on('command.run', { command: 'tidy' }, async ($, e) => {
    const dryRun = /dry/i.test(e.args)
    const report = await tidy($, options, dryRun)
    if (report === undefined) return { text: 'Not in a git repository with a main checkout.' }
    const head = dryRun ? 'Dry run, nothing changed.' : report.acted ? 'Tidied.' : 'Nothing to remove.'
    return { text: [head, ...report.lines].join('\n') }
  })
}
