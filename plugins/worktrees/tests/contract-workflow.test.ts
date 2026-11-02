import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Workflow-tool agents get `<main>/.claude/worktrees/wf_<run>-<n>` worktrees on `worktree-wf_<run>-<n>` branches,
// and their metas live under `<session>/subagents/workflows/<run>/`, never with `finished`. Their run's end is in
// `<session>/workflows/<run>.json` `status`. The sweep and SubagentStart/Stop must handle them like agent-<id>.
// POSIX paths, so the test runs the same on every OS.

const MAIN = '/r'
const SLOTS_PATH = '/r/.git/claude-worktrees/slots.json'
const PROJECT = '/h/.claude/projects/-r'
const SESSION = `${PROJECT}/S1`
const TRANSCRIPT = `${SESSION}.jsonl`
const NOW = 1_793_000_000_000
const HOUR = 3_600_000
const SHA = '4bada1f0123456789abcdef0123456789abcdef0'

type Wf = { run: string; path: string; branch: string }
const wf = (run: string, n: number): Wf => ({ run, path: `${MAIN}/.claude/worktrees/${run}-${n}`, branch: `worktree-${run}-${n}` })

const DONE = wf('wf_aaaa1111-bbb', 3) // run completed, clean, merged: removed
const DONE_DIRTY = wf('wf_aaaa1111-bbb', 4) // same run, merged but dirty: kept
const DONE_UNMERGED = wf('wf_aaaa1111-bbb', 5) // same run, not merged: kept
const RUNNING = wf('wf_cccc2222-ddd', 1) // run still running, empty branch (an ancestor of main): kept
const OTHER_SESSION = wf('wf_eeee3333-fff', 2) // run completed in another session of the project: removed
const ALL = [DONE, DONE_DIRTY, DONE_UNMERGED, RUNNING, OTHER_SESSION]

const runFile = (status: string) => JSON.stringify({ runId: 'x', status, agentCount: 3 })

function world(on: On, extra: Record<string, string> = {}) {
  const files = new Map<string, string>(
    Object.entries({
      [SLOTS_PATH]: JSON.stringify({ slots: {}, active: Object.fromEntries(ALL.map(w => [w.path, { path: w.path, at: NOW - HOUR }])) }),
      [`${SESSION}/workflows/${DONE.run}.json`]: runFile('completed'),
      [`${SESSION}/workflows/${RUNNING.run}.json`]: runFile('running'),
      [`${PROJECT}/S0/workflows/${OTHER_SESSION.run}.json`]: runFile('completed'),
      [`${PROJECT}/S0.jsonl`]: '',
      ...extra,
    }),
  )
  const ran: string[] = []
  const writes: { path: string; text: string }[] = []
  const clock = mock.clock(on, { now: NOW })
  on('classic.PostToolUse', async () => ({}))
  on('classic.SubagentStart', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  on('env.get', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: MAIN }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('fs.exists', async (_, e) => ({ value: files.has(e.path) || ALL.some(w => w.path === e.path) }))
  on('fs.list', async (_, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, string>()
    for (const p of files.keys()) {
      if (!p.startsWith(dir + '/')) continue
      const rest = p.slice(dir.length + 1)
      const name = rest.split('/')[0] as string
      names.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, isLink: false })) }
  })
  on('fs.read', async (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_, e) => {
    writes.push({ path: e.path, text: e.text })
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    const argv = e.argv as string[]
    const args = argv.join(' ')
    const cwd = (e as { init?: { cwd?: string } }).init?.cwd ?? MAIN
    ran.push(args)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal', isStdoutTruncated: false, isStderrTruncated: false } })
    const inWt = /^(\/r\/\.claude\/worktrees\/[^/]+)/.exec(cwd)
    if (args.includes('--show-toplevel')) return out(`${inWt ? inWt[1] : MAIN}\n`)
    if (args.includes('--git-common-dir')) return out('/r/.git\n')
    if (args.includes('--is-inside-work-tree')) return out('true\n')
    if (args === 'git branch --show-current') {
      const hit = ALL.find(w => w.path === inWt?.[1])
      return out(`${hit ? hit.branch : 'main'}\n`)
    }
    if (args === 'git worktree list --porcelain') {
      return out([MAIN, ...ALL.map(w => w.path)].map((p, i) => `worktree ${p}\nHEAD ${SHA}\nbranch refs/heads/${i === 0 ? 'main' : ALL[i - 1]?.branch}\n`).join('\n'))
    }
    if (args.startsWith('git merge-base --is-ancestor')) return out('', argv.includes(DONE_UNMERGED.branch) ? 1 : 0)
    if (args.startsWith('git status')) return out(cwd === DONE_DIRTY.path ? ' M a.txt\n' : '')
    if (args === 'git rev-parse HEAD^{tree}') return out('headtree\n')
    if (args.startsWith('git merge-tree')) return out('differenttree\n')
    if (args.startsWith('git cherry')) return out('+ 1111\n')
    return out('')
  })
  return { files, ran, writes, clock }
}

