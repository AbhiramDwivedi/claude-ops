import type { AgentInfo, On, TurnUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { MARK } from '../hooks/register'

// The engine starts a tool as soon as its call has streamed, while the rest of the response is still arriving,
// and the request's size comes only with the response's stop. A plugin that measured the request only once its
// step ended judged every call by the request before it: an agent that went 22K -> 86K -> 197K, calling tools
// only mid-stream, was never asked to checkpoint.

const MODEL = 'claude-sonnet-4-6'
const AGENT: AgentInfo = { id: 'abeb2e0498de8cd88', description: 'Reader', type: 'general-purpose', status: 'running' }
const usage = (context: number): TurnUsage => ({ model: MODEL, input_tokens: 2, output_tokens: 300, cache_read_input_tokens: context - 2, cache_creation_input_tokens: 0 })

// the model beneath the plugin: each response streams text, `calls` tool calls, then its stop with its usage
function world($: Engine, on: On) {
  mock.clock(on, { now: 1_000_000 })
  on('ui.toast', async () => ({ value: undefined }))
  on('agent.list', async () => ({ value: [AGENT] }))
  let context = 0
  let calls = 0
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'Reading.' }
    for (let i = 1; i <= calls; i++) {
      yield { kind: 'tool', index: i, id: `toolu_${e.index}_${i}`, name: 'Read' }
      yield { kind: 'input', index: i, json: '{"file_path":"/big.ts"}' }
    }
    yield { kind: 'stop', stopReason: calls > 0 ? 'tool_use' : 'end_turn', usage: usage(context) }
    const toolUses = Array.from({ length: calls }, () => ({ name: 'Read', input: { file_path: '/big.ts' } }))
    return { turnId: e.turnId, index: e.index, answer: 'Reading.', toolUses, stopReason: calls > 0 ? 'tool_use' : 'end_turn', usage: usage(context) }
  })
  on('tool.call', async () => ({ result: 'ok' }))
  let index = 0
  // one request of the agent, read as the engine reads it: each tool call runs the moment its chunk arrives
  return async function step(size: number, toolCalls: number): Promise<string[]> {
    context = size
    calls = toolCalls
    const notes: string[] = []
    const stream = $.turn.step({ turnId: 't1', index: index++, model: MODEL, messageCount: 2 * index, agentId: AGENT.id })
    for await (const chunk of stream) {
      if (chunk.kind !== 'tool') continue
      const result = await $.tool.call({ tool: 'Read', file_path: '/big.ts', agentId: AGENT.id } as never)
      notes.push(...(result.context ?? []).filter(n => n.startsWith(MARK)))
    }
    await stream.result
    return notes
  }
}

test('a tool call that streams in a request past the nudge limit carries the nudge', { options: { nudgeAtK: 50, stopAtK: 100 } }, async ($, on) => {
  const step = world($, on)
  expect(await step(22_000, 2)).toEqual([])
  const notes = await step(67_000, 1)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Your context has reached 67K tokens')
})

test('every tool call of a request past the stop limit is wound down, from its first', { options: { nudgeAtK: 50, stopAtK: 100 } }, async ($, on) => {
  const step = world($, on)
  expect(await step(22_000, 2)).toEqual([])
  const notes = await step(186_000, 3)
  expect(notes.length).toBe(3)
  expect(notes[0]).toContain('past the 100K limit. You have 7 tool calls left')
  expect(notes[2]).toContain('You have 5 tool calls left')
})

test('a response passes on every chunk, in order', async ($, on) => {
  world($, on)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: MODEL, messageCount: 2, agentId: AGENT.id })
  const kinds: string[] = []
  let read = await stream.next()
  for (; !read.done; read = await stream.next()) kinds.push(read.value.kind)
  // the mock's default is no tool calls; the text and the stop still pass, and so does the result
  expect(kinds).toEqual(['text', 'stop'])
  const r = read.value
  expect(r.usage?.model).toBe(MODEL)
})
