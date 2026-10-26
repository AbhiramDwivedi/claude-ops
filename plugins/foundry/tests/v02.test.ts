import { expect, test } from 'claude-code/testing'

import {
  BLOCKED,
  CHECKPOINT,
  DIR_NOTE,
  HEARTBEAT_MS,
  LEAD_STOP_BLOCKS,
  LEAD_TYPE,
  LIMIT_RESET,
  MODEL_REFUSAL,
  PROPOSAL,
  QUESTION,
  RESET_GRACE_MS,
  STALL_MS,
  STALLED,
  agentVerdict,
  effortVerdict,
} from '../hooks/register'
import { NOW, ROOT, handBack, measure, quiet, startSession, status, stop, world } from './harness'

const MIN = 60_000

// ---------- exported names ----------

test('exports the constants the contract names', () => {
  expect(STALL_MS).toBe(15 * MIN)
  expect(HEARTBEAT_MS).toBe(MIN)
  expect(RESET_GRACE_MS).toBe(2 * MIN)
  expect(LEAD_STOP_BLOCKS).toBe(2)
  expect(STALLED).toBe('[foundry] stalled:')
  expect(LIMIT_RESET).toBe('[foundry] limit reset:')
  expect(BLOCKED).toBe('BLOCKED:')
  expect(PROPOSAL).toBe('PROPOSAL:')
  expect(CHECKPOINT).toBe('CHECKPOINT:')
  expect(QUESTION).toBe('QUESTION:')
  expect(DIR_NOTE).toBe('[foundry] dir:')
  expect(LEAD_TYPE).toBe('foundry:lead')
})

// ---------- 1. effort rules ----------

test('denies an Agent call without effort inside a crew, naming all four levels', async ($, on) => {
  const w = world($, on)
  for (const from of ['L1', 'A1', 'A2']) {
    const r = await w.agentCall(from, { model: 'sonnet' })
    expect(r.deny?.startsWith('[foundry] Refused:')).toBe(true)
    for (const level of ['low', 'medium', 'high', 'xhigh']) expect(r.deny).toContain(level)
  }
  expect(w.ran.length).toBe(0)
})

test('denies effort max inside a crew and names xhigh as the top', async ($, on) => {
  const w = world($, on)
  for (const from of ['L1', 'A1']) {
    const r = await w.agentCall(from, { model: 'opus', effort: 'max' })
    expect(r.deny?.startsWith('[foundry] Refused:')).toBe(true)
    expect(r.deny).toContain('max')
    expect(r.deny).toContain('xhigh')
  }
  expect(w.ran.length).toBe(0)
})

test('passes each allowed effort level with a model inside a crew', async ($, on) => {
  const w = world($, on)
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    expect((await w.agentCall('L1', { model: 'sonnet', effort })).deny).toBeUndefined()
    expect((await w.agentCall('A1', { model: 'opus', effort })).deny).toBeUndefined()
  }
  expect(w.ran.length).toBe(8)
})

test('checks the model before the effort', async ($, on) => {
  const w = world($, on)
  expect(await w.agentCall('L1', {})).toEqual({ deny: MODEL_REFUSAL })
  expect(await w.agentCall('L1', { effort: 'max' })).toEqual({ deny: MODEL_REFUSAL })
})

test('effort rules never touch the main thread, a non-crew agent or the cynic', async ($, on) => {
  const w = world($, on)
  for (const from of [undefined, 'X', 'C1']) {
    expect((await w.agentCall(from, {})).deny).toBeUndefined()
    expect((await w.agentCall(from, { model: 'sonnet' })).deny).toBeUndefined()
    expect((await w.agentCall(from, { model: 'opus', effort: 'max' })).deny).toBeUndefined()
  }
  expect((await w.agentCall(undefined, { subagent_type: 'foundry:cynic', name: 'cynic-1', model: 'opus', effort: 'max' })).deny).toBeUndefined()
  expect(w.ran.length).toBe(10)
})

test('effortVerdict is pure: crew callers need a valid effort, others pass', () => {
  const agents = [
    { id: 'L1', type: LEAD_TYPE, status: 'running', description: 'l', name: 'auth', label: 'auth', live: true, seq: 0 },
    { id: 'A1', type: 'kit:builder', status: 'running', description: 'a', name: 'b', parentId: 'L1', label: 'b', live: true, seq: 1 },
    { id: 'X', type: 'general-purpose', status: 'running', description: 'x', name: 'x', label: 'x', live: true, seq: 2 },
  ] as never
  expect(effortVerdict('A1', undefined, agents)?.deny.startsWith('[foundry] Refused:')).toBe(true)
  expect(effortVerdict('A1', 'max', agents)?.deny).toContain('xhigh')
  expect(effortVerdict('A1', 'high', agents)).toBeUndefined()
  expect(effortVerdict('L1', 'low', agents)).toBeUndefined()
  expect(effortVerdict('X', undefined, agents)).toBeUndefined()
  expect(effortVerdict('X', 'max', agents)).toBeUndefined()
  expect(effortVerdict(undefined, undefined, agents)).toBeUndefined()
  // the model-only verdict keeps its meaning
  expect(agentVerdict('A1', 'sonnet', agents)).toBeUndefined()
  expect(agentVerdict('A1', undefined, agents)).toEqual({ deny: MODEL_REFUSAL })
})

