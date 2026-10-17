import { expect, test } from 'claude-code/testing'

import type { BackgroundTask, BranchFacts, SelfCleanFacts, Snapshot } from '../hooks/register'
import {
  ACTIVE_FOR_MS,
  claimSlot,
  decideBranch,
  decideMainSync,
  decideSelfClean,
  countChanges,
  decideStop,
  findMergedPr,
  SESSION_CONTEXT,
  startContext,
  unmergedAgentWork,
  WIP_MESSAGE,
  includedFiles,
  isActive,
  lockStep,
  markActive,
  markDone,
  parseState,
  planCreate,
  serializeState,
  mentions,
  needsWorktree,
  parseLinuxSnapshot,
  parseSlots,
  parseWindowsSnapshot,
  parseWorktrees,
  portRange,
  ignoredDirs,
  nestedToast,
  noIsolateTypes,
  skipForNested,
  releaseSlot,
  safeGroups,
  selectVictims,
  withWorktree,
  worktreeMentions,
  worktreeRootOf,
} from '../hooks/register'

const RO = noIsolateTypes('')

test('gives an editing agent a worktree, and a reading one none', async () => {
  expect(needsWorktree({ subagent_type: 'general-purpose' }, true, RO)).toBe(true)
  expect(needsWorktree({}, true, RO)).toBe(true)
  expect(needsWorktree({ subagent_type: 'fork' }, true, RO)).toBe(true)
  for (const t of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'scout', 'reviewer', 'explore']) {
    expect(needsWorktree({ subagent_type: t }, true, RO)).toBe(false)
  }
  // a plugin's agent matches by its bare name
  expect(needsWorktree({ subagent_type: 'kit:scout' }, true, RO)).toBe(false)
  expect(needsWorktree({ subagent_type: 'kit:reviewer' }, true, RO)).toBe(false)
  expect(needsWorktree({ subagent_type: 'kit:builder' }, true, RO)).toBe(true)
  // a choice already made stands, remote included; outside a repo nothing changes
  expect(needsWorktree({ isolation: 'remote' }, true, RO)).toBe(false)
  expect(needsWorktree({ isolation: 'worktree' }, true, RO)).toBe(false)
  expect(needsWorktree({ subagent_type: 'general-purpose' }, false, RO)).toBe(false)
  // the configured list adds to the defaults
  const more = noIsolateTypes('auditor, Linter ,')
  expect(needsWorktree({ subagent_type: 'linter' }, true, more)).toBe(false)
  expect(needsWorktree({ subagent_type: 'Explore' }, true, more)).toBe(false)
})

test('takes no-isolate types from noIsolateAgents and the old readOnlyAgents together', async () => {
  const both = noIsolateTypes('builder, tester', ['auditor'], undefined)
  for (const t of ['builder', 'tester', 'auditor', 'kit:builder', 'Explore']) {
    expect(needsWorktree({ subagent_type: t }, true, both)).toBe(false)
  }
  expect(needsWorktree({ subagent_type: 'general-purpose' }, true, both)).toBe(true)
  expect(noIsolateTypes(undefined, '')).toEqual(noIsolateTypes(''))
})

test('picks the ignored directories out of ls-files output', async () => {
  expect(ignoredDirs('svc-a/\r\nnode_modules/\n.env\nservices/b/\n../out/\n"we\\"ird/"\n')).toEqual(['svc-a', 'node_modules', 'services/b'])
  expect(ignoredDirs('')).toEqual([])
  expect(ignoredDirs('a/\nb/\nc/', 2)).toEqual(['a', 'b'])
})

test('keeps agents in the main checkout for nested repos only without a setup script', async () => {
  expect(skipForNested({ nested: ['svc-a'], hasSetup: false })).toBe(true)
  expect(skipForNested({ nested: ['svc-a'], hasSetup: true })).toBe(false)
  expect(skipForNested({ nested: [], hasSetup: false })).toBe(false)
  const text = nestedToast(['a', 'b', 'c', 'd', 'e'], '.claude/worktree-setup.sh')
  expect(text).toContain('a, b, c, +2 more')
  expect(text).toContain('.claude/worktree-setup.sh')
  expect(text).toContain('isolateNestedRepos')
})

