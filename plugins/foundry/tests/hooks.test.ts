import type { AgentInfo, On, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { LEAD_TYPE, MODEL_REFUSAL, ROLL_BYTES } from '../hooks/register'

const agent = (id: string, type: string, name?: string, parentId?: string): AgentInfo => ({ id, type, name, parentId, status: 'running', description: id })

const NOW = Date.UTC(2026, 9, 17, 12)
const ROOT = 'C:/r/.git/foundry/s1'

// the engine hands a path on in the platform's own spelling
const slashed = (path: string) => path.replace(/\\/g, '/')

type World = {
  // the session's agents, as $.agent.list() answers them; a test may change it
  agents: AgentInfo[]
  files: Map<string, string>
  // each file's modification time; unset means now
  mtimes: Map<string, number>
  // what the plugin wrote to the debug log
  logs: string[]
  // the tool calls that reached the tool, past the plugin
  ran: Record<string, unknown>[]
  // a SendMessage from `from`: the result the model gets
  send: (from: string | undefined, to: unknown, message?: string) => Promise<ToolCallResult>
  agentCall: (from: string | undefined, input: Record<string, unknown>) => Promise<ToolCallResult>
}

// the engine beneath the plugin: a session `s1` in C:/r, git that knows the repo (or not), files in memory
function world($: Engine, on: On, options: { inRepo?: boolean; listFails?: boolean; writeFails?: boolean } = {}): World {
  mock.clock(on, { now: NOW })
  const w: World = {
    agents: [
      agent('L1', LEAD_TYPE, 'auth'),
      agent('L2', LEAD_TYPE, 'billing'),
      agent('A1', 'kit:builder', 'auth-builder', 'L1'),
      agent('A2', 'Explore', 'auth-scout', 'A1'),
      agent('B1', 'general-purpose', 'billing-builder', 'L2'),
      agent('X', 'general-purpose', 'helper'),
    ],
    files: new Map(),
    mtimes: new Map(),
    logs: [],
    ran: [],
    send: (from, to, message = 'm') => $.tool.call({ tool: 'SendMessage', to, message, summary: 'merge order', agentId: from } as never),
    agentCall: (from, input) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', agentId: from, ...input } as never),
  }
  on('agent.list', async () => {
    if (options.listFails) throw new Error('agent list is down')
    return { value: w.agents }
  })
  on('ui.log', async (_, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: options.inRepo === false ? 'C:/tmp/x' : 'C:/r' }))
  on('env.get', async (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('process.run', async () => ({
    value: { exitCode: options.inRepo === false ? 128 : 0, stdout: options.inRepo === false ? '' : 'C:/r/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('fs.exists', async (_, e) => {
    const p = slashed(e.path)
    return { value: w.files.has(p) || [...w.files.keys()].some(f => f.startsWith(`${p}/`)) }
  })
  on('fs.read', async (_, e) => ({ value: w.files.get(slashed(e.path)) ?? '' }))
  on('fs.write', async (_, e) => {
    if (options.writeFails) throw new Error('disk full')
    w.files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', async (_, e) => {
    const dir = `${slashed(e.path ?? '')}/`
    const names = [...w.files.keys()].filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/')).map(f => f.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_, e) => {
    const p = slashed(e.path)
    return { value: { kind: 'file' as const, size: w.files.get(p)?.length ?? 0, mtimeMs: w.mtimes.get(p) ?? NOW, isLink: false } }
  })
  on('tool.call', async (_, e) => {
    w.ran.push(e as unknown as Record<string, unknown>)
    return { result: e.tool === 'Agent' ? { agentId: 'new1' } : 'ok' } as never
  })
  return w
}

const stop = (id: string, text: string) =>
  ({ hook_event_name: 'SubagentStop', session_id: 's1', cwd: 'C:/r/.claude/worktrees/x', agent_id: id, agent_type: 'x', agent_transcript_path: '', stop_hook_active: false, last_assistant_message: text, transcript_path: '' }) as never

const handBack = ($: Engine, id: string, message: string) => $.tool.call({ tool: 'SubagentHandback', message, agentId: id } as never)

const status = async ($: Engine) => ((await $.command.run({ command: 'foundry', args: '' } as never)) as { text?: string }).text ?? ''

test('captures a crew member\'s last message in the repo\'s git common dir', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await $.classic.SubagentStop(stop('A2', 'Summary: done'))
  expect(w.logs).toEqual([])
  expect(w.files.get(`${ROOT}/reports/auth/auth-scout.md`)).toBe('Summary: done')
})

test('captures to the home folder outside git', async ($, on) => {
  const w = world($, on, { inRepo: false })
  on('classic.SubagentStop', async () => ({}))
  await $.classic.SubagentStop(stop('L2', 'CHECKPOINT: half'))
  expect(w.files.get('C:/Users/me/.claude/foundry/s1/reports/billing/billing.md')).toBe('CHECKPOINT: half')
})

test('captures nothing for an agent outside every crew', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await $.classic.SubagentStop(stop('X', 'hi'))
  expect(w.files.size).toBe(0)
})

test('keeps a hand-back report over the sign-off that follows, then captures the next stop again', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await handBack($, 'A1', 'Summary: full report')
  await $.classic.SubagentStop(stop('A1', 'Done.'))
  const path = `${ROOT}/reports/auth/auth-builder.md`
  expect(w.files.get(path)).toBe('Summary: full report')
  // resumed and stopped again, with no hand-back this time
  await $.classic.SubagentStop(stop('A1', 'Summary: second run'))
  expect(w.files.get(path)).toBe('Summary: second run')
})

test('a stop racing the hand-back never overwrites it', async ($, on) => {
  const w = world($, on)
  on('classic.SubagentStop', async () => ({}))
  await Promise.all([handBack($, 'A1', 'Summary: full report'), $.classic.SubagentStop(stop('A1', 'Done.'))])
  expect(w.files.get(`${ROOT}/reports/auth/auth-builder.md`)).toBe('Summary: full report')
})

test('names the report file from the spawn name, in the note and on disk alike', async ($, on) => {
  const w = world($, on)
  on('agent.spawn', async () => ({ agentId: 'M9', model: 'claude-sonnet-4-6' }))
  on('classic.SubagentStop', async () => ({}))
  await $.agent.spawn({ subagentType: 'kit:test-writer', prompt: 'p', description: 'd', name: 'auth-tester', parentAgentId: 'L1' } as never)
  // the engine took the name, so it lists the agent under another
  w.agents.push(agent('M9', 'kit:test-writer', 'auth-tester-2', 'L1'))
  await $.classic.SubagentStop(stop('M9', 'Summary: tests'))
  expect(w.files.get(`${ROOT}/reports/auth/auth-tester.md`)).toBe('Summary: tests')
})

test('passes allowed messages through and refuses the rest from crew agents', async ($, on) => {
  const w = world($, on)
  expect((await w.send('L1', 'main')).deny).toBeUndefined()
  expect((await w.send('A2', 'auth')).deny).toBeUndefined()
  expect((await w.send('L1', 'billing')).deny).toBeUndefined()
  expect((await w.send('A1', 'main')).deny).toContain('your lead, auth')
  expect((await w.send('A1', 'billing')).deny).toContain('tell your lead, auth')
  expect((await w.send('L1', 'billing-builder')).deny).toContain("that crew's lead, billing")
  expect((await w.send('L1', 'auth-ghost')).deny).toBeDefined()
  // not foundry's business
  expect((await w.send(undefined, 'billing-builder')).deny).toBeUndefined()
  expect((await w.send('X', 'auth-builder')).deny).toBeUndefined()
  expect(w.ran.length).toBe(5)
})

test('reaches a restarted lead, not the ended one of the same name', async ($, on) => {
  const w = world($, on)
  // auth-worker of the first auth lead ends; billing's live worker shares the name
  w.agents.push(agent('W1', 'x', 'worker', 'L1'), agent('W2', 'x', 'worker', 'L2'))
  expect((await w.send('A1', 'worker')).deny).toContain('more than one live agent')
  w.agents = w.agents.filter(a => a.id !== 'W1')
  expect((await w.send('A1', 'worker')).deny).toBeDefined()
  expect((await w.send('B1', 'worker')).deny).toBeUndefined()
})

test('logs only lead-to-lead messages', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'billing')
  await w.send('L2', 'auth')
  await w.send('A1', 'auth')
  const lines = (w.files.get(`${ROOT}/messages.jsonl`) ?? '').trim().split('\n').map(l => JSON.parse(l))
  expect(lines).toEqual([
    { ts: '2026-10-17T12:00:00.000Z', from: 'auth', to: 'billing', summary: 'merge order' },
    { ts: '2026-10-17T12:00:00.000Z', from: 'billing', to: 'auth', summary: 'merge order' },
  ])
})