// ---------- 2. heartbeat / stall wake ----------

test('flags a running crew member idle for STALL_MS once, with the exact prompt and a toast', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(STALL_MS - HEARTBEAT_MS)
  expect(w.prompts.filter(p => p.startsWith(STALLED))).toEqual([])
  await w.clock.advance(HEARTBEAT_MS)
  expect(w.prompts.filter(p => p.startsWith(STALLED))).toEqual([
    '[foundry] stalled: auth-builder in crew auth, no activity for 15m. Check /foundry and message the auth lead.',
  ])
  expect(w.toasts.filter(t => t.includes('auth-builder')).length).toBe(1)
})

test('reports whole minutes idle, rounded down', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.clock.advance(30_000)
  await w.activity('A1')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  expect(w.prompts.filter(p => p.startsWith(STALLED))).toEqual([
    '[foundry] stalled: auth-builder in crew auth, no activity for 15m. Check /foundry and message the auth lead.',
  ])
})

test('flags a stalled lead too', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('L2')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  expect(w.prompts).toContain('[foundry] stalled: billing in crew billing, no activity for 15m. Check /foundry and message the billing lead.')
})

test('does not re-flag a stalled agent until it has new activity, then flags again', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  const mine = () => w.prompts.filter(p => p.startsWith(STALLED) && p.includes('auth-builder'))
  expect(mine().length).toBe(1)
  await w.clock.advance(60 * MIN)
  expect(mine().length).toBe(1)
  await w.activity('A1')
  await w.clock.advance(5 * MIN)
  expect(mine().length).toBe(1)
  await w.clock.advance(STALL_MS)
  expect(mine().length).toBe(2)
})

test('a turn.step counts as activity', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(10 * MIN)
  await w.step('A1')
  await w.clock.advance(10 * MIN)
  expect(w.prompts.filter(p => p.startsWith(STALLED) && p.includes('auth-builder'))).toEqual([])
  await w.clock.advance(6 * MIN)
  expect(w.prompts.filter(p => p.startsWith(STALLED) && p.includes('auth-builder')).length).toBe(1)
})

test('observing turn.step leaves the stream and its result alone', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const stream = ($ as never as { turn: { step: (e: unknown) => AsyncGenerator<unknown, unknown> } }).turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId: 'A1' })
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  expect(r.value).toEqual({ turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null })
  void w
})

test('never flags idle or waiting agents, however long they stay so', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.map(a => (a.id === 'A1' ? { ...a, status: 'idle' } : a.id === 'B1' ? { ...a, status: 'waiting' } : a))
  await startSession($)
  await w.activity('A1')
  await w.activity('B1')
  await w.clock.advance(3 * 60 * MIN)
  const flagged = w.prompts.filter(p => p.startsWith(STALLED))
  expect(flagged.some(p => p.includes('auth-builder'))).toBe(false)
  expect(flagged.some(p => p.includes('billing-builder'))).toBe(false)
})

test('never flags agents outside every crew, the cynic included', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('X')
  await w.activity('C1')
  await w.clock.advance(2 * 60 * MIN)
  const flagged = w.prompts.filter(p => p.startsWith(STALLED))
  expect(flagged.some(p => p.includes('helper') || p.includes('cynic'))).toBe(false)
})

test('an agent with no activity on record is not flagged on first sight, only STALL_MS after it', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.clock.advance(HEARTBEAT_MS * 2)
  expect(w.prompts.filter(p => p.startsWith(STALLED))).toEqual([])
  await w.clock.advance(STALL_MS - 5 * MIN)
  expect(w.prompts.filter(p => p.startsWith(STALLED))).toEqual([])
  await w.clock.advance(10 * MIN)
  // first seen about a minute in, so 16m or so idle by now
  expect(w.prompts.filter(p => p.startsWith(STALLED) && p.includes('auth-builder')).length).toBe(1)
})

test('session.start twice never runs two checks', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  expect(w.prompts.filter(p => p.startsWith(STALLED) && p.includes('auth-builder')).length).toBe(1)
})

test('/foundry lists a stalled agent under its crew and the lead\'s last activity on the crew line', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('L1')
  await w.activity('A1')
  await w.clock.advance(3 * MIN)
  let text = await status($)
  expect(text).toContain(', last active 3m ago')
  expect(text).not.toContain('stalled 3m')
  await w.activity('L1')
  await w.clock.advance(STALL_MS - 3 * MIN)
  text = await status($)
  expect(text).toContain('  auth-builder: stalled 15m')
  const lines = text.split('\n')
  const crew = lines.findIndex(l => l.startsWith('- auth:'))
  expect(lines[crew]).toContain(', last active 12m ago')
  expect(lines[crew + 1]).toBe('  auth-builder: stalled 15m')
})