test('rewrites only the Agent arguments, adding isolation', async () => {
  const input = withWorktree({ tool: 'Agent', tool_use_id: 'x', agentId: 'a', prompt: 'p', description: 'd', model: 'sonnet' })
  expect(input).toEqual({ prompt: 'p', description: 'd', model: 'sonnet', isolation: 'worktree' })
})

test('matches a worktree path in a command line, and not its longer sibling', async () => {
  const wt = 'C:\\sw\\app\\.claude\\worktrees\\agent-a1'
  expect(mentions('"C:\\Program Files\\nodejs\\node.exe" C:\\SW\\App\\.claude\\worktrees\\agent-a1\\node_modules\\.bin\\vite', wt, true)).toBe(true)
  expect(mentions('node c:/sw/app/.claude/worktrees/agent-a1', wt, true)).toBe(true)
  expect(mentions('node C:\\sw\\app\\.claude\\worktrees\\agent-a12\\server.js', wt, true)).toBe(false)
  expect(mentions('node C:\\sw\\app\\server.js', wt, true)).toBe(false)
  // Linux keeps case
  expect(mentions('node /home/abd/app/.claude/worktrees/x/server.js', '/home/abd/app/.claude/worktrees/x', false)).toBe(true)
  expect(mentions('node /home/abd/app/.claude/worktrees/X/server.js', '/home/abd/app/.claude/worktrees/x', false)).toBe(false)
  expect(mentions('node /mnt/home/abd/app/.claude/worktrees/x/a.js', '/home/abd/app/.claude/worktrees/x', false)).toBe(false)
  expect(worktreeRootOf('C:\\sw\\app\\.claude\\worktrees\\agent-a1\\src')).toBe('C:\\sw\\app\\.claude\\worktrees\\agent-a1')
  expect(worktreeRootOf('C:\\sw\\app\\src')).toBe(undefined)
  expect(worktreeMentions('node "C:\\sw\\app\\.claude\\worktrees\\gone\\x.js" --cwd c:/sw/app/.claude/worktrees/live', 'c:/sw/app/.claude/worktrees/', true)).toEqual([
    'c:/sw/app/.claude/worktrees/gone',
    'c:/sw/app/.claude/worktrees/live',
  ])
})

// claude (10) -> probe shell (11); a dev server tree in the worktree; a terminal in the worktree running another claude
const WT = '/r/.claude/worktrees/w1'
const SNAP: Snapshot = {
  self: 11,
  procs: [
    { pid: 1, ppid: 0, pgid: 1, cmd: '/sbin/init' },
    { pid: 10, ppid: 1, pgid: 10, cmd: `/usr/bin/claude --add-dir ${WT}` },
    { pid: 11, ppid: 10, pgid: 10, cmd: `sh -c echo ${WT}` },
    { pid: 20, ppid: 1, pgid: 20, cmd: `npm run dev --prefix ${WT}` },
    { pid: 21, ppid: 20, pgid: 20, cmd: 'node vite' },
    { pid: 30, ppid: 1, pgid: 30, cmd: `bash --login ${WT}` },
    { pid: 31, ppid: 30, pgid: 30, cmd: 'claude' },
    { pid: 40, ppid: 1, pgid: 40, cmd: 'python -m http.server 4012' },
    { pid: 50, ppid: 1, pgid: 50, cmd: 'node /r/server.js' },
  ],
  listeners: [
    { port: 4012, pid: 40 },
    { port: 3000, pid: 50 },
  ],
}

