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