test('/foundry omits last active when the lead has no activity on record', async ($, on) => {
  const w = world($, on)
  void w
  expect(await status($)).not.toContain('last active')
})

// ---------- 3. limit reset wake ----------

const resetAt = (afterMs: number) => new Date(NOW + afterMs).toISOString()
const limit = (resetsAt: string, percentUsed = 100) => [{ kind: 'five_hour', percentUsed, resetsAt }]
const resets = (prompts: string[]) => prompts.filter(p => p.startsWith(LIMIT_RESET))

test('wakes the foreman RESET_GRACE_MS after the five-hour window resets, with the exact text', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const at = resetAt(60 * MIN)
  await measure($, limit(at))
  await w.clock.advance(60 * MIN + RESET_GRACE_MS - 1000)
  expect(resets(w.prompts)).toEqual([])
  await w.clock.advance(1000)
  expect(resets(w.prompts)).toEqual([`[foundry] limit reset: the five-hour usage window reset at ${at}. Check /foundry and message each lead whose crew isn't done to resume.`])
})

test('arms once per resetsAt however often the limit is reported', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const at = resetAt(30 * MIN)
  await measure($, limit(at))
  await measure($, limit(at))
  await measure($, limit(at, 100))
  await w.clock.advance(3 * 60 * MIN)
  expect(resets(w.prompts).length).toBe(1)
})

test('a later resetsAt arms a new wake', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await measure($, limit(resetAt(30 * MIN)))
  await w.clock.advance(40 * MIN)
  expect(resets(w.prompts).length).toBe(1)
  await measure($, limit(resetAt(5 * 60 * MIN)))
  await w.clock.advance(5 * 60 * MIN)
  expect(resets(w.prompts).length).toBe(2)
})

test('does nothing below 100 percent, for other windows, or without resetsAt', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await measure($, limit(resetAt(30 * MIN), 99.9))
  await measure($, [{ kind: 'seven_day', percentUsed: 100, resetsAt: resetAt(30 * MIN) }])
  await measure($, [{ kind: 'five_hour', percentUsed: 100 }])
  await w.clock.advance(3 * 60 * MIN)
  expect(resets(w.prompts)).toEqual([])
})

test('does nothing without a live crew lead', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.filter(a => a.type !== LEAD_TYPE).map(a => ({ ...a, parentId: undefined }))
  await startSession($)
  await measure($, limit(resetAt(30 * MIN)))
  await w.clock.advance(3 * 60 * MIN)
  expect(resets(w.prompts)).toEqual([])
})

test('keeps the armed reset in $.state under the foundry plugin', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const at = resetAt(30 * MIN)
  await measure($, limit(at))
  const stored = [...w.stateValues.entries()].filter(([k]) => k.startsWith('foundry/'))
  expect(JSON.stringify(stored)).toContain(at)
  expect(JSON.stringify(stored)).toContain('"fired":false')
  await w.clock.advance(40 * MIN)
  expect(JSON.stringify([...w.stateValues.entries()])).toContain('"fired":true')
})

// A hot reload cannot be simulated here: the mock clock keeps the timers of the "old" instance, and the harness
// cannot re-run register on a fresh `on`. The nearest thing: session.start again with $.state kept.
test('session.start again with an armed reset in $.state still wakes exactly once', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await measure($, limit(resetAt(30 * MIN)))
  await w.clock.advance(10 * MIN)
  await startSession($)
  await w.clock.advance(30 * MIN)
  expect(resets(w.prompts).length).toBe(1)
})

test('session.start after the wake does not wake again', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await measure($, limit(resetAt(10 * MIN)))
  await w.clock.advance(20 * MIN)
  expect(resets(w.prompts).length).toBe(1)
  await startSession($)
  await w.clock.advance(60 * MIN)
  expect(resets(w.prompts).length).toBe(1)
})

test('a rate_limit StopFailure reads the window from session usage and arms the same wake', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const at = resetAt(45 * MIN)
  w.usageLimits = [{ kind: 'seven_day', percentUsed: 10, resetsAt: resetAt(9999 * MIN) }, ...limit(at)]
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await w.clock.advance(45 * MIN + RESET_GRACE_MS)
  expect(resets(w.prompts)).toEqual([`[foundry] limit reset: the five-hour usage window reset at ${at}. Check /foundry and message each lead whose crew isn't done to resume.`])
})

test('a StopFailure with another error arms nothing', async ($, on) => {
  const w = world($, on)
  await startSession($)
  w.usageLimits = limit(resetAt(10 * MIN))
  await $.classic.StopFailure({ error: 'server_error' } as never)
  await w.clock.advance(60 * MIN)
  expect(resets(w.prompts)).toEqual([])
})

test('a rate_limit StopFailure without a live lead arms nothing', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.filter(a => a.type !== LEAD_TYPE)
  await startSession($)
  w.usageLimits = limit(resetAt(10 * MIN))
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await w.clock.advance(60 * MIN)
  expect(resets(w.prompts)).toEqual([])
})