test('stops the worktree trees and the slot listeners, never Claude or a tree holding it', async () => {
  const v = selectVictims(SNAP, [WT], [4010, 4011, 4012], false)
  expect(v.roots).toEqual([20, 40])
  expect(v.tree).toEqual([20, 21, 40])
  expect(v.spared).toEqual([30])
  expect(safeGroups(SNAP, v.roots)).toEqual([20, 40])
  // a group shared with Claude is never signalled whole
  const shared: Snapshot = { ...SNAP, procs: SNAP.procs.map(p => (p.pid === 20 ? { ...p, pgid: 10 } : p)) }
  expect(safeGroups(shared, [20])).toEqual([])
  // no paths, no ports: nothing
  expect(selectVictims(SNAP, [], [], false).roots).toEqual([])
})

test('reads the process probes of both systems', async () => {
  const win = parseWindowsSnapshot(
    JSON.stringify({ self: 7, procs: [{ ProcessId: 7, ParentProcessId: 3, CommandLine: null }], listen: { LocalPort: 4010, OwningProcess: 9 } }),
  )
  expect(win).toEqual({ self: 7, procs: [{ pid: 7, ppid: 3, cmd: '' }], listeners: [{ port: 4010, pid: 9 }] })
  const linux = parseLinuxSnapshot(
    'SELF 11\n   10     1    10 /usr/bin/claude\n   11    10    10 sh -c x\n---\nLISTEN 0 511 0.0.0.0:4010 0.0.0.0:* users:(("node",pid=20,fd=3),("node",pid=21,fd=3))\nLISTEN 0 4096 [::]:22 [::]:*\n',
  )
  expect(linux.self).toBe(11)
  expect(linux.procs).toEqual([
    { pid: 10, ppid: 1, pgid: 10, cmd: '/usr/bin/claude' },
    { pid: 11, ppid: 10, pgid: 10, cmd: 'sh -c x' },
  ])
  expect(linux.listeners).toEqual([
    { port: 4010, pid: 20 },
    { port: 4010, pid: 21 },
  ])
})

test('allocates the lowest free slot from 1, keeps a held one, and frees on release', async () => {
  let table = parseSlots('not json')
  const a = claimSlot(table, 'C:/r/.claude/worktrees/a', 'a', 1, true)
  table = a.table
  const b = claimSlot(table, 'C:/r/.claude/worktrees/b', 'b', 2, true)
  table = b.table
  expect([a.slot, b.slot]).toEqual([1, 2])
  expect(claimSlot(table, 'c:\\r\\.claude\\worktrees\\A', 'a', 3, true).slot).toBe(1)
  table = releaseSlot(table, 'C:/r/.claude/worktrees/a', true)
  expect(claimSlot(table, 'C:/r/.claude/worktrees/c', 'c', 4, true).slot).toBe(1)
  expect(portRange(4000, 2)).toEqual([4020, 4029])
  expect(parseSlots(JSON.stringify(table))).toEqual(table)
})

test('reads git worktree list --porcelain', async () => {
  const list = parseWorktrees(
    'worktree C:/r\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/r/.claude/worktrees/x\nHEAD bbb\nbranch refs/heads/worktree-x\nlocked claude agent x\n\nworktree C:/r/.claude/worktrees/y\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n',
  )
  expect(list.map(w => [w.path, w.branch, w.locked, w.prunable])).toEqual([
    ['C:/r', 'main', undefined, false],
    ['C:/r/.claude/worktrees/x', 'worktree-x', 'claude agent x', false],
    ['C:/r/.claude/worktrees/y', undefined, undefined, true],
  ])
})

const MERGED: BranchFacts = {
  branch: 'feature',
  isProtected: false,
  pr: { numbers: [12] },
  gitMerged: false,
  unpushed: 0,
  worktree: { path: 'C:/r/.claude/worktrees/f', exists: true, dirty: false, isMain: false, isSession: false },
  remote: { safe: true },
}

