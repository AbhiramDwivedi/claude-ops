import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { COMMON, DIRTY, FOUNDRY_CWD, LEAD, LIVE_OTHER, LOCKED, MAIN, MEMBER, META_DIR, META_FINISHED, META_RUNNING, NOW, SLOTS_JSON, SLOTS_PATH, TRANSCRIPT, WORKTREE_LIST_PORCELAIN, type AgentFixture } from './fixtures/run3'

// the engine beneath the plugin: git says the session is in a repo, and the Agent call records what reached it
function world(on: On, inRepo = true) {
  const seen: Record<string, unknown>[] = []
  on('env.get', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: 'C:/r' }))
  on('ui.log', async () => ({ value: undefined }))
  on('process.run', async (_, e) => ({
    value: { exitCode: inRepo ? 0 : 128, stdout: inRepo && e.argv.includes('--git-common-dir') ? 'C:/r/.git\n' : inRepo && e.argv.includes('--is-inside-work-tree') ? 'true\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', async (_, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })
  return seen
}

test('runs an editing agent in a worktree', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose' } as never)
  expect(seen[0]?.isolation).toBe('worktree')
  expect(seen[0]?.prompt).toBe('p')
})

test('leaves a read-only agent, a remote one and a session outside git alone', async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'Explore' } as never)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', isolation: 'remote' } as never)
  expect(seen.map(e => e.isolation)).toEqual([undefined, 'remote'])
})

test('changes nothing outside a git repo', async ($, on) => {
  const seen = world(on, false)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
  expect(seen[0]?.isolation).toBe(undefined)
})

test('creates every worktree itself, from the HEAD of the checkout the hook runs in', async ($, on) => {
  const SHA = '4bada1f0123456789abcdef0123456789abcdef0'
  const ran: string[] = []
  const files = new Map<string, string>()
  mock.clock(on, { now: 1_000_000 })
  on('classic.WorktreeCreate', async () => ({}))
  on('env.get', async () => ({ value: 'Windows_NT' }))
  on('fs.exists', async (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', async (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', async (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    ran.push(`${e.init?.cwd ?? ''}> ${e.argv.join(' ')}`)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const args = e.argv.join(' ')
    if (args.includes('--show-toplevel')) return out('C:/r/feature-checkout\n')
    if (args.includes('--git-common-dir')) return out('C:/r/.git\n')
    if (args.endsWith('--verify --quiet HEAD')) return out(`${SHA}\n`)
    if (args.includes('refs/heads/worktree-')) return out('', 1)
    return out('')
  })
  const result = await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r/feature-checkout' })
  expect(result.worktreePath).toBe('C:/r/.claude/worktrees/agent-x1')
  // HEAD read where the hook runs, and the new branch based on that commit, not origin/HEAD
  expect(ran).toContain('C:/r/feature-checkout> git rev-parse --verify --quiet HEAD')
  expect(ran.some(r => r.endsWith(`git worktree add -b worktree-agent-x1 C:/r/.claude/worktrees/agent-x1 ${SHA}`))).toBe(true)
  expect(ran.some(r => r.includes('origin/HEAD'))).toBe(false)
  // the agent's worktree is recorded as in use, so a tidy leaves it alone
  const [[written, text]] = [...files.entries()] as [[string, string]]
  expect(written.replace(/\\/g, '/')).toBe('C:/r/.git/claude-worktrees/slots.json')
  expect(text).toContain('agent-x1')
})

test('takes more read-only types from its options', { options: { readOnlyAgents: 'auditor' } }, async ($, on) => {
  const seen = world(on)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'auditor' } as never)
  expect(seen[0]?.isolation).toBe(undefined)
})

test('takes no-isolate types from noIsolateAgents and readOnlyAgents at once', { options: { noIsolateAgents: 'builder', readOnlyAgents: 'auditor' } }, async ($, on) => {
  const seen = world(on)
  for (const t of ['builder', 'auditor', 'general-purpose']) await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: t } as never)
  expect(seen.map(e => e.isolation)).toEqual([undefined, undefined, 'worktree'])
})

// a workspace repo at C:/w whose .gitignore hides the nested repos svc-a and svc-b, and node_modules, which is no
// repo; `setup` says whether .claude/worktree-setup.sh is there. `grouped` puts the repos under services/, which
// .gitignore hides as a whole.
function workspace(on: On, setup: boolean, grouped = false) {
  const seen: Record<string, unknown>[] = []
  const toasts: string[] = []
  const ran: string[] = []
  const at = grouped ? 'C:/w/services' : 'C:/w'
  const present = new Set([`${at}/svc-a/.git`, `${at}/svc-b/.git`, ...(setup ? ['C:/w/.claude/worktree-setup.sh'] : [])])
  on('env.get', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: 'C:/w' }))
  on('fs.exists', async (_, e) => ({ value: present.has(e.path.replace(/\\/g, '/')) }))
  const listings: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean }[]> = {
    'C:/w/services': [
      { name: 'README.md', kind: 'file', size: 1, isLink: false },
      { name: 'linked', kind: 'other', size: 0, isLink: true },
      { name: 'svc-a', kind: 'dir', size: 0, isLink: false },
      { name: 'svc-b', kind: 'dir', size: 0, isLink: false },
    ],
    'C:/w/node_modules': [{ name: 'lodash', kind: 'dir', size: 0, isLink: false }],
  }
  on('fs.list', async (_, e) => {
    const listing = listings[(e.path ?? '').replace(/\\/g, '/')]
    if (listing === undefined) throw new Error('ENOENT')
    return { value: listing }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    const argv = e.argv.join(' ')
    ran.push(argv)
    const out = argv.includes('--git-common-dir')
      ? 'C:/w/.git\n'
      : argv.includes('--show-toplevel')
        ? 'C:/w\n'
        : argv.includes('ls-files')
          ? grouped
            ? 'services/\nnode_modules/\n'
            : 'svc-a/\nsvc-b/\nnode_modules/\n'
          : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', async (_, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })
  return { seen, toasts, ran }
}

test('keeps agents in the main checkout of a repo with ignored nested repos, and says why once', async ($, on) => {
  const { seen, toasts, ran } = workspace(on, false)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'kit:builder' } as never)
  expect(seen.map(e => e.isolation)).toEqual([undefined, undefined])
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('svc-a, svc-b')
  expect(toasts[0]?.includes('node_modules')).toBe(false)
  // found once for the session
  expect(ran.filter(r => r.includes('ls-files')).length).toBe(1)
})

