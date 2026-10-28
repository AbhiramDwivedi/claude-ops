import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  CHERRY_ALL_MINUS,
  CHERRY_ONE_PLUS,
  COMMON,
  DIRTY,
  FOUNDRY_CWD,
  HOUR,
  LEAD,
  LIVE_OTHER,
  LOCKED,
  MAIN,
  MEMBER,
  MERGE_TREE_CONFLICT,
  META_DIR,
  META_FINISHED,
  META_NOT_JSON,
  META_RESHAPED,
  NATIVE,
  NOW,
  ODD_TRANSCRIPT,
  PATCH_EQUIV,
  PLUS,
  SLOTS_JSON,
  SLOTS_PATH,
  STALE,
  SUBAGENT_TRANSCRIPT,
  TRANSCRIPT,
  WORKTREE_LIST_PORCELAIN,
  type AgentFixture,
} from './fixtures/run3.ts'

// Contract test for repo ADR-0015 ("Seams to pin", cases 1-17). Written before the producer exists, so most
// cases fail on main on behaviour. It drives classic.PostToolUse (the sweep) and $.tool.call (isolation) with
// the engine mocked beneath the plugin, as contract.test.ts does.

const slashed = (p: string) => p.replace(/\\/g, '/')
const metaFile = (a: AgentFixture) => `${META_DIR}/agent-${a.id}.meta.json`
const longpaths = (p: string) => `git -c core.longpaths=true worktree remove ${p}`
const lc = (a: AgentFixture) => a.path.toLowerCase()
const kept = (a: AgentFixture, why: string) => `worktrees: self-clean kept ${a.path}: ${why}`

type Answer = { stdout?: string; exitCode?: number }
type Opts = {
  files?: Record<string, string>
  // agents whose branch is an ancestor of HEAD in the given cwd
  merged?: (branch: string, cwd: string) => boolean
  status?: (cwd: string) => string
  // overrides what git says to one command; undefined falls through to the defaults
  answer?: (args: string, cwd: string) => Answer | undefined
  porcelain?: string
  gone?: string[] // worktree folders fs.exists reports missing
  sessionCwd?: string
}

