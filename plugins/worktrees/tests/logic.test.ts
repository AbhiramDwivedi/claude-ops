import { expect, test } from 'claude-code/testing'

import type { BackgroundTask, BranchFacts, SelfCleanFacts, State } from '../hooks/register'
import {
  CHERRY_ALL_MINUS,
  CHERRY_ONE_PLUS,
  DIRTY as DIRTY_AGENT,
  HOUR,
  LEAD,
  MAIN,
  MEMBER,
  META_DIR,
  META_FINISHED,
  META_NOT_JSON,
  META_RESHAPED,
  META_RUNNING,
  NOW,
  ODD_TRANSCRIPT,
  SLOTS_JSON,
  STALE,
  SUBAGENT_TRANSCRIPT,
  TRANSCRIPT,
} from './fixtures/run3'
import {
  ACTIVE_FOR_MS,
  claimSlot,
  decideBranch,
  decideMainSync,
  decideSelfClean,
  countChanges,
  decideStop,
  declaredReadOnly,
  findMergedPr,
  SESSION_CONTEXT,
  startContext,
  unmergedAgentWork,
  addedLines,
  parseCatFileBatch,
  reflogWorked,
  DAY_MS,
  describePlan,
  isSuperseded,
  linksIntoMain,
  parseNameStatus,
  tidySettings,
  untrackedFiles,
  WIP_MESSAGE,
  includedFiles,
  isActive,
  lockStep,
  markActive,
  markDone,
  parseState,
  parsePidFile,
  recordSpawned,
  takeSpawned,
  planCreate,
  serializeState,
  needsWorktree,
  parseSlots,
  parseWorktrees,
  REFUSED_READ_ONLY_TYPES,
  portRange,
  childDirs,
  ignoredDirs,
  nestedToast,
  noIsolateTypes,
  skipForNested,
  releaseSlot,
  withWorktree,
  worktreeRootOf,
  agentWorktreeId,
  sessionDirOf,
  workflowMetaWorktree,
  workflowRunFinished,
  workflowWorktreeRun,
  cherryMerged,
  mainCheckoutOf,
  metaFinished,
  metaPathFor,
  sweepActive,
} from '../hooks/register'

const RO = noIsolateTypes('')

const kitManifest = (agents: unknown, version: unknown = 1) =>
  JSON.stringify({ version, kit: '0.2.0', checks: [], agents, riskyPaths: [], setupScripts: [] })

test("reads the read-only types kit's manifest declares, case-folded and in full", async () => {
  const r = declaredReadOnly(
    kitManifest([
      { name: 'Foundry:Judge', readOnly: true, declaredBy: 'foundry' },
      { name: 'kit:builder', readOnly: false, declaredBy: 'kit' },
      { name: 'helper', readOnly: true, declaredBy: 'project' },
    ]),
  )
  expect(r.error).toBeUndefined()
  expect([...r.types].sort()).toEqual(['foundry:judge', 'helper'])
})

test('a bad manifest entry adds nothing and the rest still count', async () => {
  const r = declaredReadOnly(
    kitManifest([
      { name: 'bad name!', readOnly: true },
      { name: 7, readOnly: true },
      { name: 'a:b:c', readOnly: true },
      { name: 'x'.repeat(65), readOnly: true },
      { name: 'x:y', readOnly: 'yes' },
      { readOnly: true },
      null,
      'foundry:cynic',
      { name: 'foundry:judge', readOnly: true },
    ]),
  )
  expect(r.error).toBeUndefined()
  expect([...r.types]).toEqual(['foundry:judge'])
})

test('a manifest that is not JSON, not an object, not version 1 or has no agents array declares nothing', async () => {
  const one = [{ name: 'a', readOnly: true }]
  const bad = ['{not json', '', '[]', 'null', '"x"', '3', kitManifest(one, 2), kitManifest(one, '1'), JSON.stringify({ version: 1 }), kitManifest({ name: 'a', readOnly: true })]
  for (const text of bad) {
    const r = declaredReadOnly(text)
    expect(r.types.size).toBe(0)
    expect(typeof r.error).toBe('string')
  }
  // an empty agents array is a good file that declares nothing
  const empty = declaredReadOnly(kitManifest([]))
  expect(empty.error).toBeUndefined()
  expect(empty.types.size).toBe(0)
})

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

