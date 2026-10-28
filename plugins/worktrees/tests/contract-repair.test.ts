import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import * as reg from '../hooks/register.ts'

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
  META_RUNNING,
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

// Contract test for the 2026-10-28 amendment to ADR-0015 ("Added by the 2026-10-28 amendment", seams 22-29).
// Written from the spec before the producer exists. The pure functions are read off the module namespace so a
// missing export fails one case, not the whole file. Sweep cases drive classic.PostToolUse with the engine
// mocked beneath the plugin, as contract-cleanup.test.ts does.

const R = reg as unknown as Record<string, (...a: never[]) => unknown>

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
  const state = { sessionCwd: opts.sessionCwd ?? MAIN, failGit: false, envThrows: false, listThrows: false }
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
  // ADR-0015 amendment 2026-10-28 (a): every sweep lists META_DIR; the mock answers with the metas in `files`
  on('fs.list', async (_, e) => {
    if (state.listThrows) throw new Error('EACCES')
    const dir = slashed(e.path).replace(/\/$/, '')
    const entries = [...files.keys()].filter(p => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1))
    return { value: entries.map(name => ({ name, kind: 'file', size: 0, isLink: false })) }
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
    const cwd = slashed(((e as { init?: { cwd?: string } }).init?.cwd ?? state.sessionCwd) as string)
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
    // ADR-0015 amendment 2026-10-28 (e): the sweep keeps everything unless the main checkout is on a branch
    if (args === 'git branch --show-current') return out('main\n')
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
async function sweep(w: World, $: Dollar, cwd: string, transcript: string | null = TRANSCRIPT, command = 'git merge --no-ff worktree-agent-a2member') {
  await $.classic.PostToolUse({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: '',
    tool_use_id: 't1',
    cwd,
    ...(transcript === null ? {} : { transcript_path: transcript }),
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


const mergeEvent = (w: World, $: Dollar, command: string, tool = 'Bash') =>
  $.classic.PostToolUse({ tool_name: tool, tool_input: { command }, tool_response: '', tool_use_id: 't1', cwd: MAIN, transcript_path: TRANSCRIPT } as never).then(() => w.clock.settle())
const deletes = (w: World, a: AgentFixture) => w.ran.filter(r => /^git (-c \S+ )?branch -[dD] /.test(r) && r.includes(a.branch))
const removed = (w: World) => w.ran.filter(r => r.includes('worktree remove'))

// ---- seam 22 -------------------------------------------------------------------------------------------------

test('22. isGitMerge is true for real merge commands (ADR-0015 amendment 2026-10-28 (c))', () => {
  const yes = [
    'git merge x',
    'git merge --no-ff --no-edit worktree-agent-a2member',
    'git merge --ff-only worktree-agent-a1lead',
    'git -C C:/r merge x',
    'git -c core.longpaths=true merge x',
    'git -c a=b merge y',
    'git --no-pager merge x',
    'cd C:/r && git merge x',
    'GIT_EDITOR=true git merge x',
    'C:/Git/bin/git.exe merge x',
    '/usr/bin/git merge y',
    'echo "$(git merge x)"',
  ]
  expect(typeof R.isGitMerge).toBe('function')
  expect(yes.filter(c => R.isGitMerge(c as never) !== true)).toEqual([])
})

test('22. isGitMerge is false for look-alikes (ADR-0015 amendment 2026-10-28 (c))', () => {
  const no = [
    'git merge-base --is-ancestor a b',
    'git merge-tree --write-tree a b',
    'git mergetool',
    'git commit -m "merge the writer"',
    'git commit -m "x; git merge y"',
    'git commit -m "merge x; git merge y"',
    'echo git merge',
    'git log --grep merge',
    "cat <<'EOF'\ngit merge x\nEOF",
    "cat <<EOF\ngit merge y\nEOF",
    "$x = @'\ngit merge x\n'@",
    'git commit -m "unbalanced',
  ]
  expect(typeof R.isGitMerge).toBe('function')
  expect(no.filter(c => R.isGitMerge(c as never) !== false)).toEqual([])
})

test('22. isGitMerge: a merge after a heredoc body still counts (ADR-0015 amendment 2026-10-28 (c) rule 1)', () => {
  expect(typeof R.isGitMerge).toBe('function')
  expect(R.isGitMerge("cat <<'EOF'\nbody\nEOF\ngit merge y" as never)).toBe(true)
})

// ---- seam 23 -------------------------------------------------------------------------------------------------

test('23. a non-merge command schedules no sweep (ADR-0015 amendment 2026-10-28 (c))', async ($, on) => {
  const w = world(on, { files: finished(MEMBER), merged: b => b === MEMBER.branch })
  await mergeEvent(w, $, 'git commit -m "merge"')
  await mergeEvent(w, $, 'git merge-base a b')
  await mergeEvent(w, $, 'git commit -m "merge"', 'PowerShell')
  expect(w.calls.map(c => c.args)).toEqual([])
})

test('23. a real merge schedules the sweep (ADR-0015 amendment 2026-10-28 (c))', async ($, on) => {
  const w = world(on, { files: finished(MEMBER), merged: b => b === MEMBER.branch })
  await mergeEvent(w, $, 'git -C C:/r merge x')
  expect(removes(w, MEMBER).length).toBe(1)
})

// ---- seam 24 -------------------------------------------------------------------------------------------------

const entry = (a: AgentFixture, text: string | undefined) => ({ name: `agent-${a.id}.meta.json`, text })

test('24. membersRunning (ADR-0015 amendment 2026-10-28 (a))', () => {
  const f = R.membersRunning as (id: string, metas: unknown) => boolean
  expect(typeof f).toBe('function')
  expect(f('a1lead', [entry(MEMBER, META_RUNNING(MEMBER.id))])).toBe(true)
  expect(f('a1lead', [entry(MEMBER, META_FINISHED(MEMBER.id))])).toBe(false)
  expect(f('a1lead', [])).toBe(false)
  expect(f('a1lead', [entry(LEAD, META_RUNNING('a1lead'))])).toBe(false)
  // a running agent of some other parent
  expect(f('a9other', [entry(MEMBER, META_RUNNING(MEMBER.id))])).toBe(false)
})

test('24. membersRunning fails safe: unreadable signal means running (ADR-0015 amendment 2026-10-28 (a))', () => {
  const f = R.membersRunning as (id: string, metas: unknown) => boolean
  expect(typeof f).toBe('function')
  expect(f('a1lead', undefined)).toBe(true)
  expect(f('a1lead', [entry(MEMBER, META_NOT_JSON)])).toBe(true)
  expect(f('a1lead', [entry(MEMBER, undefined)])).toBe(true)
  expect(f('a1lead', [entry(MEMBER, '[1,2]')])).toBe(true)
  expect(f('a1lead', [entry(MEMBER, 'null')])).toBe(true)
  // one bad entry among good ones still keeps
  expect(f('a1lead', [entry(NATIVE, META_FINISHED(NATIVE.id)), entry(MEMBER, META_NOT_JSON)])).toBe(true)
})

// ---- seam 25 -------------------------------------------------------------------------------------------------

const base = { path: MEMBER.path, registered: true, branch: MEMBER.branch, isSession: false, active: false, dirty: false, membersRunning: false, mainBranch: 'main' }
const decide = (f: Record<string, unknown>) => (R.decideSelfClean as (f: never) => { kind: string; deleteFlag?: string; reason?: string })({ ...base, ...f } as never)

test('25. decideSelfClean: members running always skips (ADR-0015 amendment 2026-10-28 (a))', () => {
  expect(decide({ membersRunning: true, inMain: 'ancestor' }).kind).toBe('skip')
  expect(decide({ membersRunning: true, inMain: 'tree' }).kind).toBe('skip')
})

test('25. decideSelfClean: not in main yet skips with the reason (ADR-0015 amendment 2026-10-28 (d))', () => {
  const p = decide({})
  expect(p.kind).toBe('skip')
  expect(p.reason).toBe(`${MEMBER.branch} is not in the main checkout's HEAD yet`)
})

test('25. decideSelfClean: ancestor of main removes with -d (ADR-0015 amendment 2026-10-28 (b))', () => {
  const p = decide({ inMain: 'ancestor' })
  expect(p.kind).toBe('remove')
  expect(p.deleteFlag).toBe('-d')
})

test('25. decideSelfClean: tree or cherry in main removes with -D (ADR-0015 amendment 2026-10-28 (b))', () => {
  for (const inMain of ['tree', 'cherry']) {
    const p = decide({ inMain })
    expect([inMain, p.kind, p.deleteFlag]).toEqual([inMain, 'remove', '-D'])
  }
})

test('25. decideSelfClean: tree or cherry never counts while main is on a worktree-* branch (ADR-0015 amendment 2026-10-28 (b))', () => {
  for (const inMain of ['tree', 'cherry']) {
    expect([inMain, decide({ inMain, mainBranch: 'worktree-agent-a1lead' }).kind]).toEqual([inMain, 'skip'])
  }
})

test('25. decideSelfClean: a main checkout on no branch keeps every candidate (ADR-0015 amendment 2026-10-28 (e))', () => {
  for (const inMain of ['ancestor', 'tree', 'cherry']) {
    const p = decide({ inMain, mainBranch: undefined })
    expect([inMain, p.kind, p.reason]).toEqual([inMain, 'skip', 'the main checkout is on no branch (detached or unreadable)'])
  }
})

// ---- seam 26 -------------------------------------------------------------------------------------------------

// the e2e lead: its meta says finished, a member of it is running, and the sweep's cwd is the member's checkout
const e2eLead = (memberMeta: string) => ({
  files: { [metaFile(LEAD)]: META_FINISHED(LEAD.id), [metaFile(MEMBER)]: memberMeta },
  answer: (args: string, cwd: string): Answer | undefined => {
    if (cwd === MEMBER.path && args.startsWith('git merge-tree')) return { stdout: 'membertree\n' }
    if (cwd === MEMBER.path && args === 'git rev-parse HEAD^{tree}') return { stdout: 'membertree\n' }
    return undefined
  },
})
const memberCwdRefs = (w: World) => w.calls.filter(c => c.cwd === MEMBER.path && c.argv.some(a => ['merge-base', 'merge-tree', 'cherry'].includes(a))).map(c => c.args)

test('26. e2e lead: finished meta, running member, member checkout as cwd keeps the lead (ADR-0015 amendment 2026-10-28 (a)(b))', async ($, on) => {
  const w = world(on, e2eLead(META_RUNNING(MEMBER.id)))
  await sweep(w, $, MEMBER.path, SUBAGENT_TRANSCRIPT, 'git merge --no-ff worktree-agent-a2member')
  expect(removes(w, LEAD)).toEqual([])
  expect(deletes(w, LEAD)).toEqual([])
  expect(memberCwdRefs(w)).toEqual([])
})

test('26. e2e lead: member finished too, its checkout is still no ref (ADR-0015 amendment 2026-10-28 (b))', async ($, on) => {
  const w = world(on, e2eLead(META_FINISHED(MEMBER.id)))
  await sweep(w, $, MEMBER.path, SUBAGENT_TRANSCRIPT, 'git merge --no-ff worktree-agent-a2member')
  expect(removes(w, LEAD)).toEqual([])
  expect(deletes(w, LEAD)).toEqual([])
  expect(memberCwdRefs(w)).toEqual([])
})

// ---- seam 27 -------------------------------------------------------------------------------------------------

test('27. unreadable signal keeps every candidate (ADR-0015 amendment 2026-10-28 (a))', async ($, on) => {
  const w = world(on, { files: finished(MEMBER), merged: (b, cwd) => b === MEMBER.branch && cwd === MAIN })
  // control: with the signal readable the sweep removes the member
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER).length).toBe(1)
  w.ran.length = 0
  w.state.listThrows = true
  await sweep(w, $, MAIN)
  expect(removed(w)).toEqual([])
  w.state.listThrows = false
  w.ran.length = 0
  await sweep(w, $, MAIN, null)
  expect(removed(w)).toEqual([])
})

// ---- seam 28 / 29 --------------------------------------------------------------------------------------------

test('28. merged into the crew branch only is kept, then removed once main has it (ADR-0015 amendment 2026-10-28 (d))', async ($, on) => {
  let mainHas = false
  const w = world(on, {
    files: finished(MEMBER),
    merged: (b, cwd) => b === MEMBER.branch && (cwd === LEAD.path || (cwd === MAIN && mainHas)),
  })
  await sweep(w, $, LEAD.path)
  expect(removes(w, MEMBER)).toEqual([])
  expect(deletes(w, MEMBER)).toEqual([])
  expect(w.logs).toContain(`worktrees: self-clean kept ${MEMBER.path}: ${MEMBER.branch} is not in the main checkout's HEAD yet`)

  mainHas = true
  w.ran.length = 0
  await sweep(w, $, MAIN)
  const rm = w.ran.findIndex(r => r.includes('worktree remove') && r.includes(MEMBER.path))
  const del = w.ran.indexOf(`git branch -d ${MEMBER.branch}`)
  expect(rm).toBeGreaterThanOrEqual(0)
  expect(del).toBeGreaterThan(rm)
})

test('29. a refused branch delete is reported by name (ADR-0015 amendment 2026-10-28 (d))', async ($, on) => {
  const w = world(on, {
    files: finished(MEMBER),
    merged: (b, cwd) => b === MEMBER.branch && cwd === MAIN,
    answer: args => (args.startsWith('git branch -d') ? { exitCode: 1 } : undefined),
  })
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER).length).toBe(1)
  expect(w.toasts.some(t => t.includes(MEMBER.branch))).toBe(true)
})

