import type { EngineInterface, Register } from 'claude-code'

// ---------------------------------------------------------------------------------------------------------------
// Pure logic: every decision the hooks make, kept apart from the commands that gather facts and act on them.
// ---------------------------------------------------------------------------------------------------------------

// agent types that only read, so they run in the session's own checkout
export const READ_ONLY_AGENTS = ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'scout', 'reviewer']

// the Agent tool's own arguments, the ones an updatedInput may carry back
const AGENT_KEYS = ['description', 'prompt', 'subagent_type', 'model', 'effort', 'name', 'team_name', 'mode', 'run_in_background', 'isolation']

// the configured extra read-only types: a comma-separated string, or a list
export function readOnlyTypes(extra: unknown): Set<string> {
  const more = Array.isArray(extra) ? extra.map(String) : typeof extra === 'string' ? extra.split(',') : []
  return new Set([...READ_ONLY_AGENTS, ...more].map(t => t.trim().toLowerCase()).filter(t => t !== ''))
}

// An Agent call gets a worktree when nothing chose its isolation, the session is in a git repo, and its type can
// edit. An unset type is general-purpose, which can.
export function needsWorktree(input: { isolation?: unknown; subagent_type?: unknown }, inRepo: boolean, readOnly: Set<string>): boolean {
  if (input.isolation !== undefined && input.isolation !== null) return false
  if (!inRepo) return false
  const type = typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : 'general-purpose'
  return !readOnly.has(type.toLowerCase())
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
  // `git branch --merged origin/<default>` lists it
  gitMerged: boolean
  // commits on it that are neither on any remote branch nor in a merged PR's head
  unpushed: number
  worktree?: { path: string; exists: boolean; dirty: boolean; locked?: string; isMain: boolean; isSession: boolean }
  // origin's branch of the same name; safe when every commit on it is in the merged PR (or, without gh, in the default branch)
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
      // `git branch -D` is allowed after `-d` refuses: only when gh confirmed the merged PR
      allowForce: boolean
      deleteRemote: boolean
      remoteNote?: string
    }

export function decideBranch(f: BranchFacts): BranchPlan {
  const skip = (reason: string): BranchPlan => ({ kind: 'skip', branch: f.branch, reason })
  if (f.isProtected) return skip('default or checked-out branch')
  if (f.worktree?.isMain) return skip('checked out in the main checkout')
  if (f.worktree?.isSession) return skip('this session works in its worktree')
  const merged = f.pr !== undefined ? f.pr.numbers.length > 0 : f.gitMerged
  if (!merged) return skip(f.pr !== undefined ? 'no merged PR' : 'not merged into the default branch (gh unavailable)')
  if (f.worktree?.locked !== undefined) return skip(`worktree is locked (${f.worktree.locked})`)
  if (f.worktree?.dirty) return skip('worktree has uncommitted changes')
  if (f.unpushed > 0) return skip(`${f.unpushed} commit${f.unpushed === 1 ? '' : 's'} on no remote and in no merged PR`)
  const via = f.pr !== undefined ? `PR #${f.pr.numbers[0]}` : 'git branch --merged'
  return {
    kind: 'delete',
    branch: f.branch,
    via,
    worktreePath: f.worktree?.exists ? f.worktree.path : undefined,
    prune: f.worktree !== undefined && !f.worktree.exists,
    allowForce: f.pr !== undefined && f.pr.numbers.length > 0,
    deleteRemote: f.remote?.safe === true,
    remoteNote: f.remote !== undefined && !f.remote.safe ? 'remote branch has commits outside the merge; left it' : undefined,
  }
}