test('deletes a branch only when its PR merged and nothing would be lost', async () => {
  expect(decideBranch(MERGED)).toEqual({
    kind: 'delete',
    branch: 'feature',
    via: 'PR #12',
    worktreePath: 'C:/r/.claude/worktrees/f',
    prune: false,
    allowForce: true,
    deleteRemote: true,
    remoteNote: undefined,
  })
  const reason = (f: Partial<BranchFacts>) => {
    const plan = decideBranch({ ...MERGED, ...f })
    return plan.kind === 'skip' ? plan.reason : 'delete'
  }
  expect(reason({ isProtected: true })).toBe('default or checked-out branch')
  expect(reason({ pr: { numbers: [] }, gitMerged: false })).toBe('no merged PR, and not in the default branch')
  // a tip already in origin/<default> counts as merged without a PR only on an agent's worktree-* branch
  expect(reason({ branch: 'worktree-agent-a1', pr: { numbers: [] }, gitMerged: true })).toBe('delete')
  // a branch made by hand (`git branch foo`) sits on the default branch too: it needs a merged PR
  expect(reason({ pr: { numbers: [] }, gitMerged: true })).toBe('no merged PR; only worktree-* branches count as merged by being in the default branch')
  expect(reason({ pr: undefined, gitMerged: true })).toBe('no merged PR (gh unavailable); only worktree-* branches count as merged by being in the default branch')
  expect(reason({ worktree: { ...MERGED.worktree!, isActive: true } })).toBe('its agent has not stopped yet')
  expect(reason({ worktree: { ...MERGED.worktree!, dirty: true } })).toBe('worktree has uncommitted changes')
  expect(reason({ worktree: { ...MERGED.worktree!, locked: 'claude agent x' } })).toBe('worktree is locked (claude agent x)')
  expect(reason({ worktree: { ...MERGED.worktree!, isMain: true } })).toBe('checked out in the main checkout')
  expect(reason({ worktree: { ...MERGED.worktree!, isSession: true } })).toBe('this session works in its worktree')
  expect(reason({ unpushed: 2 })).toBe('2 commits on no remote and in no merged PR')
  // without gh, git's own merged list decides for a worktree-* branch
  const noGh = decideBranch({ ...MERGED, branch: 'worktree-agent-a1', pr: undefined, gitMerged: true })
  expect(noGh.kind === 'delete' && noGh.via === 'in the default branch').toBe(true)
  expect(reason({ pr: undefined, gitMerged: false })).toBe('not in the default branch (gh unavailable)')
  // a remote branch with commits past the merge is left; a missing worktree folder is pruned
  const remoteAhead = decideBranch({ ...MERGED, remote: { safe: false }, worktree: { ...MERGED.worktree!, exists: false } })
  expect(remoteAhead.kind === 'delete' && !remoteAhead.deleteRemote && remoteAhead.prune && remoteAhead.worktreePath === undefined).toBe(true)
})

test('branches a new worktree from the session checkout HEAD, detached or not', async () => {
  const sha = '4bada1f0123456789abcdef0123456789abcdef0'
  expect(planCreate({ pathExists: false, branchExists: false, head: sha })).toEqual({ kind: 'add-new', base: sha })
  // a detached HEAD is a commit like any other
  expect(planCreate({ pathExists: false, branchExists: false, head: `${sha}\n` })).toEqual({ kind: 'add-new', base: sha })
  expect(planCreate({ pathExists: false, branchExists: true, head: sha })).toEqual({ kind: 'add-branch' })
  expect(planCreate({ pathExists: true, branchExists: true, head: sha })).toEqual({ kind: 'reuse' })
  // no HEAD yet (an empty repo): Claude Code's default
  expect(planCreate({ pathExists: false, branchExists: false })).toEqual({ kind: 'default' })
  expect(planCreate({ pathExists: false, branchExists: false, head: 'origin/main' })).toEqual({ kind: 'default' })
})