// ---------- 4. lead stop gate ----------

test('blocks a lead that stops without a report, with a [foundry] reason naming the sections', async ($, on) => {
  const w = quiet(world($, on))
  const r = (await $.classic.SubagentStop(stop('L1', 'All done, merged everything.'))) as { block?: string }
  expect(r.block?.startsWith('[foundry]')).toBe(true)
  for (const s of ['Summary', 'Branch', 'Changes', 'Proof', 'Checks run', 'Open questions', 'CHECKPOINT:', 'BLOCKED:', 'QUESTION:']) expect(r.block).toContain(s)
  expect(w.files.size).toBe(0)
})

test('lets a lead stop when its message starts with CHECKPOINT, BLOCKED or QUESTION, or has a Proof heading', async ($, on) => {
  world($, on)
  for (const text of ['CHECKPOINT: half done', 'BLOCKED: need a key', 'QUESTION: keep v1?', '   \n  CHECKPOINT: indented', 'Summary: x\n\n## Proof\nran it', '## Proof\nx', '##   Proof']) {
    expect(((await $.classic.SubagentStop(stop('L1', text))) as { block?: string }).block).toBeUndefined()
  }
})

test('does not take look-alikes for a report', async ($, on) => {
  quiet(world($, on))
  for (const text of ['PROPOSAL: x', 'Summary: x\nsee CHECKPOINT: later', '## Proofs\nx', '### Proof\nx', 'The ## Proof is below', '']) {
    expect(((await $.classic.SubagentStop(stop('L1', text))) as { block?: string }).block?.startsWith('[foundry]')).toBe(true)
  }
})

test('blocks at most twice per streak, then lets the third stop through', async ($, on) => {
  quiet(world($, on))
  const blocked = async (active: boolean) => ((await $.classic.SubagentStop(stop('L1', 'chatter', active))) as { block?: string }).block !== undefined
  expect(await blocked(false)).toBe(true)
  expect(await blocked(true)).toBe(true)
  expect(await blocked(true)).toBe(false)
})

test('stop_hook_active false starts a new streak; a stop that goes through ends the streak', async ($, on) => {
  quiet(world($, on))
  const blocked = async (active: boolean, text = 'chatter') => ((await $.classic.SubagentStop(stop('L1', text, active))) as { block?: string }).block !== undefined
  expect(await blocked(false)).toBe(true)
  expect(await blocked(true)).toBe(true)
  // a fresh streak
  expect(await blocked(false)).toBe(true)
  expect(await blocked(true)).toBe(true)
  expect(await blocked(true)).toBe(false)
  // and again after one that went through
  expect(await blocked(false)).toBe(true)
  expect(await blocked(true, 'CHECKPOINT: now')).toBe(false)
  expect(await blocked(false)).toBe(true)
  expect(await blocked(true)).toBe(true)
  expect(await blocked(true)).toBe(false)
})

test('counts streaks per lead', async ($, on) => {
  quiet(world($, on))
  const blocked = async (id: string, active: boolean) => ((await $.classic.SubagentStop(stop(id, 'chatter', active))) as { block?: string }).block !== undefined
  expect(await blocked('L1', false)).toBe(true)
  expect(await blocked('L1', true)).toBe(true)
  expect(await blocked('L2', false)).toBe(true)
  expect(await blocked('L1', true)).toBe(false)
  expect(await blocked('L2', true)).toBe(true)
})

test('never gates a member, and still captures its report', async ($, on) => {
  const w = world($, on)
  for (const id of ['A1', 'A2', 'B1']) expect(((await $.classic.SubagentStop(stop(id, 'chatter'))) as { block?: string }).block).toBeUndefined()
  expect(w.files.get(`${ROOT}/reports/auth/auth-builder.md`)).toBe('chatter')
})

test('never gates an agent outside every crew', async ($, on) => {
  world($, on)
  expect(((await $.classic.SubagentStop(stop('X', 'chatter'))) as { block?: string }).block).toBeUndefined()
  expect(((await $.classic.SubagentStop(stop('C1', 'chatter'))) as { block?: string }).block).toBeUndefined()
})

test('a blocked stop is not captured; the stop that goes through is', async ($, on) => {
  const w = quiet(world($, on))
  const path = `${ROOT}/reports/auth/auth.md`
  await $.classic.SubagentStop(stop('L1', 'chatter one'))
  await $.classic.SubagentStop(stop('L1', 'chatter two', true))
  expect(w.files.has(path)).toBe(false)
  await $.classic.SubagentStop(stop('L1', 'Summary: s\n## Proof\nreal report', true))
  expect(w.files.get(path)).toBe('Summary: s\n## Proof\nreal report')
})

