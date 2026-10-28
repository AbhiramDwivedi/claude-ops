import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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

test('sweeps nothing on a command without merge, another tool, or before the session made a worktree', async ($, on) => {
  const { ran, clock } = sessionRepo(on)
  await $.classic.PostToolUse(bash('git merge --ff-only worktree-agent-zz'))
  await clock.settle()
  expect(ran).toEqual([])
  await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r' })
  ran.length = 0
  await $.classic.PostToolUse(bash('git status'))
  await $.classic.PostToolUse(bash('git merge worktree-agent-x1', 'Read'))
  await clock.settle()
  expect(ran).toEqual([])
})

test("removes the session's own merged agent worktree and branch after a merge, and leaves another session's alone", async ($, on) => {
  const { ran, toasts, files, clock } = sessionRepo(on)
  await $.classic.WorktreeCreate({ name: 'agent-x1', cwd: 'C:/r' })
  // a merge while the agent still runs removes nothing
  await $.classic.PostToolUse(bash('git merge --ff-only worktree-agent-x1'))
  await clock.settle()
  expect(ran.some(r => r.includes('worktree remove'))).toBe(false)
  // its agent stopped: SubagentStop's cleanup marked it done
  files.set(STATE, JSON.stringify({ slots: {}, active: {} }))
  ran.length = 0
  await $.classic.PostToolUse(bash('gh pr merge 12 --squash', 'PowerShell'))
  await clock.settle()
  expect(ran).toContain(`git -c core.longpaths=true worktree remove ${X1}`)
  expect(ran).toContain('git branch -d worktree-agent-x1')
  expect(ran.some(r => r.includes('agent-zz') && !r.startsWith('git worktree list'))).toBe(false)
  expect(ran.some(r => r.includes('--force') || r.includes('branch -D') || r.includes('push'))).toBe(false)
  expect(toasts).toEqual(['worktrees: removed merged worktree-agent-x1'])
  // removed once: a later merge finds nothing tracked
  ran.length = 0
  await $.classic.PostToolUse(bash('git merge other'))
  await clock.settle()
  expect(ran).toEqual([])
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
