import type { AgentInfo, On, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { LEAD_TYPE, MODEL_REFUSAL } from '../hooks/register'

const agent = (id: string, type: string, name?: string, parentId?: string): AgentInfo => ({ id, type, name, parentId, status: 'running', description: id })

const AGENTS: AgentInfo[] = [
  agent('L1', LEAD_TYPE, 'auth'),
  agent('L2', LEAD_TYPE, 'billing'),
  agent('A1', 'kit:builder', 'auth-builder', 'L1'),
  agent('A2', 'Explore', 'auth-scout', 'A1'),
  agent('B1', 'general-purpose', 'billing-builder', 'L2'),
  agent('X', 'general-purpose', 'helper'),
]

// the engine hands a path on in the platform's own spelling
const slashed = (path: string) => path.replace(/\\/g, '/')

type World = {
  files: Map<string, string>
  // what the plugin wrote to the debug log
  logs: string[]
  // the tool calls that reached the tool, past the plugin
  ran: Record<string, unknown>[]
  // a SendMessage from `from`: the result the model gets
  send: (from: string | undefined, to: unknown) => Promise<ToolCallResult>
  agentCall: (from: string | undefined, input: Record<string, unknown>) => Promise<ToolCallResult>
}

// the engine beneath the plugin: a session `s1` in C:/r, git that knows the repo (or not), files in memory
function world($: Engine, on: On, options: { inRepo?: boolean; listFails?: boolean; writeFails?: boolean } = {}): World {
  mock.clock(on, { now: Date.UTC(2026, 9, 17, 12) })
  const files = new Map<string, string>()
  const ran: Record<string, unknown>[] = []
  const logs: string[] = []
  on('agent.list', async () => {
    if (options.listFails) throw new Error('agent list is down')
    return { value: AGENTS }
  })
  on('ui.log', async (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: 'C:/r' }))
  on('env.get', async (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('process.run', async () => ({
    value: { exitCode: options.inRepo === false ? 128 : 0, stdout: options.inRepo === false ? '' : 'C:/r/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', async (_, e) => ({ value: files.has(slashed(e.path)) }))
  on('fs.read', async (_, e) => ({ value: files.get(slashed(e.path)) ?? '' }))
  on('fs.write', async (_, e) => {
    if (options.writeFails) throw new Error('disk full')
    files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('tool.call', async (_, e) => {
    ran.push(e as unknown as Record<string, unknown>)
    return { result: e.tool === 'Agent' ? { agentId: 'new1' } : 'ok' } as never
  })
  return {
    files,
    ran,
    logs,
    send: (from, to) => $.tool.call({ tool: 'SendMessage', to, message: 'm', summary: 'merge order', agentId: from } as never),
    agentCall: (from, input) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', agentId: from, ...input } as never),
  }
}

const stop = (id: string, cwd: string, text: string) =>
  ({ hook_event_name: 'SubagentStop', session_id: 's1', cwd, agent_id: id, agent_type: 'x', agent_transcript_path: '', stop_hook_active: false, last_assistant_message: text, transcript_path: '' }) as never

test('captures a crew member\'s last message in the repo\'s git common dir', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await $.classic.SubagentStop(stop('A2', 'C:/r/.claude/worktrees/agent-A2', 'Summary: done'))
  expect(w.logs).toEqual([])
  expect(w.files.get('C:/r/.git/foundry/s1/reports/auth/auth-scout.md')).toBe('Summary: done')
})

test('captures to the home folder outside git', async ($, on) => {
  const w = world($, on, { inRepo: false })
  on('classic.SubagentStop', async () => ({}))
  await $.classic.SubagentStop(stop('L2', 'C:/tmp/x', 'CHECKPOINT: half'))
  expect(w.files.get('C:/Users/me/.claude/foundry/s1/reports/billing/billing.md')).toBe('CHECKPOINT: half')
})

test('captures nothing for an agent outside every crew', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await $.classic.SubagentStop(stop('X', 'C:/r', 'hi'))
  expect(w.files.size).toBe(0)
})

test('keeps a hand-back report over the sign-off message that follows it', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await $.tool.call({ tool: 'SubagentHandback', message: 'Summary: full report', agentId: 'A1' } as never)
  await $.classic.SubagentStop(stop('A1', 'C:/r', 'Done.'))
  expect(w.files.get('C:/r/.git/foundry/s1/reports/auth/auth-builder.md')).toBe('Summary: full report')
})

test('passes allowed messages through and refuses cross-crew ones from members', async ($, on) => {
  const w = world($, on)
  expect((await w.send('A1', 'main')).deny).toBeUndefined()
  expect((await w.send('A2', 'auth')).deny).toBeUndefined()
  expect((await w.send('L1', 'billing')).deny).toBeUndefined()
  expect((await w.send('A1', 'billing')).deny).toContain('tell your lead, auth')
  expect((await w.send('L1', 'billing-builder')).deny).toContain("that crew's lead, billing")
  // not foundry's business
  expect((await w.send(undefined, 'billing-builder')).deny).toBeUndefined()
  expect((await w.send('X', 'auth-builder')).deny).toBeUndefined()
  expect(w.ran.length).toBe(5)
})

test('logs only lead-to-lead messages', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'billing')
  await w.send('L2', 'auth')
  await w.send('A1', 'auth')
  const lines = (w.files.get('C:/r/.git/foundry/s1/messages.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(lines).toEqual([
    { ts: '2026-10-17T12:00:00.000Z', from: 'auth', to: 'billing', summary: 'merge order' },
    { ts: '2026-10-17T12:00:00.000Z', from: 'billing', to: 'auth', summary: 'merge order' },
  ])
})

test('refuses an Agent call without a model only from inside a crew', async ($, on) => {
  const w = world($, on)
  expect(await w.agentCall('A1', { subagent_type: 'Explore' })).toEqual({ deny: MODEL_REFUSAL })
  expect((await w.agentCall('L1', { model: 'sonnet', name: 'auth-tester' })).deny).toBeUndefined()
  expect((await w.agentCall('X', {})).deny).toBeUndefined()
  expect((await w.agentCall(undefined, {})).deny).toBeUndefined()
  expect(w.ran.length).toBe(3)
})

test('tells a lead, and the main thread starting one, where a report will land', async ($, on) => {
  const w = world($, on)
  const member = await w.agentCall('L1', { model: 'sonnet', name: 'auth-tester' })
  expect(member.context).toEqual(['[foundry] If auth-tester\'s report does not reach you, read C:/r/.git/foundry/s1/reports/auth/auth-tester.md once it stops.'])
  const lead = await w.agentCall(undefined, { subagent_type: LEAD_TYPE, name: 'search', model: 'opus' })
  expect(lead.context?.[0]).toContain('C:/r/.git/foundry/s1/reports/search/search.md')
  expect((await w.agentCall(undefined, { subagent_type: 'Explore' })).context).toBeUndefined()
})

test('fails open when the agent list throws', async ($, on) => {
  const w = world($, on, { listFails: true })
  on('classic.SubagentStop', async () => ({}))
  expect((await w.send('A1', 'billing')).deny).toBeUndefined()
  expect((await w.agentCall('A1', {})).deny).toBeUndefined()
  expect(await $.classic.SubagentStop(stop('A1', 'C:/r', 'x'))).toEqual({})
  expect(w.ran.length).toBe(2)
})

test('fails open when writing a report throws', async ($, on) => {
  const w = world($, on, { writeFails: true })
  on('classic.SubagentStop', async () => ({}))
  expect(await $.classic.SubagentStop(stop('A1', 'C:/r', 'x'))).toEqual({})
  expect(w.logs.some(l => l.startsWith('foundry: report capture failed'))).toBe(true)
})