export function describePlan(plan: BranchPlan): string {
  if (plan.kind === 'skip') return `skip ${plan.branch}: ${plan.reason}`
  const parts = [plan.worktreePath ? `remove worktree ${plan.worktreePath}` : plan.prune ? 'prune its missing worktree' : '', `delete branch`]
  if (plan.deleteRemote) parts.push('delete origin/' + plan.branch)
  if (plan.remoteNote) parts.push(plan.remoteNote)
  return `${plan.branch} (${plan.via}): ${parts.filter(Boolean).join('; ')}`
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

const slotFile = (repo: Repo) => `${repo.common}/claude-worktrees/slots.json`

// slot-table writes in this process run one at a time, so parallel agents never draw the same slot
let slotChain: Promise<unknown> = Promise.resolve()
function withSlots<T>($: $, repo: Repo, fn: (table: SlotTable) => Promise<{ table: SlotTable; value: T }>): Promise<T> {
  const step = slotChain.then(async () => {
    const text = (await $.fs.exists(slotFile(repo))) ? await $.fs.read(slotFile(repo)) : undefined
    const { table, value } = await fn(parseSlots(text as string | undefined))
    await $.fs.write(slotFile(repo), JSON.stringify(table, null, 2) + '\n')
    return value
  })
  slotChain = step.catch(() => undefined)
  return step
}

function portBaseOf(options: Record<string, unknown>): number {
  const n = Number(options.portBase ?? 4000)
  return Number.isFinite(n) && n >= 1024 && n <= 64_000 ? Math.floor(n) : 4000
}

// Stops a worktree's processes and the ones on its slot's ports. The slot is released when `release` is set,
// or when the worktree folder is gone.
async function cleanWorktree($: $, repo: Repo, path: string, base: number, release: boolean): Promise<string[]> {
  const windows = await isWindows($)
  const slot = slotOf(parseSlots((await $.fs.exists(slotFile(repo))) ? ((await $.fs.read(slotFile(repo))) as string) : undefined), path, windows)
  const notes = await stopProcesses($, windows, [path], slot === undefined ? [] : ports(base, slot))
  if (slot !== undefined && (release || !(await $.fs.exists(path)))) {
    await withSlots($, repo, async table => ({ table: releaseSlot(table, path, windows), value: undefined }))
  }
  return notes
}

// --- tidy ---

type TidyReport = { plans: BranchPlan[]; lines: string[]; acted: boolean }

async function gatherFacts($: $, repo: Repo, windows: boolean): Promise<{ facts: BranchFacts[]; worktrees: Worktree[] }> {
  const head = await git($, repo.top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const defaultBranch = head.ok ? head.out.replace(/^origin\//, '') : 'main'
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
    if (!isProtected) {
      let inMergedHead = false
      for (const h of heads) if (h === tip || (await isAncestor(tip, h))) inMergedHead = true
      if (!inMergedHead) unpushed = Number((await git($, repo.top, 'rev-list', '--count', branch, '--not', '--remotes')).out) || 0
    }
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
      }
    }
    let remote: BranchFacts['remote']
    const remoteTip = remotes.get(`origin/${branch}`)
    if (remoteTip !== undefined) {
      let safe = false
      if (pr !== undefined) for (const h of heads) if (h === remoteTip || (await isAncestor(remoteTip, h))) safe = true
      if (pr === undefined) safe = await isAncestor(remoteTip, mergedRef)
      remote = { safe }
    }
    facts.push({ branch, isProtected, pr, gitMerged: gitMerged.has(branch), unpushed, worktree, remote })
  }
  return { facts, worktrees }
}

export async function tidy($: $, options: Record<string, unknown>, dryRun: boolean): Promise<TidyReport | undefined> {
  const repo = await repoAt($)
  if (repo === undefined) return undefined
  const windows = await isWindows($)
  const lines: string[] = []
  let acted = false
  if (!(await git($, repo.top, 'fetch', '--prune', 'origin')).ok) lines.push('git fetch failed; using the remote branches as last fetched')
  const { facts, worktrees } = await gatherFacts($, repo, windows)
  const plans = facts.map(decideBranch)

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
      const removed = await git($, repo.top, 'worktree', 'remove', plan.worktreePath)
      if (!removed.ok) {
        lines.push(`${plan.branch}: worktree remove failed, left the branch: ${removed.err.split('\n')[0]}`)
        continue
      }
      await withSlots($, repo, async table => ({ table: releaseSlot(table, plan.worktreePath as string, windows), value: undefined }))
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
  const table = parseSlots((await $.fs.exists(slotFile(repo))) ? ((await $.fs.read(slotFile(repo))) as string) : undefined)
  const deadSlots: [number, Slot][] = []
  for (const [n, s] of Object.entries(table.slots)) if (!(await $.fs.exists(s.path))) deadSlots.push([Number(n), s])
  const orphanPorts = deadSlots.flatMap(([n]) => ports(base, n))
  const orphanPaths = [...dead, ...deadSlots.map(([, s]) => s.path)]
  if (orphanPaths.length > 0) {
    const stopped = await stopProcesses($, windows, orphanPaths, orphanPorts, dryRun)
    lines.push(...stopped.map(l => `orphan: ${l}`))
    if (!dryRun && stopped.some(l => l.startsWith('stopped'))) acted = true
    if (!dryRun && deadSlots.length > 0) {
      await withSlots($, repo, async t => ({ table: deadSlots.reduce((acc, [, s]) => releaseSlot(acc, s.path, windows), t), value: undefined }))
      lines.push(`released slot${deadSlots.length === 1 ? '' : 's'} ${deadSlots.map(([n]) => n).join(', ')} (worktree gone)`)
    }
  }
  for (const plan of plans) if (plan.kind === 'skip') lines.push(describePlan(plan))
  return { plans, lines, acted }
}