// the engine beneath the plugin: a repo at MAIN on Windows, git answered by argv and cwd, files from a map,
// everything the plugin does recorded
function world(on: On, opts: Opts = {}) {
  const files = new Map<string, string>(Object.entries({ [SLOTS_PATH]: SLOTS_JSON, ...opts.files }).map(([k, v]) => [slashed(k), v]))
  const state = { sessionCwd: opts.sessionCwd ?? MAIN, failGit: false, envThrows: false }
  const calls: { args: string; argv: string[]; cwd: string }[] = []
  const ran: string[] = []
  const reads: string[] = []
  const writes: { path: string; text: string }[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const seen: Record<string, unknown>[] = []
  const clock = mock.clock(on, { now: NOW })
  const gone = new Set((opts.gone ?? []).map(slashed))

  on('classic.WorktreeCreate', async () => ({}))
  on('classic.PostToolUse', async () => ({}))
  on('env.get', async (_, e) => {
    if (state.envThrows) throw new Error('boom')
    const v: Record<string, string> = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\x', HOME: 'C:/Users/x' }
    return { value: v[(e as { name?: string; key?: string }).name ?? (e as { key?: string }).key ?? ''] }
  })
  on('session.cwd', async () => ({ value: state.sessionCwd }))
  on('ui.log', async (_, e) => {
    logs.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('fs.exists', async (_, e) => {
    const p = slashed(e.path)
    reads.push(p)
    return { value: files.has(p) || (!gone.has(p) && p.includes('/.claude/worktrees/agent-') && !p.endsWith('.json')) }
  })
  on('fs.read', async (_, e) => {
    const p = slashed(e.path)
    reads.push(p)
    const text = files.get(p)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_, e) => {
    writes.push({ path: slashed(e.path), text: e.text })
    files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('tool.call', async (_, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })

  on('process.run', async (_, e) => {
    const argv = e.argv as string[]
    const args = argv.join(' ')
    const cwd = slashed(((e as { cwd?: string }).cwd ?? state.sessionCwd) as string)
    calls.push({ args, argv, cwd })
    ran.push(args)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal: error', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (state.failGit && args.includes('rev-parse')) return out('', 128)
    const custom = opts.answer?.(args, cwd)
    if (custom !== undefined) return out(custom.stdout ?? '', custom.exitCode ?? 0)
    const inAgent = /^(C:\/r\/\.claude\/worktrees\/[^/]+)/.exec(cwd)
    if (args.includes('--show-toplevel')) return cwd === MAIN ? out(`${MAIN}\n`) : inAgent ? out(`${inAgent[1]}\n`) : out('', 128)
    if (args.includes('--git-common-dir')) return out(`${COMMON}\n`)
    if (args.includes('--is-inside-work-tree')) return out(cwd.startsWith(COMMON) ? 'false\n' : 'true\n')
    if (args === 'git worktree list --porcelain') return out(opts.porcelain ?? WORKTREE_LIST_PORCELAIN)
    if (args.startsWith('git merge-base --is-ancestor')) {
      const branch = argv[argv.indexOf('--is-ancestor') + 1] as string
      return out('', opts.merged?.(branch, cwd) ? 0 : 1)
    }
    if (args.startsWith('git status')) return out(opts.status?.(cwd) ?? '')
    if (args.endsWith('--verify --quiet HEAD')) return out('4bada1f0123456789abcdef0123456789abcdef0\n')
    if (args === 'git rev-parse HEAD^{tree}') return out('headtree\n')
    if (args.startsWith('git merge-tree')) return out('differenttree\n')
    if (args.includes('origin/main')) return out('0123456789012345678901234567890123456789\n')
    return out('')
  })
  return { files, state, calls, ran, reads, writes, logs, toasts, seen, clock }
}

type Dollar = Parameters<Parameters<typeof test>[1]>[0]
type World = ReturnType<typeof world>

// a merge by the main thread: the PostToolUse event, then the scheduled sweep run to completion
async function sweep(w: World, $: Dollar, cwd: string, transcript = TRANSCRIPT, command = 'git merge --no-ff worktree-agent-a2member') {
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: '',
    tool_use_id: 't1',
    cwd,
    transcript_path: transcript,
  } as never)
  await w.clock.settle()
}

const slotsWrites = (w: World) => w.writes.filter(x => x.path === slashed(SLOTS_PATH))
const lastActive = (w: World): Record<string, unknown> | undefined => {
  const last = slotsWrites(w).at(-1)
  return last === undefined ? undefined : (JSON.parse(last.text) as { active?: Record<string, unknown> }).active
}
const removes = (w: World, a: AgentFixture) => w.ran.filter(r => r.includes('worktree remove') && r.includes(a.path))
const branchDeletes = (w: World, a: AgentFixture) => w.ran.filter(r => /^git (-c \S+ )?branch -[dD] /.test(r) && r.includes(a.branch))
const finished = (...as: AgentFixture[]) => Object.fromEntries(as.map(a => [metaFile(a), META_FINISHED(a.id)]))

const call = ($: Dollar, type: string) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: type } as never) as Promise<{ deny?: string }>

test('1. member merged into the crew branch, crew HEAD as ref', async ($, on) => {
  const w = world(on, {
    files: finished(MEMBER),
    merged: (branch, cwd) => branch === MEMBER.branch && cwd === LEAD.path,
  })
  await sweep(w, $, LEAD.path)
  expect(w.ran).toContain(longpaths(MEMBER.path))
  expect(w.ran).toContain(`git branch -d ${MEMBER.branch}`)
})

test('2. crew branch merged into an unpushed local target, origin behind', async ($, on) => {
  const w = world(on, { files: finished(LEAD), merged: (branch, cwd) => branch === LEAD.branch && cwd === MAIN })
  await sweep(w, $, MAIN)
  expect(w.ran).toContain(longpaths(LEAD.path))
  expect(w.ran).toContain(`git branch -d ${LEAD.branch}`)
})

test('3. no remote or ref-moving calls', async ($, on) => {
  const w = world(on, {
    files: finished(LEAD, MEMBER, DIRTY, PATCH_EQUIV, PLUS, STALE),
    merged: (branch, cwd) => [LEAD.branch, MEMBER.branch, DIRTY.branch, STALE.branch].includes(branch) && (cwd === MAIN || cwd === LEAD.path || cwd === FOUNDRY_CWD),
    status: cwd => (cwd === DIRTY.path ? ' M a.txt\n' : ''),
    answer: args => {
      if (args.startsWith('git merge-tree') && (args.includes(PATCH_EQUIV.branch) || args.includes(PLUS.branch))) return MERGE_TREE_CONFLICT
      if (args.startsWith('git cherry')) return { stdout: args.includes(PATCH_EQUIV.branch) ? CHERRY_ALL_MINUS : CHERRY_ONE_PLUS }
      return undefined
    },
  })
  await sweep(w, $, LEAD.path)
  await sweep(w, $, MAIN)
  await sweep(w, $, FOUNDRY_CWD)
  await sweep(w, $, MAIN, ODD_TRANSCRIPT)
  // the sweeps really ran: they removed something
  expect(removes(w, MEMBER).length).toBeGreaterThan(0)
  const forbidden = new Set(['fetch', 'pull', 'push', 'update-ref', '--ff-only'])
  expect(w.calls.filter(c => c.argv.some(a => forbidden.has(a))).map(c => c.args)).toEqual([])
  expect(w.calls.filter(c => c.argv[0] === 'git' && c.argv.filter(a => !a.startsWith('-')).includes('merge')).map(c => c.args)).toEqual([])
  expect(w.ran.filter(r => r.includes('worktree remove') && r.includes('--force'))).toEqual([])
})

test('4. a finished meta retires active', async ($, on) => {
  const w = world(on, { files: finished(MEMBER), merged: b => b === MEMBER.branch })
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER).length).toBe(1)
  const active = lastActive(w)
  expect(active).toBeDefined()
  expect(Object.keys(active ?? {})).not.toContain(lc(MEMBER))
})

