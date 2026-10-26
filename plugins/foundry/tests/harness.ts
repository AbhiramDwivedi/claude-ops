import type { AgentInfo, On, ToolCallResult } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

import { LEAD_TYPE } from '../hooks/register'

export const agent = (id: string, type: string, name?: string, parentId?: string): AgentInfo => ({ id, type, name, parentId, status: 'running', description: id })

export const NOW = Date.UTC(2026, 9, 17, 12)
export const ROOT = 'C:/r/.git/foundry/s1'
export const slashed = (path: string) => path.replace(/\\/g, '/')

export type Options = {
  inRepo?: boolean
  listFails?: boolean
  writeFails?: boolean
  stateFails?: boolean
  submitFails?: boolean
  dirFails?: boolean
  // what the settings hooks beneath add to a SessionStart
  startContext?: string[]
}

export type World = {
  agents: AgentInfo[]
  files: Map<string, string>
  mtimes: Map<string, number>
  logs: string[]
  ran: Record<string, unknown>[]
  clock: MockClock
  // every $.prompt.submit text, in order
  prompts: string[]
  toasts: string[]
  // $.state as the test stores it: "plugin/key" -> value
  stateValues: Map<string, unknown>
  // what $.session.usage() answers as rate limits
  usageLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  send: (from: string | undefined, to: unknown, message?: string) => Promise<ToolCallResult>
  agentCall: (from: string | undefined, input: Record<string, unknown>) => Promise<ToolCallResult>
  // a tool call by an agent, the activity a heartbeat watches
  activity: (from: string, tool?: string) => Promise<unknown>
  // one model request of an agent's loop, drained
  step: (from: string | undefined) => Promise<void>
}

// the engine beneath the plugin, as hooks.test.ts builds it, plus clock, $.state, $.prompt.submit, $.ui.toast and usage
export function world($: Engine, on: On, options: Options = {}): World {
  const clock = mock.clock(on, { now: NOW })
  const w: World = {
    agents: [
      agent('L1', LEAD_TYPE, 'auth'),
      agent('L2', LEAD_TYPE, 'billing'),
      agent('A1', 'kit:builder', 'auth-builder', 'L1'),
      agent('A2', 'Explore', 'auth-scout', 'A1'),
      agent('B1', 'general-purpose', 'billing-builder', 'L2'),
      agent('X', 'general-purpose', 'helper'),
      agent('C1', 'foundry:cynic', 'cynic-1'),
    ],
    files: new Map(),
    mtimes: new Map(),
    logs: [],
    ran: [],
    clock,
    prompts: [],
    toasts: [],
    stateValues: new Map(),
    usageLimits: [],
    send: (from, to, message = 'm') => $.tool.call({ tool: 'SendMessage', to, message, summary: 'merge order', agentId: from } as never),
    agentCall: (from, input) => $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', agentId: from, ...input } as never),
    activity: (from, tool = 'Read') => $.tool.call({ tool, file_path: 'x', agentId: from } as never),
    step: async from => {
      const stream = ($ as never as { turn: { step: (e: unknown) => AsyncGenerator<unknown> } }).turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId: from })
      for await (const _ of stream) void _
    },
  }
  on('agent.list', async () => {
    if (options.listFails) throw new Error('agent list is down')
    return { value: w.agents }
  })
  on('ui.log', async (_, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('prompt.submit', async (_, e) => {
    if (options.submitFails) throw new Error('submit is down')
    w.prompts.push(e.text)
    return { text: e.text } as never
  })
  const key = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}${e.id === undefined ? '' : `/${e.id}`}`
  on('state.get', async (_, e) => {
    if (options.stateFails) throw new Error('state is down')
    const k = key(e as never)
    return { value: { value: w.stateValues.get(k), version: w.stateValues.has(k) ? 1 : 0 } } as never
  })
  on('state.set', async (_, e) => {
    if (options.stateFails) throw new Error('state is down')
    w.stateValues.set(key(e as never), (e as { value: unknown }).value)
    return { value: { isSet: true, version: 1 } } as never
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, context: {}, rateLimits: w.usageLimits } }) as never)
  on('session.id', async () => ({ value: 's1' }))
  on('session.cwd', async () => ({ value: options.inRepo === false ? 'C:/tmp/x' : 'C:/r' }))
  on('env.get', async (_, e) => ({ value: e.name === 'USERPROFILE' && !options.dirFails ? 'C:\\Users\\me' : undefined }))
  on('process.run', async () => {
    if (options.dirFails) throw new Error('git is gone')
    return {
      value: { exitCode: options.inRepo === false ? 128 : 0, stdout: options.inRepo === false ? '' : 'C:/r/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
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
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: w.mtimes.get(`${dir}${name}`) ?? NOW, isLink: false })) }
  })
  on('fs.stat', async (_, e) => {
    const p = slashed(e.path)
    return { value: { kind: 'file' as const, size: w.files.get(p)?.length ?? 0, mtimeMs: w.mtimes.get(p) ?? NOW, isLink: false } }
  })
  on('tool.call', async (_, e) => {
    w.ran.push(e as unknown as Record<string, unknown>)
    return { result: e.tool === 'Agent' ? { agentId: 'new1' } : 'ok' } as never
  })
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.measure', async (_, e) => ({ changed: e.changed }) as never)
  on('classic.SubagentStop', async () => ({}))
  on('classic.StopFailure', async () => ({}))
  on('classic.SessionStart', async () => (options.startContext === undefined ? {} : { additionalContext: options.startContext }))
  return w
}

export type Task = { id: string; type: string; status: string; description: string }

// a world whose crews have no live descendants: every non-lead agent has finished
export const quiet = (w: World): World => {
  w.agents = w.agents.map(a => (a.type === LEAD_TYPE || a.id === 'X' || a.id === 'C1' ? a : { ...a, status: 'completed' }))
  return w
}

export const stop = (id: string, text: string, active = false, tasks?: Task[]) =>
  ({ background_tasks: tasks, hook_event_name: 'SubagentStop', session_id: 's1', cwd: 'C:/r/.claude/worktrees/x', agent_id: id, agent_type: 'x', agent_transcript_path: '', stop_hook_active: active, last_assistant_message: text, transcript_path: '' }) as never

export const handBack = ($: Engine, id: string, message: string) => $.tool.call({ tool: 'SubagentHandback', message, agentId: id } as never)

export const status = async ($: Engine) => ((await $.command.run({ command: 'foundry', args: '' } as never)) as { text?: string }).text ?? ''

export const startSession = ($: Engine) => $.session.start({ cwd: 'C:/r', surface: null, isInteractive: true } as never)

export const measure = ($: Engine, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) =>
  $.session.measure({ context: {}, rateLimits, changed: ['rateLimits'] } as never)