// ---- amendment (e) -------------------------------------------------------------------------------------------

test('30. main checkout detached (show-current prints nothing): nothing is removed or deleted (ADR-0015 amendment 2026-10-28 (e))', async ($, on) => {
  const w = world(on, {
    files: finished(MEMBER),
    merged: (b, cwd) => b === MEMBER.branch && cwd === MAIN,
    answer: args => (args === 'git branch --show-current' ? { stdout: '' } : undefined),
  })
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER)).toEqual([])
  expect(deletes(w, MEMBER)).toEqual([])
  expect(w.ran.filter(r => r.includes('worktree remove') || /git branch -[dD]/.test(r))).toEqual([])
})

test('31. main checkout branch unreadable (show-current fails): nothing is removed or deleted (ADR-0015 amendment 2026-10-28 (e))', async ($, on) => {
  const w = world(on, {
    files: finished(MEMBER),
    merged: (b, cwd) => b === MEMBER.branch && cwd === MAIN,
    answer: args => (args === 'git branch --show-current' ? { exitCode: 128 } : undefined),
  })
  await sweep(w, $, MAIN)
  expect(removes(w, MEMBER)).toEqual([])
  expect(deletes(w, MEMBER)).toEqual([])
  expect(w.ran.filter(r => r.includes('worktree remove') || /git branch -[dD]/.test(r))).toEqual([])
})