test('5. a missing or reshaped meta fails open', async ($, on) => {
  const w = world(on, { merged: b => b === MEMBER.branch })
  for (const meta of [undefined, META_RESHAPED, META_NOT_JSON]) {
    if (meta === undefined) w.files.delete(metaFile(MEMBER))
    else w.files.set(metaFile(MEMBER), meta)
    w.ran.length = 0
    w.writes.length = 0
    await sweep(w, $, MAIN)
    expect(removes(w, MEMBER)).toEqual([])
    for (const x of slotsWrites(w)) {
      expect((JSON.parse(x.text) as { active: Record<string, unknown> }).active[lc(MEMBER)]).toEqual({ path: MEMBER.path, at: NOW - HOUR })
    }
  }
})

test('6. entries past ACTIVE_FOR_MS are pruned', async ($, on) => {
  const w = world(on, { files: finished(STALE), merged: b => b === STALE.branch })
  await sweep(w, $, MAIN)
  const active = lastActive(w)
  expect(active).toBeDefined()
  expect(Object.keys(active ?? {})).not.toContain(lc(STALE))
  expect(removes(w, STALE).length).toBe(1)
})

test('7. dirty kept and reported', async ($, on) => {
  const w = world(on, { files: finished(DIRTY), merged: b => b === DIRTY.branch, status: cwd => (cwd === DIRTY.path ? ' M a.txt\n' : '') })
  await sweep(w, $, MAIN)
  expect(removes(w, DIRTY)).toEqual([])
  expect(w.logs).toContain('worktrees: self-clean kept C:/r/.claude/worktrees/agent-a5dirty: uncommitted changes')
  expect(w.toasts.some(t => t.includes(DIRTY.path))).toBe(true)
})

test('8. locked kept and reported', async ($, on) => {
  const w = world(on, { files: finished(LOCKED), merged: b => b === LOCKED.branch })
  await sweep(w, $, MAIN)
  expect(removes(w, LOCKED)).toEqual([])
  expect(w.logs.some(l => l.startsWith(`${kept(LOCKED, 'locked (')}`))).toBe(true)
  expect(w.toasts.some(t => t.includes(LOCKED.path))).toBe(true)
})

test('9. meta found from the transcript path', async ($, on) => {
  const odd = 'D:/elsewhere/S1/subagents/agent-a2member.meta.json'
  const w = world(on, { files: { [odd]: META_FINISHED(MEMBER.id), [metaFile(MEMBER)]: META_FINISHED(MEMBER.id) }, merged: b => b === MEMBER.branch })
  await sweep(w, $, MAIN, ODD_TRANSCRIPT)
  expect(w.reads).toContain(odd)
  expect(w.reads.filter(p => p.startsWith('C:/h/.claude') || p.startsWith('C:/Users/x') || p.startsWith('C:\\Users\\x'))).toEqual([])
  w.reads.length = 0
  await sweep(w, $, MAIN, SUBAGENT_TRANSCRIPT)
  expect(w.reads).toContain(metaFile(MEMBER))
})

test('10. isolation from inside the git common dir, and no cached false', async ($, on) => {
  const w = world(on, { sessionCwd: FOUNDRY_CWD })
  // git cannot find a repo from anywhere
  w.state.failGit = true
  await call($, 'kit:builder')
  expect(w.seen[0]?.isolation).toBe(undefined)
  expect(w.logs).toContain('worktrees: isolation skipped kit:builder: no repo found')
  // git answers again: inside the common dir, is-inside-work-tree is false and the common dir is COMMON
  w.state.failGit = false
  await call($, 'kit:builder')
  expect(w.seen[1]?.isolation).toBe('worktree')
  w.state.sessionCwd = MAIN
  await call($, 'kit:builder')
  expect(w.seen[2]?.isolation).toBe('worktree')
})