test('finds nested repos one level inside a directory ignored as a whole', async ($, on) => {
  const { seen, toasts } = workspace(on, false, true)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
  expect(seen[0]?.isolation).toBe(undefined)
  expect(toasts[0]).toContain('services/svc-a, services/svc-b')
})

test('isolates agents in a repo with nested repos when it has a setup script', async ($, on) => {
  const { seen, toasts, ran } = workspace(on, true)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
  expect(ran.some(r => r.includes('ls-files'))).toBe(true)
  expect(seen[0]?.isolation).toBe('worktree')
  expect(toasts).toEqual([])
})

test('isolates agents in a repo with nested repos when isolateNestedRepos is set', { options: { isolateNestedRepos: true } }, async ($, on) => {
  const { seen, toasts, ran } = workspace(on, false)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
  expect(seen[0]?.isolation).toBe('worktree')
  expect(toasts).toEqual([])
  expect(ran.some(r => r.includes('ls-files'))).toBe(false)
})

test('sends an agent back to stop its own background shell, and cleans up nothing yet', async ($, on) => {
  const ran: string[] = []
  on('classic.SubagentStop', async () => ({}))
  on('fs.exists', async () => ({ value: true }))
  on('process.run', async (_, e) => {
    ran.push(e.argv.join(' '))
    const found = e.argv.includes('grep') ? 'b1shell\n' : ''
    return { value: { exitCode: 0, stdout: found, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const input = {
    cwd: 'C:/r/.claude/worktrees/agent-a1',
    agent_id: 'a1',
    agent_type: 'general-purpose',
    agent_transcript_path: 'C:/t/agent-a1.jsonl',
    background_tasks: [
      { id: 'b1shell', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' },
      { id: 'b2other', type: 'shell', status: 'running', description: 'not mine', command: 'ssh host' },
    ],
  }
  const blocked = await $.classic.SubagentStop({ ...input, stop_hook_active: false } as never)
  expect(blocked.block).toContain('b1shell npm run dev')
  expect(blocked.block?.includes('b2other')).toBe(false)
  // the transcript is searched where it lives; outside a repo nothing else runs, so no slot release or process stop
  expect(ran).toEqual(['git grep --no-index -h -o -F -e b1shell -e b2other -- agent-a1.jsonl', 'git rev-parse --show-toplevel'])
  // the stop after the refusal goes through
  const again = await $.classic.SubagentStop({ ...input, stop_hook_active: true } as never)
  expect(again.block).toBe(undefined)
})

// a repo at C:/r with agent a1's worktree, its git answers scripted; `status` is what `git status --porcelain` says
function agentRepo(on: On, status: () => string) {
  const ran: string[] = []
  const toasts: string[] = []
  const WT = 'C:/r/.claude/worktrees/agent-a1'
  // the engine hands the hook a resolved path: backslashes on Windows
  on('fs.exists', async (_, e) => ({ value: e.path.replace(/\\/g, '/') === WT }))
  on('session.cwd', async () => ({ value: 'C:/r' }))
  on('ui.log', async () => ({ value: undefined }))
  on('env.get', async () => ({ value: 'Windows_NT' }))
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    const argv = e.argv.join(' ')
    ran.push(`${e.init?.cwd ?? ''}> ${argv}`)
    const out =
      argv === 'git rev-parse --show-toplevel'
        ? e.init?.cwd === WT ? WT : 'C:/r'
        : argv === 'git rev-parse --path-format=absolute --git-common-dir'
          ? 'C:/r/.git'
          : argv === 'git branch --show-current'
            ? 'worktree-agent-a1'
            : argv.startsWith('git status --porcelain')
              ? status()
              : ''
    return { value: { exitCode: 0, stdout: out + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, toasts }
}

test('tells an agent in a worktree to commit on its branch, found by its id when its cwd is the session', async ($, on) => {
  agentRepo(on, () => '')
  on('classic.SubagentStart', async () => ({}))
  const started = await $.classic.SubagentStart({ cwd: 'C:/r', agent_id: 'a1', agent_type: 'general-purpose' } as never)
  expect(started.additionalContext?.[0]).toContain('on branch `worktree-agent-a1`')
  const other = await $.classic.SubagentStart({ cwd: 'C:/r', agent_id: 'zz', agent_type: 'Explore' } as never)
  expect(other.additionalContext).toBe(undefined)
})

test('sends a dirty agent back once, then commits what it left, with --no-verify', async ($, on) => {
  const { ran, toasts } = agentRepo(on, () => ' M a.ts\n?? b.ts')
  on('classic.SubagentStop', async () => ({}))
  const input = { cwd: 'C:/r/.claude/worktrees/agent-a1', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: 'C:/t/a.jsonl', background_tasks: [] }
  const blocked = await $.classic.SubagentStop({ ...input, stop_hook_active: false } as never)
  expect(blocked.block).toContain('has uncommitted changes (2 files)')
  expect(ran.some(r => r.includes('git commit'))).toBe(false)
  const again = await $.classic.SubagentStop({ ...input, stop_hook_active: true } as never)
  expect(again.block).toBe(undefined)
  const wt = 'C:/r/.claude/worktrees/agent-a1> '
  expect(ran).toContain(`${wt}git add -A`)
  expect(ran).toContain(`${wt}git commit --no-verify --quiet -m WIP: uncommitted changes left by general-purpose a1`)
  expect(toasts[0]).toContain('committed them as WIP on worktree-agent-a1')
})

test('tells the main thread to merge agent branches, in a repo only', async ($, on) => {
  world(on)
  on('classic.SessionStart', async () => ({}))
  const r = await $.classic.SessionStart({ cwd: 'C:/r', source: 'startup' } as never)
  expect(r.additionalContext?.[0]).toContain('worktree-*')
})

// --- self-cleanup after a merge ---

const X1 = 'C:/r/.claude/worktrees/agent-x1'
const ZZ = 'C:/r/.claude/worktrees/agent-zz'
const HEAD_SHA = '4bada1f0123456789abcdef0123456789abcdef0'
const STATE = 'C:/r/.git/claude-worktrees/slots.json'

// a session in the main checkout C:/r on Windows, with agent-zz's worktree left by another session; `answer`
// overrides what git says to one command line
function sessionRepo(on: On, answer: (args: string) => { stdout?: string; exitCode?: number } | undefined = () => undefined) {
  const ran: string[] = []
  const toasts: string[] = []
  const files = new Map<string, string>()
  const key = (path: string) => path.replace(/\\/g, '/')
  const clock = mock.clock(on, { now: 1_000_000 })
  on('classic.WorktreeCreate', async () => ({}))
  on('classic.PostToolUse', async () => ({}))
  on('env.get', async () => ({ value: 'Windows_NT' }))
  on('session.cwd', async () => ({ value: 'C:/r' }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_, e) => ({ value: files.has(key(e.path)) }))
  on('fs.read', async (_, e) => ({ value: files.get(key(e.path)) ?? '' }))
  on('fs.write', async (_, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    const args = e.argv.join(' ')
    ran.push(args)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'error: boom', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const custom = answer(args)
    if (custom !== undefined) return out(custom.stdout ?? '', custom.exitCode ?? 0)
    if (args.includes('--show-toplevel')) return out('C:/r\n')
    if (args.includes('--git-common-dir')) return out('C:/r/.git\n')
    if (args.endsWith('--verify --quiet HEAD')) return out(`${HEAD_SHA}\n`)
    if (args.includes('refs/heads/worktree-')) return out('', 1)
    if (args === 'git worktree list --porcelain') {
      const wt = (path: string, branch: string) => `worktree ${path}\nHEAD ${HEAD_SHA}\nbranch refs/heads/${branch}\n`
      return out([wt('C:/r', 'main'), wt(X1, 'worktree-agent-x1'), wt(ZZ, 'worktree-agent-zz')].join('\n'))
    }
    return out('')
  })
  return { ran, toasts, files, clock }
}

const bash = (command: string, tool_name = 'Bash') => ({ tool_name, tool_input: { command }, tool_response: '', tool_use_id: 't1', cwd: 'C:/r' }) as never

test('sweeps nothing on a command without merge, or another tool', async ($, on) => {
  const { ran, clock, files } = sessionRepo(on)
  files.set(STATE, JSON.stringify({ slots: {}, active: { [ZZ.toLowerCase()]: { path: ZZ, at: 1_000_000 - 1000 }, [X1.toLowerCase()]: { path: X1, at: 1_000_000 - 1000 } } }))
  await $.classic.PostToolUse(bash('git merge --ff-only worktree-agent-zz'))
  await clock.settle()
  // ADR-0015 section 3: an empty tracked map no longer skips the sweep, so the sweep runs; it removes nothing that is live
  expect(ran.some(r => r.includes('worktree remove') || r.includes('branch -'))).toBe(false)
  await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r' })
  ran.length = 0
  await $.classic.PostToolUse(bash('git status'))
  await $.classic.PostToolUse(bash('git merge worktree-agent-x1', 'Read'))
  await clock.settle()
  expect(ran).toEqual([])
})

test("removes the session's own merged agent worktree and branch after a merge, and leaves another session's alone", async ($, on) => {
  const { ran, toasts, files, clock } = sessionRepo(on)
  // agent-zz's entry, from its own session's WorktreeCreate: live for 24 hours (ADR-0015 section 5)
  const zzActive = { [ZZ.toLowerCase()]: { path: ZZ, at: 1_000_000 - 1000 } }
  files.set(STATE, JSON.stringify({ slots: {}, active: zzActive }))
  await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r' })
  // a merge while the agent still runs removes nothing
  await $.classic.PostToolUse(bash('git merge --ff-only worktree-agent-x1'))
  await clock.settle()
  expect(ran.some(r => r.includes('worktree remove'))).toBe(false)
  // its agent stopped: SubagentStop's cleanup marked it done
  files.set(STATE, JSON.stringify({ slots: {}, active: zzActive }))
  ran.length = 0
  await $.classic.PostToolUse(bash('gh pr merge 12 --squash', 'PowerShell'))
  await clock.settle()
  expect(ran).toContain(`git -c core.longpaths=true worktree remove ${X1}`)
  expect(ran).toContain('git branch -d worktree-agent-x1')
  expect(ran.some(r => r.includes('agent-zz') && !r.startsWith('git worktree list'))).toBe(false)
  expect(ran.some(r => r.includes('--force') || r.includes('branch -D') || r.includes('push'))).toBe(false)
  expect(toasts).toEqual(['worktrees: removed merged worktree-agent-x1'])
  // removed once: the sweep still runs (ADR-0015 section 3), but the listing it reads is the mock's fixed one and agent-zz is live
  ran.length = 0
  await $.classic.PostToolUse(bash('git merge other'))
  await clock.settle()
  expect(ran.some(r => r.includes('worktree remove') && r.includes('agent-zz'))).toBe(false)
})

test('keeps an unmerged or dirty agent worktree, and toasts nothing', async ($, on) => {
  let status = ''
  const { ran, toasts, files, clock } = sessionRepo(on, args =>
    args.startsWith('git merge-base --is-ancestor') ? { exitCode: 1 } : args === 'git rev-parse HEAD^{tree}' ? { stdout: 'headtree\n' } : args.startsWith('git merge-tree') ? { stdout: 'differenttree\n' } : args.startsWith('git status') ? { stdout: status } : undefined,
  )
  await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r' })
  files.set(STATE, JSON.stringify({ slots: {}, active: {} }))
  await $.classic.PostToolUse(bash('git merge feature'))
  await clock.settle()
  expect(ran).toContain('git merge-tree --write-tree HEAD worktree-agent-x1')
  status = ' M a.ts\n'
  await $.classic.PostToolUse(bash('git merge feature'))
  await clock.settle()
  expect(ran.some(r => r.includes('worktree remove'))).toBe(false)
  expect(toasts).toEqual([])
})

test('no longer tidies at session start', async ($, on) => {
  const { ran, clock } = sessionRepo(on)
  on('session.start', async (_, e) => e as never)
  await $.session.start({ cwd: 'C:/r', surface: null } as never)
  await clock.advance(60_000)
  expect(ran).toEqual([])
})

test('finishes a remove git failed after unregistering the worktree, and reports one still registered', async ($, on) => {
  // git fails the remove; `unregisters` says whether it had already dropped the worktree from its list
  let unregisters = false
  let tried = false
  const listing = (withX1: boolean) =>
    [`worktree C:/r\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n`, withX1 ? `worktree ${X1}\nHEAD ${HEAD_SHA}\nbranch refs/heads/worktree-agent-x1\n` : ''].join('\n')
  const { ran, toasts, files, clock } = sessionRepo(on, args => {
    if (args.includes('worktree remove')) {
      tried = true
      return { exitCode: 1 }
    }
    return args === 'git worktree list --porcelain' ? { stdout: listing(!(tried && unregisters)) } : undefined
  })
  await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r' })
  files.set(STATE, JSON.stringify({ slots: {}, active: {} }))
  // still registered after the failure: reported, nothing deleted by hand, the branch kept
  await $.classic.PostToolUse(bash('git merge feature'))
  await clock.settle()
  expect(ran).toContain(`git -c core.longpaths=true worktree remove ${X1}`)
  expect(ran.some(r => r.startsWith('cmd.exe /d /c rd') || r.includes('worktree prune') || r.includes('branch -d'))).toBe(false)
  expect(toasts).toEqual([])
  // unregistered: the ignored files left are deleted with a long-path-safe rd, then pruned, and it counts as removed
  unregisters = true
  tried = false
  await $.classic.PostToolUse(bash('git merge feature'))
  await clock.settle()
  expect(ran).toContain('cmd.exe /d /c rd /s /q \\\\?\\C:\\r\\.claude\\worktrees\\agent-x1')
  expect(ran).toContain('git worktree prune')
  expect(ran).toContain('git branch -d worktree-agent-x1')
  expect(toasts).toEqual(['worktrees: removed merged worktree-agent-x1'])
})

// kit manifest read-only declarations fold ASCII letters only: declared names are ASCII (MANIFEST_AGENT_NAME),
// so U+212A KELVIN SIGN must not lower-case into "k" and borrow the exemption of "kit:keeper"
test('kit manifest match folds ASCII case only: KELVIN SIGN does not match a declared name', async ($, on) => {
  const MANIFEST = 'C:/r/.claude/kit/manifest.json'
  const text = JSON.stringify({ version: 1, kit: '0.2.0', checks: [], agents: [{ name: 'kit:keeper', readOnly: true, declaredBy: 'kit' }], riskyPaths: [], setupScripts: [] })
  const seen: Record<string, unknown>[] = []
  on('process.run', async (_, e) => {
    const args = e.argv.join(' ')
    const stdout = args.includes('--git-common-dir') ? 'C:/r/.git\n' : args.includes('--is-inside-work-tree') ? 'true\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_, e) => ({ value: e.path.replace(/\\/g, '/') === MANIFEST }))
  on('fs.read', async () => ({ value: text }))
  on('env.get', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: 'C:/r' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.call', async (_, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })
  for (const t of ['\u212Ait:keeper', 'KIT:KEEPER', 'kit:keeper'])
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: t } as never)
  expect(seen.map(e => e.isolation)).toEqual(['worktree', undefined, undefined])
})

// ---------------- sweep and spawn races: the cleanup sweep must never remove a live agent ----------------
const slashed = (p: string) => p.replace(/\\/g, '/')
const metaFile = (a: AgentFixture) => `${META_DIR}/agent-${a.id}.meta.json`

type CleanupAnswer = { stdout?: string; exitCode?: number }
type CleanupOpts = {
  files?: Record<string, string>
  // agents whose branch is an ancestor of HEAD in the given cwd
  merged?: (branch: string, cwd: string) => boolean
  status?: (cwd: string) => string
  // overrides what git says to one command; undefined falls through to the defaults
  answer?: (args: string, cwd: string) => CleanupAnswer | undefined
  porcelain?: string
  gone?: string[] // worktree folders fs.exists reports missing
  sessionCwd?: string
  hook?: (args: string, cwd: string) => Promise<CleanupAnswer | undefined> | CleanupAnswer | undefined
  porcelainFn?: () => string | undefined
}

// the engine beneath the plugin: a repo at MAIN on Windows, git answered by argv and cwd, files from a map,
// everything the plugin does recorded
function cleanupWorld(on: On, opts: CleanupOpts = {}) {
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
    const cwd = slashed(((e as { init?: { cwd?: string } }).init?.cwd ?? state.sessionCwd) as string)
    calls.push({ args, argv, cwd })
    ran.push(args)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal: error', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (state.failGit && args.includes('rev-parse')) return out('', 128)
    const custom = (await opts.hook?.(args, cwd)) ?? opts.answer?.(args, cwd)
    if (custom !== undefined) return out(custom.stdout ?? '', custom.exitCode ?? 0)
    const inAgent = /^(C:\/r\/\.claude\/worktrees\/[^/]+)/.exec(cwd)
    if (args.includes('--show-toplevel')) return cwd === MAIN ? out(`${MAIN}\n`) : inAgent ? out(`${inAgent[1]}\n`) : out('', 128)
    if (args.includes('--git-common-dir')) return out(`${COMMON}\n`)
    if (args.includes('--is-inside-work-tree')) return out(cwd.startsWith(COMMON) ? 'false\n' : 'true\n')
    if (args === "git worktree list --porcelain") return out(opts.porcelainFn?.() ?? opts.porcelain ?? WORKTREE_LIST_PORCELAIN)
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
  return { files, state, calls, ran, reads, writes, logs, toasts, seen, clock, gone }
}

type CleanupDollar = Parameters<Parameters<typeof test>[1]>[0]
type CleanupWorld = ReturnType<typeof cleanupWorld>

// a merge by the main thread: the PostToolUse event, then the scheduled sweep run to completion
async function cleanupSweep(w: CleanupWorld, $: CleanupDollar, cwd: string, transcript = TRANSCRIPT, command = 'git merge --no-ff worktree-agent-a2member') {
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

const slotsWrites = (w: CleanupWorld) => w.writes.filter(x => x.path === slashed(SLOTS_PATH))
const removes = (w: CleanupWorld, a: AgentFixture) => w.ran.filter(r => r.includes('worktree remove') && r.includes(a.path))
const branchDeletes = (w: CleanupWorld, a: AgentFixture) => w.ran.filter(r => /^git (-c \S+ )?branch -[dD] /.test(r) && r.includes(a.branch))
const finished = (...as: AgentFixture[]) => Object.fromEntries(as.map(a => [metaFile(a), META_FINISHED(a.id)]))

// ---------------- red-team probes ----------------
const WTD = '/.claude/worktrees/'
const NEW: AgentFixture = { id: 'b1new', path: MAIN + WTD + 'agent-b1new', branch: 'worktree-agent-b1new' }
const wtOf = (a: AgentFixture) => 'worktree ' + a.path + '\nHEAD 4bada1f0123456789abcdef0123456789abcdef0\nbranch refs/heads/' + a.branch + '\n'
const PORC_NEW = WORKTREE_LIST_PORCELAIN + '\n' + wtOf(NEW)
const activeWrites = (w: CleanupWorld) => w.writes.filter(x => x.path === slashed(SLOTS_PATH)).map(x => Object.keys((JSON.parse(x.text) as { active: object }).active))

test('a worktree created from the foundry dir is recorded active and survives a sweep', async ($, on) => {
  const w = cleanupWorld(on, { porcelain: PORC_NEW, merged: b => b === NEW.branch, files: { [metaFile(NEW)]: META_RUNNING(NEW.id) } })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: FOUNDRY_CWD } as never)
  expect(activeWrites(w).some(k => k.some(p => p.endsWith('/agent-' + NEW.id)))).toBe(true)
  await cleanupSweep(w, $, MAIN)
  expect(removes(w, NEW)).toEqual([])
  expect(branchDeletes(w, NEW)).toEqual([])
})

test('a sweep during WorktreeCreate does not remove the new worktree', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  let added = false
  let gated = false
  const w: CleanupWorld = cleanupWorld(on, {
    files: { 'C:/r/.worktreeinclude': '.env\n', [metaFile(NEW)]: META_RUNNING(NEW.id) },
    gone: [NEW.path],
    merged: b => b === NEW.branch,
    porcelainFn: () => (added ? PORC_NEW : undefined),
    hook: async args => {
      if (args.includes(' worktree ad' + 'd')) {
        added = true
        w.gone.delete(NEW.path)
        return {}
      }
      if (args.includes('ls-files --others --ignored --exclude-from')) {
        gated = true
        await gate
        return { stdout: '' }
      }
      return undefined
    },
  })
  const creating = $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  for (let i = 0; i < 5000 && !gated; i++) await Promise.resolve()
  await cleanupSweep(w, $, MAIN)
  const during = removes(w, NEW)
  release()
  await creating
  expect(during).toEqual([])
})

test('an unparseable slots.json makes the sweep remove and write nothing', async ($, on) => {
  const trunc = SLOTS_JSON.slice(0, SLOTS_JSON.indexOf('a4other'))
  const w = cleanupWorld(on, { files: { [SLOTS_PATH]: trunc }, merged: b => b === LIVE_OTHER.branch })
  await cleanupSweep(w, $, MAIN)
  expect(removes(w, LIVE_OTHER)).toEqual([])
  expect(slotsWrites(w)).toEqual([])
  expect(w.files.get(slashed(SLOTS_PATH))).toBe(trunc)
})

test('a non-agent worktree name and the session own checkout are never swept', async ($, on) => {
  const FOO: AgentFixture = { id: 'x', path: MAIN + WTD + 'foo', branch: 'worktree-foo' }
  const w = cleanupWorld(on, { porcelain: WORKTREE_LIST_PORCELAIN + '\n' + wtOf(FOO), files: finished(LEAD), merged: () => true })
  await cleanupSweep(w, $, LEAD.path)
  expect(removes(w, FOO)).toEqual([])
  expect(removes(w, LEAD)).toEqual([])
})

test('a mixed-case backslash porcelain path still matches its active entry', async ($, on) => {
  const odd = LIVE_OTHER.path.toUpperCase().split('/').join(String.fromCharCode(92))
  const porc = WORKTREE_LIST_PORCELAIN.replace('worktree ' + LIVE_OTHER.path, 'worktree ' + odd)
  const w = cleanupWorld(on, { porcelain: porc, merged: b => b === LIVE_OTHER.branch })
  await cleanupSweep(w, $, MAIN)
  const r = w.ran.filter(x => x.includes('worktree remove') && x.toLowerCase().includes('a4other'))
  expect(r).toEqual([])
})

test('a throwing slots.json read removes nothing and leaves the lock balanced', async ($, on) => {
  const w = cleanupWorld(on, { files: finished(MEMBER), merged: b => b === MEMBER.branch })
  w.files.set(slashed(SLOTS_PATH), undefined as unknown as string)
  await cleanupSweep(w, $, MAIN)
  const mk = w.ran.filter(x => x.includes('mkdir')).length
  const rm = w.ran.filter(x => x.includes('rmdir')).length
  expect(mk).toBe(rm)
})

test('a worktree with untracked files, and a locked one, are kept without force', async ($, on) => {
  const w = cleanupWorld(on, { files: finished(DIRTY, LOCKED), merged: b => b === DIRTY.branch || b === LOCKED.branch, status: c => (c === DIRTY.path ? '?? new.txt\n' : '') })
  await cleanupSweep(w, $, MAIN)
  expect(removes(w, DIRTY)).toEqual([])
  expect(removes(w, LOCKED)).toEqual([])
})

test('a failing git status counts as dirty and the worktree is kept', async ($, on) => {
  const w = cleanupWorld(on, { files: finished(MEMBER), merged: b => b === MEMBER.branch, answer: (a, c) => (a.includes(' status') && c === MEMBER.path ? { exitCode: 128 } : undefined) })
  await cleanupSweep(w, $, MAIN)
  expect(removes(w, MEMBER)).toEqual([])
})


// ---------------- second red team: the create window, and an unreadable slots.json ----------------
const ADD_ARGS = ' worktree ad' + 'd'
const activeNow = (w: CleanupWorld, a: AgentFixture) =>
  Object.keys((JSON.parse(w.files.get(slashed(SLOTS_PATH)) as string) as { active: object }).active).filter(k => k.endsWith('/agent-' + a.id))

test('an active entry stays through a full sweep run in the create window, before the folder exists', async ($, on) => {
  let added = false
  let swept = false
  let afterSweep: string[] = []
  const w: CleanupWorld = cleanupWorld(on, {
    files: { [metaFile(NEW)]: META_RUNNING(NEW.id) },
    gone: [NEW.path],
    merged: b => b === NEW.branch,
    porcelainFn: () => (added ? PORC_NEW : undefined),
    hook: async args => {
      if (!swept && args.includes('--verify --quiet refs/heads/worktree-agent-b1new')) {
        swept = true
        await cleanupSweep(w, $, MAIN)
        afterSweep = activeNow(w, NEW)
        return { exitCode: 1 }
      }
      if (args.includes(ADD_ARGS)) {
        added = true
        w.gone.delete(NEW.path)
        return {}
      }
      return undefined
    },
  })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  expect(swept).toBe(true)
  expect(afterSweep).toHaveLength(1)
  expect(activeNow(w, NEW)).toHaveLength(1)
  await cleanupSweep(w, $, MAIN)
  expect(activeNow(w, NEW)).toHaveLength(1)
  expect(removes(w, NEW)).toEqual([])
  expect(branchDeletes(w, NEW)).toEqual([])
})

const goneEntry = (ageMs: number) => {
  const G: AgentFixture = { id: 'c1gone', path: MAIN + WTD + 'agent-c1gone', branch: 'worktree-agent-c1gone' }
  const st = JSON.parse(SLOTS_JSON) as { active: Record<string, unknown> }
  st.active[G.path.toLowerCase()] = { path: G.path, at: NOW - ageMs }
  return { G, slots: JSON.stringify(st) }
}

test('an active entry whose folder is missing and not in the worktree list is retired when 11 minutes old', async ($, on) => {
  const { G, slots } = goneEntry(11 * 60_000)
  const w = cleanupWorld(on, { files: { [SLOTS_PATH]: slots }, gone: [G.path] })
  await cleanupSweep(w, $, MAIN)
  expect(activeNow(w, G)).toEqual([])
})

test('an active entry whose folder is missing and not in the worktree list is kept when 9 minutes old', async ($, on) => {
  const { G, slots } = goneEntry(9 * 60_000)
  const w = cleanupWorld(on, { files: { [SLOTS_PATH]: slots }, gone: [G.path] })
  await cleanupSweep(w, $, MAIN)
  expect(activeNow(w, G)).toHaveLength(1)
})

test('an unreadable slots.json is never written by a sweep, a create or the sweep after it', async ($, on) => {
  const trunc = SLOTS_JSON.slice(0, SLOTS_JSON.indexOf('a4other'))
  const w = cleanupWorld(on, { files: { [SLOTS_PATH]: trunc }, gone: [NEW.path], merged: b => b === LIVE_OTHER.branch })
  await cleanupSweep(w, $, MAIN)
  const created = await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  await cleanupSweep(w, $, MAIN)
  expect(slotsWrites(w)).toEqual([])
  expect(w.files.get(slashed(SLOTS_PATH))).toBe(trunc)
  expect(removes(w, LIVE_OTHER)).toEqual([])
  expect(w.ran.filter(r => r.includes('worktree remove'))).toEqual([])
  expect(created).toBeDefined()
  expect(w.ran.some(r => r.includes(ADD_ARGS))).toBe(true)
  expect(w.logs.some(l => l.startsWith('worktrees: slots.json unreadable'))).toBe(true)
})

test('a mixed-case name created from the foundry dir survives a sweep', async ($, on) => {
  const MIX: AgentFixture = { id: 'b1new', path: MAIN + WTD + 'Agent-B1New', branch: 'worktree-Agent-B1New' }
  const w = cleanupWorld(on, { porcelain: WORKTREE_LIST_PORCELAIN + '\n' + wtOf(MIX), merged: b => b === MIX.branch })
  await $.classic.WorktreeCreate({ name: 'Agent-B1New', cwd: FOUNDRY_CWD } as never)
  await cleanupSweep(w, $, MAIN)
  expect(removes(w, MIX)).toEqual([])
})

test('a non-agent name created from the foundry dir is never swept', async ($, on) => {
  const FEAT: AgentFixture = { id: 'x', path: MAIN + WTD + 'feature-x', branch: 'worktree-feature-x' }
  const w = cleanupWorld(on, { porcelain: WORKTREE_LIST_PORCELAIN + '\n' + wtOf(FEAT), merged: () => true })
  await $.classic.WorktreeCreate({ name: 'feature-x', cwd: FOUNDRY_CWD } as never)
  await cleanupSweep(w, $, MAIN)
  expect(removes(w, FEAT)).toEqual([])
})

test('a failed worktree add drops only its own active entry and claims no slot', async ($, on) => {
  const w = cleanupWorld(on, { gone: [NEW.path], answer: a => (a.includes(ADD_ARGS) ? { exitCode: 128 } : undefined) })
  const before = Object.keys((JSON.parse(SLOTS_JSON) as { active: object }).active)
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  const st = JSON.parse(w.files.get(slashed(SLOTS_PATH)) as string) as { active: object; slots: object }
  expect(Object.keys(st.active)).toEqual(before)
  expect(st.slots).toEqual({})
})

test('two creates claim slots 1 and 2 and keep both active entries', async ($, on) => {
  const w = cleanupWorld(on, { files: { 'C:/r/.claude/worktree-setup.ps1': 'x' } })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  await $.classic.WorktreeCreate({ name: 'agent-b2new', cwd: MAIN } as never)
  const st = JSON.parse(w.files.get(slashed(SLOTS_PATH)) as string) as { slots: object; active: object }
  expect(Object.keys(st.slots)).toEqual(['1', '2'])
  expect(Object.keys(st.active).filter(k => /agent-b[12]new$/.test(k))).toHaveLength(2)
})

// ---------------- third red team: /tidy with an unreadable slots.json, and telling the user once ----------------
const TIP = '4bada1f0123456789abcdef0123456789abcdef0'
// git's answers for /tidy: the new agent branch sits on the default branch, so it counts as merged
const tidyGit = (args: string): CleanupAnswer | undefined => {
  if (args.includes('symbolic-ref')) return { stdout: 'origin/main\n' }
  if (args.includes('--show-current')) return { stdout: 'main\n' }
  if (args.includes('for-each-ref') && args.includes('refs/heads')) return { stdout: `main ${TIP}\n${NEW.branch} ${TIP}\n` }
  if (args.includes('for-each-ref') && args.includes('refs/remotes')) return { stdout: `origin/main ${TIP}\n` }
  if (args.includes('branch --merged')) return { stdout: `main\n${NEW.branch}\n` }
  return undefined
}
const tidyRun = async ($: CleanupDollar) => ((await $.command.run({ command: 'tidy', args: '' } as never)) as unknown as { text: string }).text

test('tidy removes nothing and says slots.json is unreadable while slots.json is unreadable', async ($, on) => {
  const trunc = SLOTS_JSON.slice(0, SLOTS_JSON.indexOf('a4other'))
  const w = cleanupWorld(on, { files: { [SLOTS_PATH]: trunc, [metaFile(NEW)]: META_RUNNING(NEW.id) }, gone: [NEW.path], porcelain: PORC_NEW, merged: () => true, answer: tidyGit })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  const text = await tidyRun($)
  expect(w.ran.filter(r => r.includes('worktree remove'))).toEqual([])
  expect(w.ran.filter(r => /branch -[dD] /.test(r))).toEqual([])
  expect(text).toContain('slots.json unreadable')
  expect(w.files.get(slashed(SLOTS_PATH))).toBe(trunc)
})

test('tidy removes nothing for an agent that has not stopped when slots.json is readable', async ($, on) => {
  const w = cleanupWorld(on, { files: { [metaFile(NEW)]: META_RUNNING(NEW.id) }, gone: [NEW.path], porcelain: PORC_NEW, merged: () => true, answer: tidyGit })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  await tidyRun($)
  expect(w.ran.filter(r => r.includes('worktree remove'))).toEqual([])
  expect(w.ran.filter(r => /branch -[dD] /.test(r))).toEqual([])
})

test('an unreadable slots.json is reported to the user with one toast per session', async ($, on) => {
  const trunc = SLOTS_JSON.slice(0, SLOTS_JSON.indexOf('a4other'))
  const w = cleanupWorld(on, { files: { [SLOTS_PATH]: trunc }, gone: [NEW.path], merged: b => b === LIVE_OTHER.branch })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  await cleanupSweep(w, $, MAIN)
  await $.classic.WorktreeCreate({ name: 'agent-b2new', cwd: MAIN } as never)
  await cleanupSweep(w, $, MAIN)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('slots.json')
})

// ---------------- fourth red team: one read of slots.json per decision, and an unreadable read removes nothing ----------------
const liveTidyWorld = (on: On, hook?: CleanupOpts['hook']) =>
  cleanupWorld(on, { files: { [metaFile(NEW)]: META_RUNNING(NEW.id) }, gone: [NEW.path], porcelain: PORC_NEW, merged: () => true, answer: tidyGit, hook })
// the sweep's world: only the new live agent's branch is merged, so nothing else is removable
const liveSweepWorld = (on: On, hook?: CleanupOpts['hook']) =>
  cleanupWorld(on, { files: { [metaFile(NEW)]: META_RUNNING(NEW.id) }, gone: [NEW.path], porcelain: PORC_NEW, merged: b => b === NEW.branch, hook })
const removedAnything = (w: CleanupWorld) => [...w.ran.filter(r => r.includes('worktree remove')), ...w.ran.filter(r => /branch -[dD] /.test(r))]

test('tidy removes nothing for a live agent when slots.json stays readable during the fetch', async ($, on) => {
  const w = liveTidyWorld(on)
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  await tidyRun($)
  expect(removedAnything(w)).toEqual([])
})

test('tidy removes nothing when slots.json becomes unreadable during git fetch', async ($, on) => {
  let armed = false
  const w = liveTidyWorld(on, args => {
    if (armed && args.includes('fetch --prune origin')) w.files.set(slashed(SLOTS_PATH), '')
    return undefined
  })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  armed = true
  await tidyRun($)
  expect(removedAnything(w)).toEqual([])
})

test('the merge sweep removes nothing for a live agent when slots.json stays readable during the worktree list', async ($, on) => {
  const w = liveSweepWorld(on)
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  await cleanupSweep(w, $, MAIN)
  expect(removedAnything(w)).toEqual([])
})

test('the merge sweep removes nothing when slots.json becomes unreadable during git worktree list', async ($, on) => {
  let armed = false
  const w = liveSweepWorld(on, args => {
    if (armed && args === 'git worktree list --porcelain') w.files.set(slashed(SLOTS_PATH), '')
    return undefined
  })
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  armed = true
  await cleanupSweep(w, $, MAIN)
  expect(removedAnything(w)).toEqual([])
})

for (const [label, active] of [['null', null], ['an array', []]] as const) {
  test(`tidy removes nothing and says slots.json is unreadable when active is ${label}`, async ($, on) => {
    const w = liveTidyWorld(on)
    await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
    const st = JSON.parse(w.files.get(slashed(SLOTS_PATH)) as string) as { slots: object }
    w.files.set(slashed(SLOTS_PATH), JSON.stringify({ slots: st.slots, active }))
    const text = await tidyRun($)
    expect(removedAnything(w)).toEqual([])
    expect(text).toContain('slots.json unreadable')
    expect(w.toasts).toHaveLength(1)
  })
}

test('removing an agent worktree with a truncated slots.json tells the user once and leaves the file alone', async ($, on) => {
  const w = liveTidyWorld(on)
  on('classic.WorktreeRemove', async () => ({}))
  await $.classic.WorktreeCreate({ name: 'agent-b1new', cwd: MAIN } as never)
  const trunc = SLOTS_JSON.slice(0, SLOTS_JSON.indexOf('a4other'))
  w.files.set(slashed(SLOTS_PATH), trunc)
  const before = w.toasts.length
  await $.classic.WorktreeRemove({ worktree_path: NEW.path, cwd: MAIN } as never)
  expect(w.toasts.length - before).toBe(1)
  expect(w.toasts[w.toasts.length - 1]).toContain('slots.json')
  expect(w.files.get(slashed(SLOTS_PATH))).toBe(trunc)
})