type Dollar = Parameters<Parameters<typeof test>[1]>[0]
const removes = (ran: string[], w: Wf) => ran.filter(r => r.includes('worktree remove') && r.endsWith(w.path))
const deletes = (ran: string[], w: Wf) => ran.filter(r => /^git branch -[dD] /.test(r) && r.endsWith(w.branch))
const lastActive = (writes: { path: string; text: string }[]) =>
  Object.keys((JSON.parse(writes.filter(x => x.path === SLOTS_PATH).at(-1)?.text ?? '{"active":{}}') as { active: Record<string, unknown> }).active)

async function sweep(w: ReturnType<typeof world>, $: Dollar) {
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'git merge --no-ff worktree-wf_aaaa1111-bbb-3' }, tool_response: '', tool_use_id: 't1', cwd: MAIN, transcript_path: TRANSCRIPT } as never)
  await w.clock.settle()
}

test('the merge sweep removes a finished Workflow run\'s merged, clean wf_* worktree and branch, and retires its entry', async ($, on) => {
  const w = world(on)
  await sweep(w, $)
  expect(removes(w.ran, DONE).length).toBe(1)
  expect(deletes(w.ran, DONE)).toEqual([`git branch -d ${DONE.branch}`])
  expect(removes(w.ran, OTHER_SESSION).length).toBe(1)
  const active = lastActive(w.writes)
  expect(active).not.toContain(DONE.path)
  expect(active).not.toContain(OTHER_SESSION.path)
})

test('the merge sweep never removes a dirty, unmerged or still-running wf_* worktree', async ($, on) => {
  const w = world(on)
  await sweep(w, $)
  for (const kept of [DONE_DIRTY, DONE_UNMERGED, RUNNING]) {
    expect(removes(w.ran, kept)).toEqual([])
    expect(deletes(w.ran, kept)).toEqual([])
  }
  expect(lastActive(w.writes)).toContain(RUNNING.path)
})

test('a run file with an unknown status, or none, counts as running', async ($, on) => {
  const w = world(on, { [`${SESSION}/workflows/${DONE.run}.json`]: runFile('paused') })
  w.files.delete(`${PROJECT}/S0/workflows/${OTHER_SESSION.run}.json`)
  await sweep(w, $)
  expect(removes(w.ran, DONE)).toEqual([])
  expect(removes(w.ran, OTHER_SESSION)).toEqual([])
})

test('SubagentStart and SubagentStop find a Workflow agent\'s wf_* worktree from its meta, and the stop retires its entry', async ($, on) => {
  const meta = `${SESSION}/subagents/workflows/${RUNNING.run}/agent-a77.meta.json`
  const w = world(on, { [meta]: JSON.stringify({ agentType: 'truss:writer', worktreePath: RUNNING.path, spawnedWithWorktree: true, spawnDepth: 1 }) })
  const started = await $.classic.SubagentStart({ cwd: MAIN, agent_id: 'a77', agent_type: 'truss:writer', transcript_path: TRANSCRIPT } as never)
  expect(started.additionalContext?.[0]).toContain(`on branch \`${RUNNING.branch}\``)
  await $.classic.SubagentStop({
    cwd: MAIN,
    agent_id: 'a77',
    agent_type: 'truss:writer',
    transcript_path: TRANSCRIPT,
    agent_transcript_path: `${SESSION}/subagents/workflows/${RUNNING.run}/agent-a77.jsonl`,
    background_tasks: [],
    stop_hook_active: false,
  } as never)
  await w.clock.settle()
  expect(lastActive(w.writes)).not.toContain(RUNNING.path)
  expect(lastActive(w.writes)).toContain(DONE.path)
  // the stop never removes a worktree: only a merge sweep does
  expect(removes(w.ran, RUNNING)).toEqual([])
})