test('a third stop of a streak goes through and is captured', async ($, on) => {
  const w = quiet(world($, on))
  await $.classic.SubagentStop(stop('L1', 'one'))
  await $.classic.SubagentStop(stop('L1', 'two', true))
  await $.classic.SubagentStop(stop('L1', 'three', true))
  expect(w.files.get(`${ROOT}/reports/auth/auth.md`)).toBe('three')
})

test('a blocked stop neither sets nor clears the waiting state', async ($, on) => {
  const w = quiet(world($, on))
  void w
  await $.classic.SubagentStop(stop('L1', 'QUESTION: Keep v1?\nmore'))
  expect(await status($)).toContain('waiting on you: Keep v1?')
  await $.classic.SubagentStop(stop('L1', 'chatter'))
  expect(await status($)).toContain('waiting on you: Keep v1?')
})

test('checks the hand-back text, not the sign-off, when the lead handed back', async ($, on) => {
  const w = world($, on)
  await handBack($, 'L1', 'Summary: s\n## Proof\nran the checks')
  expect(((await $.classic.SubagentStop(stop('L1', 'Done.'))) as { block?: string }).block).toBeUndefined()
  expect(w.files.get(`${ROOT}/reports/auth/auth.md`)).toBe('Summary: s\n## Proof\nran the checks')
})

test('blocks a lead whose hand-back lacks the report even if the sign-off has a Proof heading', async ($, on) => {
  const w = quiet(world($, on))
  await handBack($, 'L1', 'just a note')
  const r = (await $.classic.SubagentStop(stop('L1', '## Proof\nlooks fine'))) as { block?: string }
  expect(r.block?.startsWith('[foundry]')).toBe(true)
  expect(w.files.get(`${ROOT}/reports/auth/auth.md`)).not.toBe('## Proof\nlooks fine')
})

test('a hand-back report is not overwritten by the sign-off, and the next stop captures again', async ($, on) => {
  const w = world($, on)
  const path = `${ROOT}/reports/auth/auth.md`
  await handBack($, 'L1', 'CHECKPOINT: handed back')
  await $.classic.SubagentStop(stop('L1', 'Done.'))
  expect(w.files.get(path)).toBe('CHECKPOINT: handed back')
  await $.classic.SubagentStop(stop('L1', 'CHECKPOINT: second run'))
  expect(w.files.get(path)).toBe('CHECKPOINT: second run')
})

// ---------- 5. tags ----------

test('/foundry shows blocked, proposal and waiting tags from a lead\'s message to main', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'main', 'BLOCKED: no API key for staging\ndetails')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), blocked: no API key for staging')
  await w.send('L1', 'main', 'PROPOSAL: split the auth crew\nwhy')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), proposal: split the auth crew')
  await w.send('L1', 'main', 'QUESTION: Keep v1?')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), waiting on you: Keep v1?')
})

test('a foreman message to the lead clears blocked and proposal', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'main', 'BLOCKED: no key')
  await w.send(undefined, 'auth', 'Use the shared key.')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), no report yet')
  await w.send('L1', 'main', 'PROPOSAL: split')
  await w.send(undefined, 'auth', 'Go ahead.')
  expect(await status($)).toContain('- auth: running, 2 live members (unknown 2), no report yet')
})

test('a later untagged message to main replaces the tag', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'main', 'BLOCKED: no key')
  await w.send('L1', 'main', 'Merged the first slice.')
  const text = await status($)
  expect(text).not.toContain('blocked:')
})

test('a captured report starting with BLOCKED or PROPOSAL shows its tag; an untagged report clears it', async ($, on) => {
  world($, on)
  await $.classic.SubagentStop(stop('L1', 'BLOCKED: waiting on infra\nrest'))
  expect(await status($)).toContain('blocked: waiting on infra')
  await $.classic.SubagentStop(stop('L1', 'PROPOSAL: merge early\n## Proof\nx'))
  expect(await status($)).toContain('proposal: merge early')
  await $.classic.SubagentStop(stop('L1', 'Summary: done\n## Proof\nx'))
  const text = await status($)
  expect(text).not.toContain('proposal:')
  expect(text).not.toContain('blocked:')
  expect(text).toContain('last report')
})

test('a tag in one crew does not show in another', async ($, on) => {
  const w = world($, on)
  await w.send('L1', 'main', 'BLOCKED: no key')
  const text = await status($)
  expect(text).toContain('- billing: running, 1 live member (unknown 1), no report yet')
})

// ---------- 6. judge verdicts ----------

const judgeText = async ($: Parameters<typeof status>[0], w: ReturnType<typeof world>, files: Record<string, { text: string; age: number }>) => {
  for (const [name, f] of Object.entries(files)) {
    w.files.set(`${ROOT}/reports/auth/${name}`, f.text)
    w.mtimes.set(`${ROOT}/reports/auth/${name}`, NOW - f.age)
  }
  return status($)
}