// a SessionStart tidy at most every 10 minutes per repo, so resumes and parallel sessions do not repeat it
const TIDY_EVERY_MS = 10 * 60_000

async function tidyOnStart($: $, options: Record<string, unknown>): Promise<void> {
  const repo = await repoAt($)
  if (repo === undefined) return
  const stamp = `${repo.common}/claude-worktrees/last-tidy.json`
  const now = await $.clock.now()
  if (await $.fs.exists(stamp)) {
    const last = Number((JSON.parse((await $.fs.read(stamp)) as string) as { at?: number }).at ?? 0)
    if (now - last < TIDY_EVERY_MS) return
  }
  await $.fs.write(stamp, JSON.stringify({ at: now }) + '\n')
  const report = await tidy($, options, false)
  if (report === undefined) return
  await $.ui.log(`worktrees tidy:\n${report.lines.join('\n')}`, { to: 'debug' })
  const removed = report.lines.filter(l => l.startsWith('removed ')).length
  const stopped = report.lines.filter(l => l.startsWith('orphan: stopped')).length
  if (removed + stopped > 0) {
    const skipped = report.plans.filter(p => p.kind === 'skip').length
    await $.ui.toast(
      `worktrees: removed ${removed} merged branch${removed === 1 ? '' : 'es'}, stopped ${stopped} orphan process${stopped === 1 ? '' : 'es'}` +
        (skipped > 0 ? `; ${skipped} skipped (/tidy dry-run says why)` : ''),
    )
  }
}

// ---------------------------------------------------------------------------------------------------------------

// a hook of this plugin that fails leaves the call to the hooks beneath and the engine
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const passThrough = ($: unknown, e: any, next: any) => next(e)

export const register: Register = (on, options) => {
  const readOnly = readOnlyTypes(options.readOnlyAgents)
  const base = portBaseOf(options)
  let inRepo: boolean | undefined

  // 1. Every Agent call that can edit gets a worktree.
  on('classic.PreToolUse', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    if (input.isolation !== undefined) return next(e)
    inRepo ??= (await git($, undefined, 'rev-parse', '--is-inside-work-tree')).out === 'true'
    if (!needsWorktree(input, inRepo, readOnly)) return next(e)
    const result = await next(e)
    if (result.deny !== undefined || result.updatedInput !== undefined) return result
    return { ...result, updatedInput: withWorktree(input) }
  }).catch(passThrough)

  // 2. A repo with a setup script gets worktrees this plugin creates, each with a slot of ports.
  on('classic.WorktreeCreate', async ($, e, next) => {
    const windows = await isWindows($)
    const repo = await repoAt($, e.cwd)
    if (repo === undefined || !/^[A-Za-z0-9._-]+$/.test(e.name)) return next(e)
    const script = `${repo.top}/.claude/worktree-setup.${windows ? 'ps1' : 'sh'}`
    if (!(await $.fs.exists(script))) return next(e)

    const path = `${repo.mainRoot}/.claude/worktrees/${e.name}`
    const branch = `worktree-${e.name}`
    if (!(await $.fs.exists(path))) {
      const head = await git($, repo.top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      const start = head.ok ? head.out : 'HEAD'
      const exists = (await git($, repo.top, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).ok
      const added = exists
        ? await git($, repo.top, 'worktree', 'add', path, branch)
        : await git($, repo.top, 'worktree', 'add', '-b', branch, path, start)
      if (!added.ok) {
        await $.ui.toast(`worktrees: git worktree add failed; using the default worktree`)
        await $.ui.log(`worktrees: git worktree add ${path}: ${added.err}`, { to: 'debug' })
        return next(e)
      }
    }
    const now = await $.clock.now()
    const slot = await withSlots($, repo, async table => {
      const claimed = claimSlot(table, path, e.name, now, windows)
      return { table: claimed.table, value: claimed.slot }
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
  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
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
      const table = parseSlots((await $.fs.exists(slotFile(repo))) ? ((await $.fs.read(slotFile(repo))) as string) : undefined)
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

  // 4. Merged branches: tidied in the background at start, and on demand with /tidy.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tidy',
      description: 'Remove worktrees and branches whose PR merged, and stop processes left in deleted worktrees',
      argumentHint: '[dry-run]',
    })
    if (options.tidyOnStart !== false) {
      $.clock.after(3000, () => {
        void tidyOnStart($, options).catch(error => $.ui.log(`worktrees: tidy failed: ${String(error)}`, { to: 'debug' }))
      })
    }
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