test('rolls the message log once it passes the limit', async ($, on) => {
  const w = world($, on)
  const big = `${'x'.repeat(ROLL_BYTES)}\n`
  w.files.set(`${ROOT}/messages.jsonl`, big)
  w.files.set(`${ROOT}/messages.1.jsonl`, 'older')
  await w.send('L1', 'billing')
  expect(w.files.get(`${ROOT}/messages.2.jsonl`)).toBe(big)
  expect(w.files.get(`${ROOT}/messages.1.jsonl`)).toBe('older')
  expect(JSON.parse(w.files.get(`${ROOT}/messages.jsonl`) ?? '').from).toBe('auth')
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
  expect(member.context).toEqual([`[foundry] If auth-tester's report does not reach you, read ${ROOT}/reports/auth/auth-tester.md once it stops.`])
  const lead = await w.agentCall(undefined, { subagent_type: LEAD_TYPE, name: 'search', model: 'opus' })
  expect(lead.context?.[0]).toContain(`${ROOT}/reports/search/search.md`)
  expect((await w.agentCall(undefined, { subagent_type: 'Explore' })).context).toBeUndefined()
})

test('/foundry shows each crew, its live members by model and its last report', async ($, on) => {
  const w = world($, on)
  on('agent.spawn', async () => ({ agentId: 'M9', model: 'claude-sonnet-4-6' }))
  on('classic.SubagentStop', async () => ({}))
  await $.agent.spawn({ subagentType: 'kit:builder', prompt: 'p', description: 'd', name: 'billing-api', parentAgentId: 'L2' } as never)
  w.agents.push(agent('M9', 'kit:builder', 'billing-api', 'L2'))
  await $.classic.SubagentStop(stop('A1', 'Summary: done'))
  w.mtimes.set(`${ROOT}/reports/auth/auth-builder.md`, NOW - 5 * 60_000)
  const text = await status($)
  expect(text).toContain('Crews (2):')
  expect(text).toContain('- auth: running, 2 live members (unknown 2), last report 5m ago')
  expect(text).toContain(`  reports: ${ROOT}/reports/auth`)
  expect(text).toContain('- billing: running, 2 live members (sonnet 1, unknown 1), no report yet')
})

test('/foundry shows a lead waiting on the person until the foreman answers', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'main', 'QUESTION: Keep the v1 endpoint?\nOptions: keep or drop.')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), waiting on you: Keep the v1 endpoint?')
  await w.send(undefined, 'auth', 'Keep it.')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), no report yet')
})

test('fails open when the agent list throws', async ($, on) => {
  const w = world($, on, { listFails: true })
  on('classic.SubagentStop', async () => ({}))
  expect((await w.send('A1', 'billing')).deny).toBeUndefined()
  expect((await w.agentCall('A1', {})).deny).toBeUndefined()
  expect(await $.classic.SubagentStop(stop('A1', 'x'))).toEqual({})
  expect(w.ran.length).toBe(2)
})

test('fails open when writing a report throws', async ($, on) => {
  const w = world($, on, { writeFails: true })
  on('classic.SubagentStop', async () => ({}))
  expect(await $.classic.SubagentStop(stop('A1', 'x'))).toEqual({})
  expect(w.logs.some(l => l.startsWith('foundry: report capture failed'))).toBe(true)
})