test('shows a judge line from <crew>-judge.md under the crew line, before reports', async ($, on) => {
  const w = world($, on)
  const text = await judgeText($, w, { 'auth-judge.md': { text: 'VERDICT: PASS\nbecause', age: MIN } })
  const lines = text.split('\n')
  const i = lines.findIndex(l => l.startsWith('- auth:'))
  expect(lines[i + 1]).toBe('  judge: PASS')
  expect(lines[i + 2]).toBe(`  reports: ${ROOT}/reports/auth`)
})

test('takes the rest of the first line, trimmed', async ($, on) => {
  const w = world($, on)
  expect(await judgeText($, w, { 'auth-judge.md': { text: '  VERDICT:   FAIL - missing tests  \nx', age: MIN } })).toContain('\n  judge: FAIL - missing tests\n')
})

test('takes the newest of several judge files by mtime', async ($, on) => {
  const w = world($, on)
  const text = await judgeText($, w, {
    'auth-judge.md': { text: 'VERDICT: FAIL', age: 30 * MIN },
    'auth-judge-2.md': { text: 'VERDICT: PASS', age: 5 * MIN },
    'auth-judge-1.md': { text: 'VERDICT: REVISE', age: 20 * MIN },
  })
  expect(text).toContain('  judge: PASS')
  expect(text).not.toContain('judge: FAIL')
  expect(text).not.toContain('judge: REVISE')
})

test('shows nothing when the newest judge file has no VERDICT line, even if an older one has', async ($, on) => {
  const w = world($, on)
  const text = await judgeText($, w, {
    'auth-judge.md': { text: 'VERDICT: PASS', age: 30 * MIN },
    'auth-judge-2.md': { text: 'Looks fine to me', age: 5 * MIN },
  })
  expect(text).not.toContain('judge:')
})

test('shows nothing without a judge file, and ignores files that are not the crew\'s judge files', async ($, on) => {
  const w = world($, on)
  expect(await status($)).not.toContain('judge:')
  const text = await judgeText($, w, {
    'billing-judge.md': { text: 'VERDICT: PASS', age: MIN },
    'auth-judger.md': { text: 'VERDICT: PASS', age: MIN },
    'auth-builder.md': { text: 'VERDICT: PASS', age: MIN },
  })
  expect(text).not.toContain('judge:')
})

// ---------- 7. foundry dir note ----------

const startOf = ($: Parameters<typeof status>[0], extra: Record<string, unknown> = {}) =>
  $.classic.SessionStart({ source: 'startup', ...extra } as never) as Promise<{ additionalContext?: string[] }>

test('the main session gets exactly one dir line in additionalContext', async ($, on) => {
  world($, on)
  const r = await startOf($)
  expect(r.additionalContext).toEqual([`${DIR_NOTE} ${ROOT}`])
  expect(r.additionalContext?.[0]).toBe(`[foundry] dir: ${ROOT}`)
})

test('a subagent\'s SessionStart gets no dir note', async ($, on) => {
  world($, on)
  const r = await startOf($, { agent_id: 'A1', agent_type: 'kit:builder' })
  expect(r.additionalContext ?? []).toEqual([])
})

test('the dir note merges with the context beneath it', async ($, on) => {
  world($, on, { startContext: ['from elsewhere'] })
  const r = await startOf($)
  expect(r.additionalContext).toContain('from elsewhere')
  expect(r.additionalContext).toContain(`[foundry] dir: ${ROOT}`)
  expect(r.additionalContext?.length).toBe(2)
})

test('outside git the note carries the home fallback dir', async ($, on) => {
  world($, on, { inRepo: false })
  const r = await startOf($)
  expect(r.additionalContext).toEqual([`${DIR_NOTE} C:/Users/me/.claude/foundry/s1`])
})

test('an unresolvable dir adds no note and fails nothing', async ($, on) => {
  world($, on, { dirFails: true })
  const r = await startOf($)
  expect(r.additionalContext ?? []).toEqual([])
  expect((r as { block?: string }).block).toBeUndefined()
})

test('/foundry prints the dir with no crews', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.filter(a => a.id === 'X')
  expect(await status($)).toBe(`No foundry crews in this session. Start them with /foundry:run.\nFoundry dir: ${ROOT}`)
})

test('/foundry prints the dir as the last line with crews', async ($, on) => {
  world($, on)
  const text = await status($)
  expect(text.split('\n').at(-1)).toBe(`Foundry dir: ${ROOT}`)
  expect(text).toContain('Crews (2):')
})

test('/foundry omits the dir line when the dir cannot be resolved', async ($, on) => {
  const w = world($, on, { dirFails: true })
  expect(await status($)).not.toContain('Foundry dir:')
  w.agents = w.agents.filter(a => a.id === 'X')
  expect(await status($)).toBe('No foundry crews in this session. Start them with /foundry:run.')
})

// ---------- fail-open ----------

