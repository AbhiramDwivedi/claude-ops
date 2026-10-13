import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// the engine beneath the plugin: git says the session is in a repo, and the Agent call records what reached it
function world(on: On, inRepo = true) {
  const seen: Record<string, unknown>[] = []
  on('process.run', async (_, e) => ({
    value: { exitCode: inRepo ? 0 : 128, stdout: inRepo && e.argv.includes('--is-inside-work-tree') ? 'true\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
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