test('11. a throw in the isolation path is logged', async ($, on) => {
  const w = world(on)
  w.state.envThrows = true
  const r = await call($, 'kit:builder')
  expect(r?.deny).toBeUndefined()
  expect(w.seen.length).toBe(1)
  expect(w.seen[0]?.isolation).toBe(undefined)
  expect(w.logs.filter(l => l === 'worktrees: isolation failed for kit:builder: Error: boom').length).toBe(1)
  expect(w.toasts.filter(t => t.includes('could not give kit:builder a worktree')).length).toBe(1)
})

test('12. a merge from a cwd outside any work tree still sweeps', async ($, on) => {
  const w = world(on, { files: finished(LEAD), merged: (b, cwd) => b === LEAD.branch && cwd === MAIN })
  await sweep(w, $, FOUNDRY_CWD)
  const rm = w.calls.filter(c => c.args.includes('worktree remove') && c.args.includes(LEAD.path))
  expect(rm.length).toBe(1)
  expect(rm[0]?.cwd).toBe(MAIN)
})

test('13. empty tracked map, fresh session', async ($, on) => {
  // no WorktreeCreate was seen: the porcelain list and slots.json on disk are all the plugin has
  const w = world(on, { files: finished(MEMBER), merged: (b, cwd) => b === MEMBER.branch && cwd === MAIN })
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER).length).toBe(1)
})

test('14. a live agent in another session with an empty branch survives', async ($, on) => {
  // MEMBER, finished and merged, is the control: the sweep ran and removed what it should
  const w = world(on, { files: finished(MEMBER), merged: b => b === LIVE_OTHER.branch || b === MEMBER.branch })
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER).length).toBe(1)
  expect(removes(w, LIVE_OTHER)).toEqual([])
  expect(branchDeletes(w, LIVE_OTHER)).toEqual([])
  expect(slotsWrites(w).length).toBeGreaterThan(0)
  for (const x of slotsWrites(w)) {
    expect((JSON.parse(x.text) as { active: Record<string, unknown> }).active[lc(LIVE_OTHER)]).toEqual({ path: LIVE_OTHER.path, at: NOW - HOUR })
  }
})

test('15. native worktree swept', async ($, on) => {
  const w = world(on, { files: finished(NATIVE), merged: b => b === NATIVE.branch })
  await sweep(w, $, MAIN)
  expect(removes(w, NATIVE).length).toBe(1)
  expect(Object.keys(lastActive(w) ?? { [lc(NATIVE)]: 1 })).not.toContain(lc(NATIVE))
})

test('16. the cherry fallback', async ($, on) => {
  const w = world(on, {
    files: finished(PATCH_EQUIV, PLUS),
    answer: args => {
      if (args === `git merge-tree --write-tree HEAD ${PATCH_EQUIV.branch}` || args === `git merge-tree --write-tree HEAD ${PLUS.branch}`) return MERGE_TREE_CONFLICT
      if (args === `git cherry HEAD ${PATCH_EQUIV.branch}`) return { stdout: CHERRY_ALL_MINUS }
      if (args === `git cherry HEAD ${PLUS.branch}`) return { stdout: CHERRY_ONE_PLUS }
      return undefined
    },
  })
  await sweep(w, $, MAIN)
  const rm = w.ran.findIndex(r => r.includes('worktree remove') && r.includes(PATCH_EQUIV.path))
  const del = w.ran.indexOf(`git branch -D ${PATCH_EQUIV.branch}`)
  expect(rm).toBeGreaterThanOrEqual(0)
  expect(del).toBeGreaterThan(rm)
  expect(removes(w, PLUS)).toEqual([])
  expect(branchDeletes(w, PLUS)).toEqual([])
})

test('17. a stale entry whose folder is gone is retired', async ($, on) => {
  const porcelain = WORKTREE_LIST_PORCELAIN.split('\n\n').filter(b => !b.includes(NATIVE.path)).join('\n\n')
  const w = world(on, { porcelain, gone: [NATIVE.path], answer: args => (args.includes(NATIVE.branch) ? { exitCode: 128 } : undefined) })
  await sweep(w, $, MAIN)
  expect(slotsWrites(w).length).toBeGreaterThan(0)
  expect(Object.keys(lastActive(w) ?? { [lc(NATIVE)]: 1 })).not.toContain(lc(NATIVE))
  expect(removes(w, NATIVE)).toEqual([])
  expect(branchDeletes(w, NATIVE)).toEqual([])
})