test('a throwing agent list never denies or blocks the new hooks', async ($, on) => {
  const w = world($, on, { listFails: true })
  await startSession($)
  expect((await w.agentCall('A1', { model: 'sonnet' })).deny).toBeUndefined()
  expect((await w.agentCall('A1', { model: 'sonnet', effort: 'max' })).deny).toBeUndefined()
  expect(((await $.classic.SubagentStop(stop('L1', 'chatter'))) as { block?: string }).block).toBeUndefined()
  await w.activity('A1')
  await w.step('A1')
  await w.clock.advance(STALL_MS * 2)
  await measure($, limit(resetAt(10 * MIN)))
  await w.clock.advance(60 * MIN)
  expect(w.prompts).toEqual([])
  expect(((await startOf($)) as { block?: string }).block).toBeUndefined()
})

test('a throwing prompt.submit never breaks a stall wake, a reset wake or the tools', async ($, on) => {
  const w = world($, on, { submitFails: true })
  await startSession($)
  await w.activity('A1')
  await measure($, limit(resetAt(10 * MIN)))
  await w.clock.advance(STALL_MS * 2)
  expect((await w.agentCall('A1', { model: 'sonnet', effort: 'low' })).deny).toBeUndefined()
  expect(((await $.classic.SubagentStop(stop('L1', 'CHECKPOINT: x'))) as { block?: string }).block).toBeUndefined()
})

test('a throwing $.state never blocks, denies or throws', async ($, on) => {
  const w = world($, on, { stateFails: true })
  await startSession($)
  await w.activity('A1')
  await measure($, limit(resetAt(10 * MIN)))
  w.usageLimits = limit(resetAt(10 * MIN))
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await w.clock.advance(STALL_MS * 2)
  expect((await w.agentCall('A1', { model: 'sonnet', effort: 'low' })).deny).toBeUndefined()
  expect(((await $.classic.SubagentStop(stop('L1', 'CHECKPOINT: x'))) as { block?: string }).block).toBeUndefined()
  expect(typeof (await status($))).toBe('string')
})

test('a throwing file write never blocks a lead\'s stop', async ($, on) => {
  quiet(world($, on, { writeFails: true }))
  expect(((await $.classic.SubagentStop(stop('L1', 'CHECKPOINT: x'))) as { block?: string }).block).toBeUndefined()
  expect(((await $.classic.SubagentStop(stop('L1', 'chatter'))) as { block?: string }).block?.startsWith('[foundry]')).toBe(true)
})

// ---------- 4b. interim stops: a lead with live descendants or its own background work ----------

const blockOf = async ($: Parameters<typeof status>[0], id: string, text: string, active: boolean, tasks?: Parameters<typeof stop>[3]) =>
  ((await $.classic.SubagentStop(stop(id, text, active, tasks))) as { block?: string }).block
const idle = (w: ReturnType<typeof world>, id: string) => {
  w.agents = w.agents.map(a => (a.id === id ? { ...a, status: 'idle' } : a))
}
const task = (id: string, status = 'running') => ({ id, type: 'local_agent', status, description: 'd' })

test('a lead with a live member may stop without a report', async ($, on) => {
  world($, on)
  expect(await blockOf($, 'L1', 'waiting for the builder', false)).toBeUndefined()
  expect(await blockOf($, 'L1', 'still waiting', false)).toBeUndefined()
})

test('a live descendant at any depth, in any live status, allows the stop', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.map(a => (a.id === 'A1' ? { ...a, status: 'completed' } : a))
  // only the grandchild A2 is live
  expect(await blockOf($, 'L1', 'chatter', false)).toBeUndefined()
  for (const s of ['pending', 'waiting', 'idle', 'running'] as const) {
    w.agents = w.agents.map(a => (a.id === 'A2' ? { ...a, status: s } : a))
    expect(await blockOf($, 'L1', 'chatter', false)).toBeUndefined()
  }
  w.agents = w.agents.map(a => (a.id === 'A2' ? { ...a, status: 'killed' } : a))
  expect(await blockOf($, 'L1', 'chatter', false)).toBeDefined()
})

test('another crew\'s live members do not excuse a lead', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.map(a => (a.id === 'A1' || a.id === 'A2' ? { ...a, status: 'completed' } : a))
  expect((await blockOf($, 'L1', 'chatter', false))?.startsWith('[foundry]')).toBe(true)
})

test('an interim stop neither counts toward nor resets the block streak', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.map(a => (a.id === 'A1' || a.id === 'A2' ? { ...a, status: 'completed' } : a))
  expect(await blockOf($, 'L1', 'chatter', false)).toBeDefined()
  w.agents = w.agents.map(a => (a.id === 'A1' ? { ...a, status: 'running' } : a))
  // interim, with stop_hook_active false: would reset the streak if it counted
  expect(await blockOf($, 'L1', 'interim', false)).toBeUndefined()
  expect(await blockOf($, 'L1', 'interim', true)).toBeUndefined()
  w.agents = w.agents.map(a => (a.id === 'A1' ? { ...a, status: 'completed' } : a))
  expect(await blockOf($, 'L1', 'chatter', true)).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', true)).toBeUndefined()
})

test('no live members and no proof is still blocked; the third consecutive such stop goes through', async ($, on) => {
  quiet(world($, on))
  expect(await blockOf($, 'L1', 'chatter', false)).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', true)).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', true)).toBeUndefined()
})