test('fast-forwards the local default branch only when strictly behind and clean', async () => {
  const base = { branch: 'main', local: 'aaa', remote: 'bbb', behind: true }
  expect(decideMainSync(base)).toEqual({ kind: 'update-ref', from: 'aaa', to: 'bbb' })
  expect(decideMainSync({ ...base, checkedOut: { path: 'C:/r', dirty: false } })).toEqual({ kind: 'merge-ff', worktree: 'C:/r', to: 'bbb' })
  expect(decideMainSync({ ...base, checkedOut: { path: 'C:/r', dirty: true } }).kind).toBe('none')
  expect(decideMainSync({ ...base, behind: false }).kind).toBe('none')
  expect(decideMainSync({ ...base, remote: 'aaa' })).toEqual({ kind: 'none' })
  expect(decideMainSync({ ...base, remote: undefined })).toEqual({ kind: 'none' })
})

test('copies only ignored .worktreeinclude files inside the checkout', async () => {
  expect(includedFiles(['.env', 'notes.txt', '../x', 'C:/y', 'cfg/local.json'], '.env\r\ncfg/local.json\n../x\nC:/y\n')).toEqual(['.env', 'cfg/local.json'])
})

test('records active worktrees and takes over only a stale lock', async () => {
  let state = parseState(undefined)
  state = markActive(state, 'C:/r/.claude/worktrees/a', 1000, true)
  expect(isActive(state, 'c:\\r\\.claude\\worktrees\\A', 2000, true)).toBe(true)
  expect(isActive(state, 'C:/r/.claude/worktrees/a', 1000 + ACTIVE_FOR_MS + 1, true)).toBe(false)
  expect(parseState(serializeState(state))).toEqual(state)
  // the old slots.json shape still reads
  expect(parseState('{"slots":{"1":{"path":"p","name":"n","at":1}}}').slots.slots['1']?.path).toBe('p')
  state = markDone(state, 'C:/R/.claude/worktrees/a', true)
  expect(isActive(state, 'C:/r/.claude/worktrees/a', 2000, true)).toBe(false)
  expect(lockStep(500)).toBe('wait')
  expect(lockStep(60_000)).toBe('break')
})