test('checks only real subdirectories one level down, at most cap of them', async () => {
  const entries = [
    { name: 'a', kind: 'dir' },
    { name: 'notes.md', kind: 'file' },
    { name: 'link', kind: 'other', isLink: true },
    { name: '.git', kind: 'dir' },
    { name: 'b', kind: 'dir' },
  ]
  expect(childDirs('services', entries)).toEqual(['services/a', 'services/b'])
  expect(childDirs('services', entries, 1)).toEqual(['services/a'])
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

test('finds the worktree root a path lies in', async () => {
  expect(worktreeRootOf('C:\\sw\\app\\.claude\\worktrees\\agent-a1\\src')).toBe('C:\\sw\\app\\.claude\\worktrees\\agent-a1')
  expect(worktreeRootOf('C:\\sw\\app\\src')).toBe(undefined)
})

test('reads the pids a setup script declared, one a line, and nothing else', async () => {
  expect(parsePidFile('123\r\n 456 \n\nnot-a-pid\n12x\n123\n0\n4\n-7\n99999999999\n')).toEqual([123, 456])
  expect(parsePidFile(undefined)).toEqual([])
  expect(parsePidFile('')).toEqual([])
})

test('records spawned pids per worktree, round-trips them, and hands them back once', async () => {
  const wt = 'C:\\r\\.claude\\worktrees\\w1'
  let state = recordSpawned(parseState(undefined), wt, [100, 101], 5, true)
  state = recordSpawned(state, 'c:/r/.claude/worktrees/w1', [101, 102], 6, true)
  expect(state.spawned['c:/r/.claude/worktrees/w1']?.pids).toEqual([100, 101, 102])
  expect(recordSpawned(state, '/elsewhere', [], 7, false)).toBe(state)
  expect(parseState(serializeState(state))).toEqual(state)
  const taken = takeSpawned(state, wt, true)
  expect(taken.pids).toEqual([100, 101, 102])
  expect(taken.state.spawned).toEqual({})
  expect(takeSpawned(taken.state, wt, true).pids).toEqual([])
  // a state with no records writes no spawned key, and bad records are dropped on read
  expect(serializeState(parseState(undefined)).includes('spawned')).toBe(false)
  expect(parseState('{"spawned":{"a":{"path":"a","pids":[1,"x",300]},"b":{"pids":[5]}}}').spawned).toEqual({ a: { path: 'a', pids: [300], at: 0 } })
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
  // a branch made by hand (`git branch foo`) sits on the default branch too: without work made on it, it needs a merged PR
  expect(reason({ pr: { numbers: [] }, gitMerged: true })).toBe('no merged PR; in the default branch, but no commits were made on it here; looks like a bookmark')
  expect(reason({ pr: undefined, gitMerged: true, worked: false })).toBe('no merged PR (gh unavailable); in the default branch, but no commits were made on it here; looks like a bookmark')
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

test('counts a branch of your own in the default branch merged once its reflog shows work made on it', async () => {
  const plan = decideBranch({ ...MERGED, pr: { numbers: [] }, gitMerged: true, worked: true, tip: 'abc' })
  expect(plan).toEqual({
    kind: 'delete',
    branch: 'feature',
    via: 'in the default branch, worked on here',
    worktreePath: 'C:/r/.claude/worktrees/f',
    prune: false,
    allowForce: true,
    deleteRemote: true,
    remoteNote: undefined,
    archive: 'refs/tidy-archive/feature',
  })
  // a bookmark: no reflog entry but its creation (or a reset or rename)
  expect(decideBranch({ ...MERGED, pr: { numbers: [] }, gitMerged: true, worked: false })).toEqual({
    kind: 'skip',
    branch: 'feature',
    reason: 'no merged PR; in the default branch, but no commits were made on it here; looks like a bookmark',
  })
  // a merged PR needs no archive, and the same gates hold
  expect(decideBranch(MERGED).kind === 'delete' && 'archive' in decideBranch(MERGED)).toBe(false)
  const dirty = decideBranch({ ...MERGED, pr: { numbers: [] }, gitMerged: true, worked: true, worktree: { ...MERGED.worktree!, dirty: true } })
  expect(dirty.kind === 'skip' && dirty.reason).toBe('worktree has uncommitted changes (in the default branch, worked on here)')
  expect(reflogWorked('branch: Created from HEAD\n')).toBe(false)
  expect(reflogWorked('reset: moving to HEAD~1\nbranch: renamed refs/heads/a to refs/heads/b\nbranch: Created from main')).toBe(false)
  expect(reflogWorked("merge worktree-wf_1-2: Merge made by the 'ort' strategy.\nbranch: Created from HEAD")).toBe(true)
  for (const s of ['commit: x', 'commit (amend): x', 'cherry-pick: x', 'rebase (finish): refs/heads/a onto b', 'am: x', 'pull: Fast-forward'])
    expect(reflogWorked(s)).toBe(true)
  expect(reflogWorked('committed: no')).toBe(false)
})

test('counts an agent branch merged when every line it adds is in the default branch, and says how many are not', async () => {
  const covered = decideBranch({ ...AGENT, contentMerged: false, linesCovered: { missing: 0, total: 41 } })
  expect(covered.kind === 'delete' && [covered.via, covered.archive]).toEqual(['content in the default branch (later edited there)', 'refs/tidy-archive/worktree-agent-a1'])
  expect(unmergedAgentWork([{ ...AGENT, contentMerged: false, linesCovered: { missing: 0, total: 41 } }])).toEqual([])
  const facts = { ...AGENT, contentMerged: false, linesCovered: { missing: 73, total: 143 } }
  expect(decideBranch(facts)).toEqual({ kind: 'skip', branch: 'worktree-agent-a1', reason: 'not merged: 73 of 143 lines it adds are not in the default branch' })
  expect(unmergedAgentWork([facts])).toEqual(['unmerged agent work: worktree-agent-a1 (2 commits; 73 of 143 lines it adds are not in the default branch)'])
  // the fallback never applies to a branch of your own
  expect(decideBranch({ ...AGENT, branch: 'feature', contentMerged: false, linesCovered: { missing: 0, total: 41 } }).kind).toBe('skip')
})

test('reads the added lines of a -U0 patch per file and a cat-file --batch stream', async () => {
  const patch = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,0 +2,3 @@',
    '+  const longEnough = 1',
    '+short',
    '+++ not a header once in a hunk',
    'diff --git a/new file.md b/new file.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new file.md',
    '@@ -0,0 +1 @@',
    '+# a new heading here',
    '\\ No newline at end of file',
  ].join('\n')
  expect(addedLines(patch)).toEqual([['const longEnough = 1', '++ not a header once in a hunk'], ['# a new heading here']])
  const one = 'héllo\nworld'
  const size = new TextEncoder().encode(one).length
  expect(parseCatFileBatch(`${'a'.repeat(40)} blob ${size}\n${one}\nmain:gone.md missing\n`, 2)).toEqual([one, undefined])
  expect(parseCatFileBatch(`${'a'.repeat(40)} blob 99\nshort\n`, 1)).toBe(undefined)
})

test('counts a relay leg merged when another local branch strictly contains its tip', async () => {
  const leg = decideBranch({ ...AGENT, containedIn: 'worktree-wf_r-78', remote: { safe: false } })
  expect(leg.kind === 'delete' && [leg.via, leg.archive, leg.deleteRemote]).toEqual(['contained in worktree-wf_r-78', 'refs/tidy-archive/worktree-agent-a1', false])
  expect(unmergedAgentWork([{ ...AGENT, containedIn: 'worktree-wf_r-78' }])).toEqual([])
  // the same gates: locked, running or dirty legs stay
  expect(decideBranch({ ...AGENT, containedIn: 'x', worktree: { ...AGENT.worktree!, locked: 'l' } })).toEqual({
    kind: 'skip',
    branch: 'worktree-agent-a1',
    reason: 'worktree is locked (l) (contained in x)',
  })
  expect(decideBranch({ ...AGENT, containedIn: 'x', worktree: { ...AGENT.worktree!, isActive: true } }).kind).toBe('skip')
  // a branch of your own is never deleted for being contained
  expect(decideBranch({ ...AGENT, branch: 'feature', containedIn: 'x' }).kind).toBe('skip')
  // equal tips are not containment: gatherFacts leaves containedIn unset, and two such branches both stay
  expect(decideBranch({ ...AGENT }).kind).toBe('skip')
})

// --- archived and superseded agent branches (0.9.0) ---

test('deletes an agent branch whose tip an archive ref holds, past the unpushed gate, and keeps the other gates', async () => {
  const facts = { ...AGENT, contentMerged: false, archivedAt: 'refs/truss/archive/run-1/crew-a' }
  const plan = decideBranch(facts)
  expect(plan.kind === 'delete' && [plan.via, plan.style, plan.archive]).toEqual(['tip archived at refs/truss/archive/run-1/crew-a', 'archived', undefined])
  expect(describePlan(plan)).toBe('worktree-agent-a1: tip archived at refs/truss/archive/run-1/crew-a; remove worktree C:/r/.claude/worktrees/agent-a1')
  expect(unmergedAgentWork([facts])).toEqual([])
  expect(decideBranch({ ...facts, worktree: { ...AGENT.worktree!, dirty: true } }).kind).toBe('skip')
  expect(decideBranch({ ...facts, worktree: { ...AGENT.worktree!, locked: 'l' } }).kind).toBe('skip')
  expect(decideBranch({ ...facts, worktree: { ...AGENT.worktree!, isActive: true } }).kind).toBe('skip')
  expect(decideBranch({ ...facts, isProtected: true }).kind).toBe('skip')
  // a branch of your own is never deleted for an archive ref
  expect(decideBranch({ ...facts, branch: 'feature' }).kind).toBe('skip')
})

test('archives then deletes a superseded agent branch, naming its line count and last commit', async () => {
  const facts = { ...AGENT, contentMerged: false, linesCovered: { missing: 73, total: 143 }, superseded: { lastCommit: '2026-11-01', ref: 'refs/archive/tidy/2026-11-08/worktree-agent-a1', lines: { missing: 73, total: 143 } } }
  const plan = decideBranch(facts)
  expect(plan.kind === 'delete' && [plan.via, plan.style, plan.archive]).toEqual([
    'superseded (73/143 lines, last commit 2026-11-01)',
    'superseded',
    'refs/archive/tidy/2026-11-08/worktree-agent-a1',
  ])
  expect(unmergedAgentWork([facts])).toEqual([])
  // without a line count
  const bare = decideBranch({ ...facts, linesCovered: undefined, superseded: { ...facts.superseded, lines: undefined } })
  expect(bare.kind === 'delete' && bare.via).toBe('superseded (lines not counted, last commit 2026-11-01)')
  // only when merging it would change files; the worktree gates hold
  expect(decideBranch({ ...facts, contentMerged: undefined, linesCovered: undefined }).kind).toBe('skip')
  expect(decideBranch({ ...facts, worktree: { ...AGENT.worktree!, dirty: true } }).kind).toBe('skip')
})

test('calls a branch superseded only when old, every file it touches changed on main since, and no added file is gone', async () => {
  const now = NOW
  const old = now - 4 * DAY_MS
  const touched = [
    { status: 'M', path: 'ui/app.tsx' },
    { status: 'A', path: 'ui/new.tsx' },
  ]
  const base = { lastCommitMs: old, nowMs: now, days: 3, touched, changedOnDefault: new Set(['ui/app.tsx', 'ui/new.tsx']), presentOnDefault: new Set(['ui/new.tsx']) }
  expect(isSuperseded(base)).toBe(true)
  expect(isSuperseded({ ...base, lastCommitMs: now - 2 * DAY_MS })).toBe(false)
  expect(isSuperseded({ ...base, changedOnDefault: new Set(['ui/app.tsx']) })).toBe(false)
  expect(isSuperseded({ ...base, presentOnDefault: new Set() })).toBe(false)
  expect(isSuperseded({ ...base, touched: [] })).toBe(false)
  expect(parseNameStatus('M\0ui/app.tsx\0A\0ui/new file.tsx\0')).toEqual([
    { status: 'M', path: 'ui/app.tsx' },
    { status: 'A', path: 'ui/new file.tsx' },
  ])
  expect(parseNameStatus('M\0')).toBe(undefined)
})

test('reads the tidy settings, superseded on by default after 3 days', async () => {
  expect(tidySettings({})).toEqual({ archiveRefs: ['refs/truss/archive/', 'refs/archive/'], superseded: true, supersededDays: 3 })
  expect(tidySettings({ tidySuperseded: false, tidySupersededDays: 7, tidyArchiveRefs: 'refs/keep, bad..ref,notref' })).toEqual({
    archiveRefs: ['refs/keep/'],
    superseded: false,
    supersededDays: 7,
  })
  expect(tidySettings({ tidySuperseded: 'false', tidySupersededDays: -1 }).superseded).toBe(false)
  expect(tidySettings({ tidySupersededDays: -1 }).supersededDays).toBe(3)
})

test('counts an untracked symlink into the main checkout, not into the worktree, as no dirt', async () => {
  expect(untrackedFiles(['?? ui/node_modules', '?? build/', ' M src/a.ts', '?? "odd name"'])).toEqual(['ui/node_modules'])
  const wt = '/r/.claude/worktrees/agent-a1'
  expect(linksIntoMain('/r/ui/node_modules', '/r', wt, false)).toBe(true)
  expect(linksIntoMain(`${wt}/ui/real`, '/r', wt, false)).toBe(false)
  expect(linksIntoMain('/elsewhere/node_modules', '/r', wt, false)).toBe(false)
  expect(linksIntoMain('/rr/x', '/r', wt, false)).toBe(false)
  expect(linksIntoMain('C:\\R\\ui\\node_modules', 'c:/r', 'c:/r/.claude/worktrees/agent-a1', true)).toBe(true)
  const plan = decideBranch({ ...AGENT, contentMerged: true, worktree: { ...AGENT.worktree!, strayLinks: ['ui/node_modules'] } })
  expect(plan.kind === 'delete' && plan.unlink).toEqual(['ui/node_modules'])
})

test('names the count and first path of a dirty worktree', async () => {
  const plan = decideBranch({ ...MERGED, worktree: { ...MERGED.worktree!, dirty: true, changes: { count: 1, first: '?? .plan-scratch/' } } })
  expect(plan).toEqual({ kind: 'skip', branch: 'feature', reason: 'worktree has uncommitted changes (1: ?? .plan-scratch/)' })
})

// --- self-cleanup after a merge ---

const OWN: SelfCleanFacts = {
  path: 'C:/r/.claude/worktrees/agent-a1',
  registered: true,
  branch: 'worktree-agent-a1',
  isSession: false,
  active: false,
  dirty: false,
  inMain: 'ancestor',
  membersRunning: false,
  mainBranch: 'main',
}

test("removes this session's agent worktree once it is done, clean and merged into HEAD", async () => {
  expect(decideSelfClean(OWN)).toEqual({ kind: 'remove', path: OWN.path, branch: 'worktree-agent-a1', deleteFlag: '-d' })
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
  expect(skip({ inMain: undefined })).toEqual(["worktree-agent-a1 is not in the main checkout's HEAD yet", false])
})

const SEVEN = ['general-purpose', 'kit:builder', 'kit:test-writer', 'foundry:architect', 'foundry:devops', 'foundry:lead', 'foundry:writer', 'truss:foreman', 'truss:design-engineer', 'truss:commissioning-engineer', 'truss:planning-engineer', 'truss:writer']
const ro = (...names: string[]) => names.map((name) => ({ name, readOnly: true, declaredBy: 'kit' }))

test('REFUSED_READ_ONLY_TYPES is the ADR list, in order, lower-case', async () => {
  expect([...REFUSED_READ_ONLY_TYPES]).toEqual(SEVEN)
})

test('truss:foreman declared read-only is refused', async () => {
  const r = declaredReadOnly(kitManifest(ro('truss:foreman')))
  expect(r.types.has('truss:foreman')).toBe(false)
  expect(r.refused).toEqual(['truss:foreman'])
})

test('refused is [] when nothing is refused, and when the manifest is broken', async () => {
  const none = declaredReadOnly(kitManifest(ro('foundry:judge')))
  expect(none.error).toBeUndefined()
  expect(none.refused).toEqual([])
  const broken = declaredReadOnly('{not json')
  expect(typeof broken.error).toBe('string')
  expect(broken.refused).toEqual([])
  // fails the schema: error is set, so refused stays empty even though a refused name is present
  const schema = declaredReadOnly(kitManifest(ro('general-purpose'), 2))
  expect(typeof schema.error).toBe('string')
  expect(schema.refused).toEqual([])
  expect(schema.types.size).toBe(0)
})

test('each refused name at readOnly: true is left out of types and listed in refused, in file order', async () => {
  for (const name of SEVEN) {
    const r = declaredReadOnly(kitManifest(ro(name)))
    expect(r.types.has(name)).toBe(false)
    expect(r.refused).toEqual([name])
  }
  const all = declaredReadOnly(kitManifest(ro(...[...SEVEN].reverse())))
  expect(all.types.size).toBe(0)
  expect(all.refused).toEqual([...SEVEN].reverse())
})

test('refusal folds case, and refused keeps the spelling written in the file', async () => {
  const r = declaredReadOnly(kitManifest(ro('General-Purpose', 'Foundry:Lead', 'KIT:BUILDER')))
  expect(r.types.size).toBe(0)
  expect(r.refused).toEqual(['General-Purpose', 'Foundry:Lead', 'KIT:BUILDER'])
})

test('lookalike names stay read-only and are not refused', async () => {
  const names = ['plugin:general-purpose', 'lead', 'builder', 'foundry:judge', 'kit:reviewer']
  const r = declaredReadOnly(kitManifest(ro(...names)))
  expect([...r.types].sort()).toEqual([...names].sort())
  expect(r.refused).toEqual([])
})

test('a refused name at readOnly: false is in neither list', async () => {
  const r = declaredReadOnly(
    kitManifest([
      { name: 'kit:builder', readOnly: false, declaredBy: 'kit' },
      { name: 'Foundry:Lead', readOnly: false, declaredBy: 'kit' },
    ]),
  )
  expect(r.types.size).toBe(0)
  expect(r.refused).toEqual([])
})

test('a mixed manifest keeps foundry:judge read-only beside the refused entries', async () => {
  const r = declaredReadOnly(kitManifest(ro('kit:builder', 'foundry:judge', 'Foundry:Lead', 'helper', 'general-purpose')))
  expect([...r.types].sort()).toEqual(['foundry:judge', 'helper'])
  expect(r.refused).toEqual(['kit:builder', 'Foundry:Lead', 'general-purpose'])
})

test('a manifest declaring general-purpose still gives unset, empty and cased general-purpose calls a worktree', async () => {
  const { types } = declaredReadOnly(kitManifest(ro('general-purpose', 'foundry:judge')))
  const set = new Set([...RO, ...types])
  expect(needsWorktree({}, true, set)).toBe(true)
  expect(needsWorktree({ subagent_type: '' }, true, set)).toBe(true)
  expect(needsWorktree({ subagent_type: 'general-purpose' }, true, set)).toBe(true)
  expect(needsWorktree({ subagent_type: 'General-Purpose' }, true, set)).toBe(true)
  expect(needsWorktree({ subagent_type: 'foundry:judge' }, true, set)).toBe(false)
})

// --- worktrees-cleanup: pure helpers ---

test('decideSelfClean: deleteFlag is -D only for a tree or cherry merge', async () => {
  const flag = (inMain?: 'ancestor' | 'tree' | 'cherry') => {
    const plan = decideSelfClean({ ...OWN, inMain })
    return plan.kind === 'remove' ? plan.deleteFlag : plan.kind
  }
  expect(flag('ancestor')).toBe('-d')
  // ADR-0015 amendment 2026-10-28 (d): not in main's HEAD is a skip, never a delete
  expect(flag(undefined)).toBe('skip')
  expect(flag('tree')).toBe('-D')
  expect(flag('cherry')).toBe('-D')
  expect(decideSelfClean({ ...OWN, inMain: 'tree' })).toEqual({ kind: 'remove', path: OWN.path, branch: 'worktree-agent-a1', deleteFlag: '-D' })
})

test('decideSelfClean: check order is session, registered, branch, active, locked, dirty, merged', async () => {
  const reason = (f: Partial<SelfCleanFacts>) => {
    const plan = decideSelfClean({ ...OWN, ...f })
    return plan.kind === 'skip' ? plan.reason : plan.kind
  }
  // active now beats locked and dirty, so a locked or dirty skip means the agent is not live
  expect(reason({ active: true, locked: 'in use' })).toBe('its agent has not stopped yet')
  expect(reason({ active: true, dirty: true })).toBe('its agent has not stopped yet')
  expect(reason({ active: true, locked: 'in use', dirty: true, inMain: undefined })).toBe('its agent has not stopped yet')
  expect(reason({ locked: 'in use', dirty: true, inMain: undefined })).toBe('locked (in use)')
  expect(reason({ dirty: true, inMain: undefined })).toBe('uncommitted changes')
  // earlier checks still beat active
  expect(reason({ isSession: true, active: true })).toBe('the session works in it')
  expect(reason({ registered: false, active: true })).toBe('no longer a registered worktree')
  expect(reason({ branch: 'feature', active: true })).toBe('not on a worktree-* branch (feature)')
  // an active skip is not forgotten
  const plan = decideSelfClean({ ...OWN, active: true, locked: 'x' })
  expect(plan.kind === 'skip' && plan.forget).toBe(false)
})

test('mainCheckoutOf strips a trailing /.git or \\.git and nothing else', async () => {
  expect(mainCheckoutOf('C:/r/.git\n')).toBe('C:/r')
  expect(mainCheckoutOf('C:/r/.git\r\n')).toBe('C:/r')
  expect(mainCheckoutOf('  C:/r/.git  \n')).toBe('C:/r')
  expect(mainCheckoutOf('C:\\r\\.git')).toBe('C:\\r')
  expect(mainCheckoutOf('C:\\r\\.git\r\n')).toBe('C:\\r')
  expect(mainCheckoutOf('/home/u/repo/.git')).toBe('/home/u/repo')
  expect(mainCheckoutOf('C:/a/b c/.git')).toBe('C:/a/b c')
  expect(mainCheckoutOf('')).toBeUndefined()
  expect(mainCheckoutOf('\r\n')).toBeUndefined()
  expect(mainCheckoutOf('C:/r/repo.git')).toBeUndefined()
  expect(mainCheckoutOf('C:/r/.git/worktrees/x')).toBeUndefined()
  expect(mainCheckoutOf('C:/r/.github')).toBeUndefined()
  expect(mainCheckoutOf('C:/r/x.git')).toBeUndefined()
})

test('metaPathFor puts the meta file under the session dir, from a session or a subagent transcript', async () => {
  expect(metaPathFor(ODD_TRANSCRIPT, MEMBER.id)).toBe('D:/elsewhere/S1/subagents/agent-a2member.meta.json')
  expect(metaPathFor(TRANSCRIPT, MEMBER.id)).toBe(`${META_DIR}/agent-a2member.meta.json`)
  expect(metaPathFor(SUBAGENT_TRANSCRIPT, MEMBER.id)).toBe(`${META_DIR}/agent-a2member.meta.json`)
  // backslashes become slashes first
  expect(metaPathFor('C:\\h\\.claude\\projects\\C--r\\S1\\subagents\\agent-a1lead.jsonl', MEMBER.id)).toBe(`${META_DIR}/agent-a2member.meta.json`)
  expect(metaPathFor('D:\\elsewhere\\S1.jsonl', MEMBER.id)).toBe('D:/elsewhere/S1/subagents/agent-a2member.meta.json')
  // only the last parent directory decides, and only the trailing .jsonl is removed
  expect(metaPathFor('D:/subagents/S1.jsonl', 'x1')).toBe('D:/subagents/S1/subagents/agent-x1.meta.json')
  expect(metaPathFor('D:/e/S.jsonl.jsonl', 'x1')).toBe('D:/e/S.jsonl/subagents/agent-x1.meta.json')
})

test('metaFinished is true only for an object with finished === true', async () => {
  expect(metaFinished(META_FINISHED(MEMBER.id))).toBe(true)
  expect(metaFinished(META_FINISHED(LEAD.id))).toBe(true)
  expect(metaFinished('{"finished":true}')).toBe(true)
  expect(metaFinished(META_RUNNING(MEMBER.id))).toBe(false)
  expect(metaFinished(META_RESHAPED)).toBe(false)
  expect(metaFinished(META_NOT_JSON)).toBe(false)
  expect(metaFinished(undefined)).toBe(false)
  expect(metaFinished('')).toBe(false)
  expect(metaFinished('{"finished":false}')).toBe(false)
  expect(metaFinished('{"finished":1}')).toBe(false)
  expect(metaFinished('{"finished":"true"}')).toBe(false)
  expect(metaFinished('{"finished":null}')).toBe(false)
  expect(metaFinished('{}')).toBe(false)
  expect(metaFinished('null')).toBe(false)
  expect(metaFinished('true')).toBe(false)
  expect(metaFinished('"finished"')).toBe(false)
  expect(metaFinished('[{"finished":true}]')).toBe(false)
  expect(metaFinished('[true]')).toBe(false)
})

test('cherryMerged needs exit 0 and only "- " lines', async () => {
  expect(cherryMerged({ exitCode: 0, stdout: CHERRY_ALL_MINUS })).toBe(true)
  expect(cherryMerged({ exitCode: 0, stdout: CHERRY_ALL_MINUS.replace(/\n/g, '\r\n') })).toBe(true)
  expect(cherryMerged({ exitCode: 0, stdout: '- abc' })).toBe(true)
  expect(cherryMerged({ exitCode: 0, stdout: '- abc\n\n- def\n\n' })).toBe(true)
  expect(cherryMerged({ exitCode: 0, stdout: CHERRY_ONE_PLUS })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: CHERRY_ONE_PLUS.replace(/\n/g, '\r\n') })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: '+ abc\n' })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: '+ abc\n- def\n' })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: '' })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: '\r\n\n' })).toBe(false)
  expect(cherryMerged({ exitCode: 1, stdout: CHERRY_ALL_MINUS })).toBe(false)
  expect(cherryMerged({ exitCode: 128, stdout: '' })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: '-abc\n' })).toBe(false)
  expect(cherryMerged({ exitCode: 0, stdout: 'garbage\n' })).toBe(false)
})