test('a running or pending background task of a descendant allows the stop', async ($, on) => {
  quiet(world($, on))
  expect(await blockOf($, 'L1', 'chatter', false, [task('A1')])).toBeUndefined()
  expect(await blockOf($, 'L1', 'chatter', false, [task('A1', 'pending')])).toBeUndefined()
  // a task of a grandchild counts too
  expect(await blockOf($, 'L1', 'chatter', false, [task('A2')])).toBeUndefined()
})

test('a background task that is finished, unattributable or another crew\'s does not allow the stop', async ($, on) => {
  quiet(world($, on))
  expect(await blockOf($, 'L1', 'chatter', false, [task('A1', 'completed')])).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', false, [task('zzz')])).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', false, [task('B1')])).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', false, [task('bash-1'), task('B1'), task('A1', 'killed')])).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', false, [])).toBeDefined()
})

test('one attributable task among unattributable ones allows the stop', async ($, on) => {
  quiet(world($, on))
  expect(await blockOf($, 'L1', 'chatter', false, [task('zzz'), task('B1'), task('A1')])).toBeUndefined()
})

test('/foundry shows waiting on members for an idle lead with live members', async ($, on) => {
  const w = world($, on)
  idle(w, 'L1')
  await blockOf($, 'L1', 'waiting for the builder', false)
  expect(await status($)).toContain('- auth: idle, 2 live members (unknown 2), waiting on members')
})

test('/foundry shows waiting on members for a pending or waiting lead, and for one no longer listed', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.map(a => (a.id === 'L1' ? { ...a, status: 'waiting' } : a))
  expect(await status($)).toContain('- auth: waiting, 2 live members (unknown 2), waiting on members')
  w.agents = w.agents.map(a => (a.id === 'L1' ? { ...a, status: 'pending' } : a))
  expect(await status($)).toContain('waiting on members')
  w.agents = w.agents.filter(a => a.id !== 'L1')
  expect(await status($)).toContain('- auth: ended, 2 live members (unknown 2), waiting on members')
})

test('/foundry keeps the report slot for a running lead with running members', async ($, on) => {
  const w = world($, on)
  await blockOf($, 'L1', 'interim', false)
  const text = await status($)
  expect(text).toContain('- auth: running, 2 live members (unknown 2), ')
  expect(text).not.toContain('waiting on members')
  void w
})

test('/foundry shows the report, not waiting on members, once the lead has no live descendants', async ($, on) => {
  const w = world($, on)
  idle(w, 'L1')
  expect(await status($)).toContain('waiting on members')
  quiet(w)
  await $.classic.SubagentStop(stop('L1', 'CHECKPOINT: done'))
  const text = await status($)
  expect(text).not.toContain('waiting on members')
  expect(text).toContain('last report')
})

test('waiting on members beats the last report; a tag beats waiting on members', async ($, on) => {
  const w = world($, on)
  await $.classic.SubagentStop(stop('L1', 'CHECKPOINT: first slice'))
  idle(w, 'L1')
  expect(await status($)).toContain('- auth: idle, 2 live members (unknown 2), waiting on members')
  await w.send('L1', 'main', 'BLOCKED: no key')
  let text = await status($)
  expect(text).toContain('blocked: no key')
  expect(text).not.toContain('waiting on members')
  await w.send(undefined, 'auth', 'Use the shared key.')
  text = await status($)
  expect(text).toContain('waiting on members')
  await w.send('L1', 'main', 'QUESTION: Keep v1?')
  expect(await status($)).toContain('waiting on you: Keep v1?')
})

test('an interim stop neither sets nor clears the tag state', async ($, on) => {
  const w = world($, on)
  idle(w, 'L1')
  await w.send('L1', 'main', 'BLOCKED: no key')
  await blockOf($, 'L1', 'just waiting', false)
  expect(await status($)).toContain('blocked: no key')
  await blockOf($, 'L1', 'QUESTION: Keep v1?\nmore', false)
  const text = await status($)
  expect(text).toContain('blocked: no key')
  expect(text).not.toContain('waiting on you')
})

test('an interim QUESTION stop does not set waiting on you', async ($, on) => {
  const w = world($, on)
  idle(w, 'L1')
  await blockOf($, 'L1', 'QUESTION: Keep v1?', false)
  const text = await status($)
  expect(text).not.toContain('waiting on you')
  expect(text).toContain('waiting on members')
})

test('a running background task of another crew\'s live member does not allow the stop', async ($, on) => {
  const w = world($, on)
  w.agents = w.agents.map(a => (a.id === 'A1' || a.id === 'A2' ? { ...a, status: 'completed' } : a))
  expect((await blockOf($, 'L1', 'chatter', false, [task('B1')]))?.startsWith('[foundry]')).toBe(true)
  expect((await blockOf($, 'L2', 'chatter', false, [task('B1')])) ?? 'allowed').toBe('allowed')
})