const TASKS: BackgroundTask[] = [
  { id: 'b1shell', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' },
  { id: 'm2watch', type: 'monitor', status: 'running', description: 'tail the deploy log' },
  { id: 'b3other', type: 'shell', status: 'running', description: 'another agent', command: 'ssh host' },
  { id: 'b4done', type: 'shell', status: 'completed', description: 'finished', command: 'npm test' },
  { id: 'a5agent', type: 'subagent', status: 'running', description: 'a helper agent' },
]

test('refuses an agent stop while a shell or monitor it started still runs', async () => {
  // its transcript names its own tasks; b3other belongs to someone else
  const decision = decideStop({ stopHookActive: false, tasks: TASKS, inTranscript: new Set(['b1shell', 'm2watch', 'b4done', 'a5agent']) })
  expect(decision.kind).toBe('block')
  expect(decision.owned.map(t => t.id)).toEqual(['b1shell', 'm2watch'])
  expect(decision.kind === 'block' && decision.reason).toBe(
    'You still have background work running:\nb1shell npm run dev\nm2watch tail the deploy log\n' +
      "Stop each with TaskStop, unless it is meant to outlive you; then say so in one line. Your report was already delivered; don't send it again.",
  )
})

test('lets an agent stop when it owns no running shell or monitor', async () => {
  // only someone else's task, a finished one and a subagent
  expect(decideStop({ stopHookActive: false, tasks: TASKS, inTranscript: new Set(['b4done', 'a5agent']) })).toEqual({ kind: 'allow', owned: [], commit: false })
  // no tasks at all
  expect(decideStop({ stopHookActive: false, tasks: undefined, inTranscript: new Set() }).kind).toBe('allow')
  // an unreadable transcript proves nothing: fail open
  expect(decideStop({ stopHookActive: false, tasks: TASKS, inTranscript: undefined })).toEqual({ kind: 'allow', owned: [], commit: false })
})

test('lets the stop after a refusal through, so it cannot loop', async () => {
  const decision = decideStop({ stopHookActive: true, tasks: TASKS, inTranscript: new Set(['b1shell']) })
  expect(decision.kind).toBe('allow')
  // still reported, for the debug log
  expect(decision.owned.map(t => t.id)).toEqual(['b1shell'])
})

// --- uncommitted work in an agent's worktree ---

const DIRTY = { path: 'C:/r/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1', files: 3 }
const SENT = "Your report was already delivered; don't send it again."

test('counts the files git status lists', async () => {
  expect(countChanges(' M a.ts\n?? b.ts\nA  c.ts\n')).toBe(3)
  expect(countChanges('')).toBe(0)
})

test('sends an agent back to commit what it left uncommitted', async () => {
  const decision = decideStop({ stopHookActive: false, tasks: [], inTranscript: new Set(), dirty: DIRTY })
  expect(decision).toEqual({
    kind: 'block',
    owned: [],
    reason:
      'Your worktree `C:/r/.claude/worktrees/agent-a1` has uncommitted changes (3 files). ' +
      `Commit them on \`worktree-agent-a1\` with a message that says what they are, then finish. ${SENT}`,
  })
})

test('gives one reason for running background work and uncommitted changes', async () => {
  const decision = decideStop({ stopHookActive: false, tasks: TASKS, inTranscript: new Set(['b1shell']), dirty: { ...DIRTY, files: 1 } })
  expect(decision.kind === 'block' && decision.reason).toBe(
    'You still have background work running:\nb1shell npm run dev\n' +
      'Stop each with TaskStop, unless it is meant to outlive you; then say so in one line.\n' +
      'Your worktree `C:/r/.claude/worktrees/agent-a1` has uncommitted changes (1 file). ' +
      `Commit them on \`worktree-agent-a1\` with a message that says what they are, then finish. ${SENT}`,
  )
})

test('lets a clean agent stop, and commits for one that stops dirty a second time', async () => {
  expect(decideStop({ stopHookActive: false, tasks: [], inTranscript: new Set() })).toEqual({ kind: 'allow', owned: [], commit: false })
  expect(decideStop({ stopHookActive: false, tasks: [], inTranscript: new Set(), dirty: { ...DIRTY, files: 0 } }).kind).toBe('allow')
  expect(decideStop({ stopHookActive: true, tasks: TASKS, inTranscript: new Set(['b1shell']), dirty: DIRTY })).toEqual({
    kind: 'allow',
    owned: [TASKS[0]!],
    commit: true,
  })
})

test('tells the agent and the main thread how work moves between worktrees', async () => {
  expect(startContext('worktree-agent-a1')).toBe(
    'You are working in a git worktree on branch `worktree-agent-a1`. Commit your changes on that branch before you finish, ' +
      "with a message that says what they are; uncommitted work doesn't reach the main session. Don't push.",
  )
  expect(SESSION_CONTEXT).toContain('git merge --ff-only worktree-<name>')
  expect(SESSION_CONTEXT).toContain('`/tidy` is for those')
  expect(WIP_MESSAGE('general-purpose', 'a1')).toBe('WIP: uncommitted changes left by general-purpose a1')
})

// --- agent branches merged without a PR of their own ---

const AGENT: BranchFacts = {
  branch: 'worktree-agent-a1',
  isProtected: false,
  pr: { numbers: [] },
  gitMerged: false,
  unpushed: 2,
  ahead: 2,
  worktree: { path: 'C:/r/.claude/worktrees/agent-a1', exists: true, dirty: false, isMain: false, isSession: false },
}

test('finds the merged PR whose head holds a tip, only among heads present locally', async () => {
  const heads = [
    { number: 11, head: 'other' },
    { number: 12, head: 'squashed-feature' },
  ]
  // squash case: the agent tip is an ancestor of PR 12's head
  expect(findMergedPr('tip', heads, new Set(['other', 'squashed-feature']), new Set(['squashed-feature']))).toBe(12)
  expect(findMergedPr('squashed-feature', heads, new Set(['squashed-feature']), new Set())).toBe(12)
  // an unrelated commit
  expect(findMergedPr('tip', heads, new Set(['other', 'squashed-feature']), new Set())).toBe(undefined)
  // a head missing locally proves nothing
  expect(findMergedPr('squashed-feature', heads, new Set(['other']), new Set(['squashed-feature']))).toBe(undefined)
})

test('counts an agent branch merged when merging it would change nothing', async () => {
  const plan = decideBranch({ ...AGENT, contentMerged: true })
  expect(plan.kind === 'delete' && plan.via).toBe('content in the default branch')
  expect(unmergedAgentWork([{ ...AGENT, contentMerged: true }])).toEqual([])
  // the same check never applies to a branch of your own
  expect(decideBranch({ ...AGENT, branch: 'feature', contentMerged: true }).kind).toBe('skip')
})

test('reports an agent branch whose content main has changed since as unmerged, PR head or not', async () => {
  const facts = { ...AGENT, contentMerged: false, inMergedPr: 12 }
  expect(decideBranch(facts)).toEqual({ kind: 'skip', branch: 'worktree-agent-a1', reason: 'not merged: merging it into the default branch would change files' })
  expect(unmergedAgentWork([facts])).toEqual(['unmerged agent work: worktree-agent-a1 (2 commits)'])
})

test('falls through to the merged-PR head when the content check cannot run', async () => {
  const plan = decideBranch({ ...AGENT, unpushed: 0, inMergedPr: 12 })
  expect(plan.kind === 'delete' && plan.via).toBe('in merged PR #12')
  expect(decideBranch({ ...AGENT, unpushed: 0, inMergedPr: 12, worktree: { ...AGENT.worktree!, dirty: true } })).toEqual({
    kind: 'skip',
    branch: 'worktree-agent-a1',
    reason: 'worktree has uncommitted changes (in merged PR #12)',
  })
  expect(unmergedAgentWork([{ ...AGENT, inMergedPr: 12 }])).toEqual([])
  // no PR head holds it either: unmerged, and never deleted
  expect(decideBranch(AGENT).kind).toBe('skip')
  expect(unmergedAgentWork([AGENT, { ...AGENT, branch: 'feature' }, { ...AGENT, branch: 'worktree-b', ahead: 1, worktree: { ...AGENT.worktree!, isActive: true } }])).toEqual([
    'unmerged agent work: worktree-agent-a1 (2 commits)',
  ])
})

// --- self-cleanup after a merge ---

const OWN: SelfCleanFacts = {
  path: 'C:/r/.claude/worktrees/agent-a1',
  registered: true,
  branch: 'worktree-agent-a1',
  isSession: false,
  active: false,
  dirty: false,
  merged: true,
}

test("removes this session's agent worktree once it is done, clean and merged into HEAD", async () => {
  expect(decideSelfClean(OWN)).toEqual({ kind: 'remove', path: OWN.path, branch: 'worktree-agent-a1' })
})

test('skips a worktree for each condition it fails, forgetting only those that can never qualify', async () => {
  const skip = (f: Partial<SelfCleanFacts>) => {
    const plan = decideSelfClean({ ...OWN, ...f })
    return plan.kind === 'skip' ? [plan.reason, plan.forget] : plan.kind
  }
  expect(skip({ isSession: true })).toEqual(['the session works in it', true])
  expect(skip({ registered: false })).toEqual(['no longer a registered worktree', true])
  expect(skip({ branch: 'feature' })).toEqual(['not on a worktree-* branch (feature)', false])
  expect(skip({ branch: undefined })).toEqual(['not on a worktree-* branch (detached)', false])
  expect(skip({ locked: 'in use' })).toEqual(['locked (in use)', false])
  expect(skip({ active: true })).toEqual(['its agent has not stopped yet', false])
  expect(skip({ dirty: true })).toEqual(['uncommitted changes', false])
  expect(skip({ merged: false })).toEqual(["worktree-agent-a1 is not merged into the session's HEAD", false])
})