test('agentWorktreeId returns the id of a direct agent worktree under the main checkout', async () => {
  expect(agentWorktreeId(MEMBER.path, MAIN, false)).toBe('a2member')
  expect(agentWorktreeId(LEAD.path, MAIN, true)).toBe('a1lead')
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/agent-a1/`, MAIN, false)).toBe('a1')
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/agent-a1`, `${MAIN}/`, false)).toBe('a1')
  // separators
  expect(agentWorktreeId('C:\\r\\.claude\\worktrees\\agent-a1', MAIN, true)).toBe('a1')
  expect(agentWorktreeId(MEMBER.path, 'C:\\r', true)).toBe('a2member')
  // windows folds case, linux does not
  expect(agentWorktreeId('c:\\R\\.claude\\worktrees\\agent-a2member', MAIN, true)).toBe('a2member')
  expect(agentWorktreeId('c:/r/.claude/worktrees/agent-a2member', MAIN, false)).toBeUndefined()
  // not an agent worktree
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/feature-x`, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/agent-a1/sub`, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/agent-`, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/agent-a_b`, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees/agent-A1`, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(MAIN, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(`${MAIN}/.claude/worktrees`, MAIN, false)).toBeUndefined()
  expect(agentWorktreeId(MEMBER.path, 'C:/other', false)).toBeUndefined()
  expect(agentWorktreeId(`C:/rr/.claude/worktrees/agent-a1`, MAIN, false)).toBeUndefined()
})

const entry = (path: string, at: number) => ({ path, at })
const sweepState = (): State => {
  const base = parseState(SLOTS_JSON)
  return {
    slots: base.slots,
    active: {
      [MEMBER.path.toLowerCase()]: entry(MEMBER.path, NOW - HOUR),
      [LEAD.path.toLowerCase()]: entry(LEAD.path, NOW - 2 * HOUR),
      [DIRTY_AGENT.path.toLowerCase()]: entry(DIRTY_AGENT.path, NOW - 3 * HOUR),
      [STALE.path.toLowerCase()]: entry(STALE.path, NOW - ACTIVE_FOR_MS),
      'c:/r/.claude/worktrees/agent-edge': entry('C:/r/.claude/worktrees/agent-edge', NOW - ACTIVE_FOR_MS + 1),
    },
  }
}
const keys = (s: State) => Object.keys(s.active).sort()
const only = (s: State, ...drop: string[]) => keys(s).filter((k) => !drop.includes(k))

test('sweepActive prunes entries at or past ACTIVE_FOR_MS and keeps the one just inside', async () => {
  const before = sweepState()
  const out = sweepActive(before, { now: NOW, finished: [], gone: [] }, true)
  expect(keys(out)).toEqual(only(before, STALE.path.toLowerCase()))
  expect(out.active['c:/r/.claude/worktrees/agent-edge']).toEqual(before.active['c:/r/.claude/worktrees/agent-edge'])
  // one tick later the edge entry is pruned as well
  const later = sweepActive(before, { now: NOW + 1, finished: [], gone: [] }, true)
  expect(keys(later)).not.toContain('c:/r/.claude/worktrees/agent-edge')
  // far past
  expect(keys(sweepActive(before, { now: NOW + 10 * ACTIVE_FOR_MS, finished: [], gone: [] }, true))).toEqual([])
})

test('sweepActive drops finished and gone paths, folding case and separators on windows', async () => {
  const before = sweepState()
  const m = MEMBER.path.toLowerCase()
  const l = LEAD.path.toLowerCase()
  const d = DIRTY_AGENT.path.toLowerCase()
  const fin = sweepActive(before, { now: NOW, finished: ['C:\\R\\.claude\\worktrees\\agent-a2member'], gone: [] }, true)
  expect(keys(fin)).not.toContain(m)
  expect(keys(fin)).toContain(l)
  const gone = sweepActive(before, { now: NOW, finished: [], gone: [LEAD.path + '/'] }, true)
  expect(keys(gone)).not.toContain(l)
  expect(keys(gone)).toContain(m)
  const both = sweepActive(before, { now: NOW, finished: [MEMBER.path], gone: [LEAD.path] }, true)
  expect(keys(both)).toEqual(only(before, m, l, STALE.path.toLowerCase()))
  expect(keys(both)).toContain(d)
  // an unknown path changes nothing beyond the age prune
  expect(keys(sweepActive(before, { now: NOW, finished: ['C:/r/nowhere'], gone: ['C:/r/also'] }, true))).toEqual(only(before, STALE.path.toLowerCase()))
})

test('sweepActive on linux matches case exactly', async () => {
  const lin: State = { slots: parseState(undefined).slots, active: { '/r/wt/A': entry('/r/wt/A', NOW), '/r/wt/a': entry('/r/wt/a', NOW) } }
  const out = sweepActive(lin, { now: NOW, finished: ['/r/wt/a'], gone: [] }, false)
  expect(keys(out)).toEqual(['/r/wt/A'])
})

test('sweepActive does not mutate its input, keeps slots, and leaves survivors identical', async () => {
  const before = sweepState()
  const snapshot = JSON.stringify(before)
  const out = sweepActive(before, { now: NOW, finished: [MEMBER.path], gone: [LEAD.path] }, true)
  expect(JSON.stringify(before)).toBe(snapshot)
  expect(out).not.toBe(before)
  expect(out.slots).toEqual(before.slots)
  const dk = DIRTY_AGENT.path.toLowerCase()
  expect(out.active[dk]).toEqual(before.active[dk])
  const frozenFacts = Object.freeze({ now: NOW, finished: Object.freeze([MEMBER.path]), gone: Object.freeze([] as string[]) })
  expect(() => sweepActive(before, frozenFacts, true)).not.toThrow()
  // empty state and empty facts
  expect(sweepActive(parseState(undefined), { now: NOW, finished: [], gone: [] }, true)).toEqual(parseState(undefined))
})

test('workflowWorktreeRun returns the run id of a direct wf_<run>-<n> worktree under the main checkout', () => {
  expect(workflowWorktreeRun('/r/.claude/worktrees/wf_0dff946d-af1-6', '/r', false)).toBe('wf_0dff946d-af1')
  expect(workflowWorktreeRun('C:\\R\\.claude\\worktrees\\WF_0dff946d-af1-18', 'C:/r', true)).toBe('wf_0dff946d-af1')
  expect(workflowWorktreeRun('/r/.claude/worktrees/agent-a1', '/r', false)).toBe(undefined)
  expect(workflowWorktreeRun('/r/.claude/worktrees/wf_0dff946d-af1', '/r', false)).toBe(undefined)
  expect(workflowWorktreeRun('/other/.claude/worktrees/wf_0dff946d-af1-6', '/r', false)).toBe(undefined)
  expect(workflowWorktreeRun('/r/.claude/worktrees/wf_0dff946d-af1-6/sub', '/r', false)).toBe(undefined)
})

test('workflowRunFinished is true only for a known end status', () => {
  expect(workflowRunFinished('{"status":"completed"}')).toBe(true)
  expect(workflowRunFinished('{"status":"failed"}')).toBe(true)
  expect(workflowRunFinished('{"status":"running"}')).toBe(false)
  expect(workflowRunFinished('{"status":"paused"}')).toBe(false)
  expect(workflowRunFinished('{not json')).toBe(false)
  expect(workflowRunFinished(undefined)).toBe(false)
})

test('workflowMetaWorktree takes only a wf_* worktreePath', () => {
  expect(workflowMetaWorktree('{"worktreePath":"/r/.claude/worktrees/wf_a-b-1"}')).toBe('/r/.claude/worktrees/wf_a-b-1')
  expect(workflowMetaWorktree('{"worktreePath":"/r/.claude/worktrees/agent-a1"}')).toBe(undefined)
  expect(workflowMetaWorktree('{"worktreePath":"/r"}')).toBe(undefined)
  expect(workflowMetaWorktree('{}')).toBe(undefined)
})

test('sessionDirOf finds the session dir from a session, subagent or Workflow agent transcript', () => {
  expect(sessionDirOf('/p/S1.jsonl')).toBe('/p/S1')
  expect(sessionDirOf('/p/S1/subagents/agent-a1.jsonl')).toBe('/p/S1')
  expect(sessionDirOf('/p/S1/subagents/workflows/wf_a-b/agent-a1.jsonl')).toBe('/p/S1')
  expect(sessionDirOf('C:\\p\\S1\\subagents\\agent-a1.jsonl')).toBe('C:/p/S1')
})
