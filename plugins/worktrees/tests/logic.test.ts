import { expect, test } from 'claude-code/testing'

import type { BranchFacts, Snapshot } from '../hooks/register'
import {
  claimSlot,
  decideBranch,
  mentions,
  needsWorktree,
  parseLinuxSnapshot,
  parseSlots,
  parseWindowsSnapshot,
  parseWorktrees,
  portRange,
  readOnlyTypes,
  releaseSlot,
  safeGroups,
  selectVictims,
  withWorktree,
  worktreeMentions,
  worktreeRootOf,
} from '../hooks/register'

const RO = readOnlyTypes('')

test('gives an editing agent a worktree, and a reading one none', async () => {
  expect(needsWorktree({ subagent_type: 'general-purpose' }, true, RO)).toBe(true)
  expect(needsWorktree({}, true, RO)).toBe(true)
  expect(needsWorktree({ subagent_type: 'fork' }, true, RO)).toBe(true)
  for (const t of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'scout', 'reviewer', 'explore']) {
    expect(needsWorktree({ subagent_type: t }, true, RO)).toBe(false)
  }
  // a choice already made stands, remote included; outside a repo nothing changes
  expect(needsWorktree({ isolation: 'remote' }, true, RO)).toBe(false)
  expect(needsWorktree({ isolation: 'worktree' }, true, RO)).toBe(false)
  expect(needsWorktree({ subagent_type: 'general-purpose' }, false, RO)).toBe(false)
  // the configured list adds to the defaults
  const more = readOnlyTypes('auditor, Linter ,')
  expect(needsWorktree({ subagent_type: 'linter' }, true, more)).toBe(false)
  expect(needsWorktree({ subagent_type: 'Explore' }, true, more)).toBe(false)
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
  expect(reason({ pr: { numbers: [] }, gitMerged: true })).toBe('no merged PR')
  expect(reason({ worktree: { ...MERGED.worktree!, dirty: true } })).toBe('worktree has uncommitted changes')
  expect(reason({ worktree: { ...MERGED.worktree!, locked: 'claude agent x' } })).toBe('worktree is locked (claude agent x)')
  expect(reason({ worktree: { ...MERGED.worktree!, isMain: true } })).toBe('checked out in the main checkout')
  expect(reason({ worktree: { ...MERGED.worktree!, isSession: true } })).toBe('this session works in its worktree')
  expect(reason({ unpushed: 2 })).toBe('2 commits on no remote and in no merged PR')
  // without gh, git's own merged list decides, and -D is never allowed
  const noGh = decideBranch({ ...MERGED, pr: undefined, gitMerged: true })
  expect(noGh.kind === 'delete' && !noGh.allowForce && noGh.via === 'git branch --merged').toBe(true)
  expect(reason({ pr: undefined, gitMerged: false })).toBe('not merged into the default branch (gh unavailable)')
  // a remote branch with commits past the merge is left; a missing worktree folder is pruned
  const remoteAhead = decideBranch({ ...MERGED, remote: { safe: false }, worktree: { ...MERGED.worktree!, exists: false } })
  expect(remoteAhead.kind === 'delete' && !remoteAhead.deleteRemote && remoteAhead.prune && remoteAhead.worktreePath === undefined).toBe(true)
})
