// Synthetic fixtures for ADR-0015's contract and unit tests, in the shapes foundry run 3 recorded:
// slots.json is {"slots":{},"active":{<lower-cased worktree path>: {path, at}}}, and an agent's
// <transcript dir>/<session>/subagents/agent-<id>.meta.json carries the keys listed in metaBase below.
// Data only, apart from the two meta builders. Every test imports from here and builds no second set.

export type AgentFixture = { readonly id: string; readonly path: string; readonly branch: string }

export const MAIN = 'C:/r'
export const COMMON = 'C:/r/.git'
export const SLOTS_PATH = 'C:/r/.git/claude-worktrees/slots.json'
export const FOUNDRY_CWD = 'C:/r/.git/foundry/S1'

export const NOW = 1_793_000_000_000
export const HOUR = 3_600_000

export const TRANSCRIPT = 'C:/h/.claude/projects/C--r/S1.jsonl'
export const SUBAGENT_TRANSCRIPT = 'C:/h/.claude/projects/C--r/S1/subagents/agent-a1lead.jsonl'
export const ODD_TRANSCRIPT = 'D:/elsewhere/S1.jsonl'
export const META_DIR = 'C:/h/.claude/projects/C--r/S1/subagents'

const agent = (id: string): AgentFixture => ({ id, path: `${MAIN}/.claude/worktrees/agent-${id}`, branch: `worktree-agent-${id}` })

export const LEAD = agent('a1lead')
export const MEMBER = agent('a2member')
export const NATIVE = agent('a3native')
export const LIVE_OTHER = agent('a4other')
export const DIRTY = agent('a5dirty')
export const LOCKED = agent('a6locked')
export const STALE = agent('a7stale')
export const PATCH_EQUIV = agent('a8cherry')
export const PLUS = agent('a9plus')

const SHA = '4bada1f0123456789abcdef0123456789abcdef0'
const wt = (path: string, branch: string, extra = '') => `worktree ${path}\nHEAD ${SHA}\nbranch refs/heads/${branch}\n${extra}`

export const WORKTREE_LIST_PORCELAIN = [
  wt(MAIN, 'main'),
  wt(LEAD.path, LEAD.branch),
  wt(MEMBER.path, MEMBER.branch),
  wt(NATIVE.path, NATIVE.branch),
  wt(LIVE_OTHER.path, LIVE_OTHER.branch),
  wt(DIRTY.path, DIRTY.branch),
  wt(LOCKED.path, LOCKED.branch, 'locked claude agent agent-a6locked (pid 4242)\n'),
  wt(STALE.path, STALE.branch),
  wt(PATCH_EQUIV.path, PATCH_EQUIV.branch),
  wt(PLUS.path, PLUS.branch),
].join('\n')

const slot = (a: AgentFixture, at: number) => [a.path.toLowerCase(), { path: a.path, at }] as const

export const SLOTS_JSON = JSON.stringify({
  slots: {},
  active: Object.fromEntries([
    slot(LEAD, NOW - HOUR),
    slot(MEMBER, NOW - HOUR),
    slot(NATIVE, NOW - HOUR),
    slot(DIRTY, NOW - HOUR),
    slot(LOCKED, NOW - HOUR),
    slot(LIVE_OTHER, NOW - HOUR),
    slot(STALE, NOW - 25 * HOUR),
  ]),
})

// the keys run 3 saw in a meta file; `finished` appears only once the agent has stopped
const metaBase = (id: string) => ({
  agentType: 'kit:builder',
  isBuiltIn: false,
  description: `synthetic agent ${id}`,
  name: `agent-${id}`,
  toolUseId: `toolu_${id}`,
  parentAgentId: 'a1lead',
  spawnDepth: 1,
  requestShape: 'task',
  requestNonInteractive: false,
  model: 'sonnet',
  effort: 'medium',
})

export const META_FINISHED = (id: string): string =>
  JSON.stringify({ ...metaBase(id), worktreePath: `${MAIN}/.claude/worktrees/agent-${id}`, spawnedWithWorktree: true, finished: true })

export const META_RUNNING = (id: string): string =>
  JSON.stringify({ ...metaBase(id), worktreePath: `${MAIN}/.claude/worktrees/agent-${id}`, spawnedWithWorktree: true })

// an agent that inherited its parent's worktree: it names `inheritedWorktreePath`, not `worktreePath`
export const META_INHERITED = (id: string): string =>
  JSON.stringify({ ...metaBase(id), inheritedWorktreePath: LEAD.path, spawnedWithWorktree: false, finished: true })

export const META_RESHAPED = '{"finished":"yes"}'
export const META_NOT_JSON = '{not json'

export const CHERRY_ALL_MINUS = '- 1111111111111111111111111111111111111111\n- 2222222222222222222222222222222222222222\n'
export const CHERRY_ONE_PLUS = '- 1111111111111111111111111111111111111111\n+ 3333333333333333333333333333333333333333\n'

export const MERGE_TREE_CONFLICT = {
  exitCode: 1,
  stdout: '5f1d0c0e2b7a4c3d9e8f7a6b5c4d3e2f1a0b9c8d\n\nCONFLICT (content): Merge conflict in a.txt\n',
}
