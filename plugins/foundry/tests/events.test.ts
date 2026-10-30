import { expect } from 'claude-code/testing'

import { EFFORT_REFUSAL, EVENT_BACKLOG_MAX, EVENT_WAIT_MS, HANDBACK_REFUSAL, ROLL_BYTES, markerOf } from '../hooks/register'
import { NOW, ROOT, handBack, quiet, startSession, stop, world, test } from './harness'

// foundry 0.4.0 event log (ADR-0003 s1) and the HH:MM stamp (s2), past what contract.test.ts pins: tag and report
// lines, the idle-lead stall, the roll at ROLL_BYTES, refused calls, and an Edit holding HH:MM on both sides.

type W = ReturnType<typeof world>

const MIN = 60_000
const EVENTS = `${ROOT}/events.jsonl`
const LOG = `${ROOT}/decisions.md`
const pad = (n: number) => String(n).padStart(2, '0')
const at = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const lines = (w: W, path = EVENTS) => (w.files.get(path) ?? '').split('\n').filter(l => l.trim() !== '')
const events = (w: W) => lines(w).map(l => JSON.parse(l) as Record<string, unknown>)
const keys = (e: Record<string, unknown>) => Object.keys(e).sort()
const setStatus = (w: W, id: string, s: W['agents'][number]['status']) => {
  w.agents = w.agents.map(a => (a.id === id ? { ...a, status: s } : a))
}

test('a lead tagging its message to main appends one tag line, without the message text', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.send('L1', 'main', 'QUESTION: keep the v1 endpoint secret-text?\nOptions: keep or drop.')
  await w.send('L2', 'main', 'BLOCKED: no API key for staging')
  await w.send('L1', 'main', 'PROPOSAL: split the auth crew')
  // untagged: clears the tag, logs nothing
  await w.send('L1', 'main', 'merged, thanks')
  await settle()
  const got = events(w)
  expect(got.map(e => [e.event, e.crew, e.agent, e.tag])).toEqual([
    ['tag', 'auth', 'auth', 'QUESTION'],
    ['tag', 'billing', 'billing', 'BLOCKED'],
    ['tag', 'auth', 'auth', 'PROPOSAL'],
  ])
  for (const e of got) expect(keys(e)).toEqual(['agent', 'crew', 'event', 'tag', 'ts', 'v'])
  expect(lines(w).some(l => l.includes('secret-text') || l.includes('Options'))).toBe(false)
})

test('a refused SendMessage, a refused Agent call and a refused hand-back append nothing', async ($, on) => {
  const w = world($, on)
  await startSession($)
  // a member may not message main
  expect((await w.send('A1', 'main', 'QUESTION: may I?')).deny).toBeDefined()
  expect(await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-x', model: 'sonnet' })).toEqual({ deny: EFFORT_REFUSAL })
  expect(await handBack($, 'A1', 'done')).toEqual({ deny: HANDBACK_REFUSAL })
  await settle()
  expect(w.files.has(EVENTS)).toBe(false)
})

test('a lead started by the main session appends a spawn line with by main and the lead as its own crew', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.agentCall(undefined, { subagent_type: 'foundry:lead', name: 'docs', model: 'opus' })
  // outside every crew: no line
  await w.agentCall('X', { subagent_type: 'Explore', name: 'scout' })
  await settle()
  const got = events(w)
  expect(got.length).toBe(1)
  const e = got[0] ?? {}
  expect([e.event, e.crew, e.agent, e.agentId, e.type, e.model, e.effort, e.by]).toEqual(['spawn', 'docs', 'docs', 'new1', 'foundry:lead', 'opus', null, 'main'])
  expect(keys(e)).toEqual(['agent', 'agentId', 'by', 'crew', 'effort', 'event', 'model', 'ts', 'type', 'v'])
  expect(lines(w).some(l => l.includes('"p"') || l.includes('"d"'))).toBe(false)
})

test('a final report appends one report line with its marker; an interim stop appends none', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await handBack($, 'A1', 'VERDICT: PASS\nthe proof holds, every check ran and the diff matches the brief')
  await settle()
  await $.classic.SubagentStop(stop('B1', '\n\nCHECKPOINT: half done, the rest is listed in the handoff note below'))
  await settle()
  // L1 still has live members: its stop is interim and goes to auth.interim.md
  await $.classic.SubagentStop(stop('L1', 'waiting on my members to finish their work'))
  await settle()
  const got = events(w)
  expect(got.map(e => [e.event, e.crew, e.agent, e.marker])).toEqual([
    ['report', 'auth', 'auth-builder', 'VERDICT: PASS'],
    ['report', 'billing', 'billing-builder', 'CHECKPOINT'],
  ])
  for (const e of got) expect(keys(e)).toEqual(['agent', 'crew', 'event', 'marker', 'ts', 'v'])
  expect(lines(w).some(l => l.includes('proof holds') || l.includes('handoff'))).toBe(false)
})

test('markerOf reads the first non-empty line, else null', () => {
  expect(markerOf('VERDICT: FAIL\nwhy')).toBe('VERDICT: FAIL')
  expect(markerOf('  \n  REDTEAM 3 findings')).toBe('REDTEAM')
  expect(markerOf('QUESTION: which?')).toBe('QUESTION')
  expect(markerOf('PROPOSAL: x')).toBe('PROPOSAL')
  expect(markerOf('BLOCKED: x')).toBe('BLOCKED')
  expect(markerOf('## Summary\nVERDICT: PASS')).toBe(null)
  expect(markerOf('')).toBe(null)
  expect(markerOf('VERDICT: PASS | FAIL')).toBe(null)
  expect(markerOf('VERDICT: PASS | FAIL\nwhy')).toBe(null)
  expect(markerOf('VERDICT: PASS')).toBe('VERDICT: PASS')
  expect(markerOf('VERDICT: PASS\nwhy')).toBe('VERDICT: PASS')
  expect(markerOf('VERDICT: FAIL - why')).toBe('VERDICT: FAIL')
})

test('an idle lead wake appends one stall line with kind idle-lead and the minutes its prompt shows', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(17 * MIN)
  await settle()
  await w.clock.advance(60 * MIN)
  await settle()
  const idle = events(w).filter(e => e.kind === 'idle-lead')
  expect(idle.length).toBe(1)
  const e = idle[0] ?? {}
  expect([e.event, e.crew, e.agent]).toEqual(['stall', 'auth', 'auth'])
  expect(keys(e)).toEqual(['agent', 'crew', 'event', 'kind', 'minutes', 'ts', 'v'])
  const prompt = w.prompts.find(p => p.startsWith('[foundry] idle lead: auth '))
  expect(prompt).toBeDefined()
  expect(Number(/no report for (\d+)m/.exec(prompt ?? '')?.[1])).toBe(e.minutes as number)
})

test('past ROLL_BYTES the log moves to the first free events.<n>.jsonl and starts over', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const big = `${'x'.repeat(ROLL_BYTES)}\n`
  w.files.set(EVENTS, big)
  w.files.set(`${ROOT}/events.1.jsonl`, 'old\n')
  await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-helper', model: 'sonnet', effort: 'low' })
  await settle()
  expect(w.files.get(`${ROOT}/events.1.jsonl`)).toBe('old\n')
  expect(w.files.get(`${ROOT}/events.2.jsonl`)).toBe(big)
  expect(events(w).map(e => [e.event, e.agent, e.effort])).toEqual([['spawn', 'auth-helper', 'low']])
  // under the limit it appends
  await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-helper-2', model: 'sonnet', effort: 'low' })
  await settle()
  expect(events(w).map(e => e.agent)).toEqual(['auth-helper', 'auth-helper-2'])
  expect(w.files.has(`${ROOT}/events.3.jsonl`)).toBe(false)
})

test('an Edit with HH:MM in both old_string and new_string gets the clock time; a clock time already there is kept', async ($, on) => {
  const w = world($, on)
  const before = '- 09:05 | start | plan | none | followed\n- HH:MM | a | b | c | followed\n'
  w.files.set(LOG, before)
  await $.tool.call({ tool: 'Edit', file_path: LOG, old_string: before, new_string: `${before}- HH:MM | d | e | f | followed\n` } as never)
  const call = w.ran.filter(c => c.tool === 'Edit').at(-1)
  expect(call?.old_string).toBe(before)
  expect(call?.new_string).toBe(`- 09:05 | start | plan | none | followed\n- ${at(NOW)} | a | b | c | followed\n- ${at(NOW)} | d | e | f | followed\n`)
})

// ---------- a hung or half-failed event log changes nothing else (ADR-0003 s1, P5) ----------

// no call, stop or wake waits on the event log longer than this, on the engine clock
const BOUND = 10_000
const never: Promise<void> = new Promise(() => {})
const hang = (w: W) => {
  w.files.set(EVENTS, '')
  w.holds.set(EVENTS, never)
}
// starts `call`, gives it BOUND on the clock, and says whether it returned
const returnsWithin = async (w: W, call: () => Promise<unknown>) => {
  let done = false
  void call().then(() => {
    done = true
  })
  await settle()
  await w.clock.advance(BOUND)
  await settle()
  return done
}

test('with the event log hung, an Agent call returns within the bound with its report note', async ($, on) => {
  const w = world($, on)
  await startSession($)
  hang(w)
  let r: { context?: unknown } | undefined
  const done = await returnsWithin(w, async () => {
    r = await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-helper', model: 'sonnet', effort: 'low' })
  })
  expect(done).toBe(true)
  expect(w.ran.filter(c => c.tool === 'Agent').length).toBe(1)
  expect(r?.context).toEqual([`[foundry] If auth-helper's report does not reach you, read ${ROOT}/reports/auth/auth-helper.md once it stops.`])
})

test('with the event log hung, a hand-back reaches its tool and a final SubagentStop returns, each within the bound', async ($, on) => {
  const w = world($, on)
  await startSession($)
  hang(w)
  expect(await returnsWithin(w, () => handBack($, 'A1', 'VERDICT: PASS\nthe proof holds, every check ran and the diff matches the brief'))).toBe(true)
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(1)
  expect(await returnsWithin(w, () => $.classic.SubagentStop(stop('B1', 'CHECKPOINT: half done, the rest is listed in the handoff note below')))).toBe(true)
  expect(w.files.has(`${ROOT}/reports/billing/billing-builder.md`)).toBe(true)
})

test('with the event log hung, a lead tagging main gets its message through within the bound', async ($, on) => {
  const w = world($, on)
  await startSession($)
  hang(w)
  expect(await returnsWithin(w, () => w.send('L1', 'main', 'QUESTION: keep v1?'))).toBe(true)
  expect(w.ran.filter(c => c.tool === 'SendMessage').length).toBe(1)
})

test('with the event log hung, every stall wake and idle-lead wake still goes out, the later ones too', async ($, on) => {
  const w = world($, on)
  await startSession($)
  hang(w)
  await w.activity('A1')
  await w.clock.advance(15 * MIN)
  await settle()
  await w.clock.advance(16 * MIN)
  await settle()
  expect(w.prompts.filter(p => p.includes('auth-builder')).length).toBe(1)
  // every crew agent was idle that long; billing-builder works again, then stalls again, with the first wakes'
  // appends still hung
  const billing = () => w.prompts.filter(p => p.includes('billing-builder')).length
  expect(billing()).toBe(1)
  await w.activity('B1')
  await w.clock.advance(17 * MIN)
  await settle()
  await w.clock.advance(17 * MIN)
  await settle()
  expect(billing()).toBe(2)
  // and an idle lead after both, once its members are done
  quiet(w)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(17 * MIN)
  await settle()
  await w.clock.advance(17 * MIN)
  await settle()
  expect(w.prompts.filter(p => p.startsWith('[foundry] idle lead: auth ')).length).toBe(1)
})

// ---------- the event log stays serial: a slow write delays the appends after it, never clobbers them ----------

const FAILED = 'foundry: event log failed, letting the call through:'
const spawn = (w: W, name: string) => w.agentCall('A1', { subagent_type: 'kit:builder', name, model: 'sonnet', effort: 'low' })
// holds the next write of the live log until released
const gate = (w: W) => {
  let release = () => {}
  w.writeHolds.set(EVENTS, new Promise<void>(r => (release = r)))
  return () => release()
}
const OLD = `${JSON.stringify({ v: 1, ts: new Date(NOW - 60 * MIN).toISOString(), event: 'stall', crew: 'auth', agent: 'old', kind: 'agent', minutes: 15 })}\n`
const isOld = (l: string) => (JSON.parse(l) as { agent: string }).agent === 'old'
// lets queued appends run until the live log holds `want` lines; moving the clock by 0 settles the event loop
const drain = async (w: W, want: number) => {
  for (let i = 0; i < 200 && lines(w).length < want; i++) await w.clock.advance(0)
}

test('an append that hangs holds the appends after it, in order, and none is lost once it answers', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const release = gate(w)
  let r: { context?: unknown } | undefined
  expect(
    await returnsWithin(w, async () => {
      r = await spawn(w, 'auth-1')
    }),
  ).toBe(true)
  expect(r?.context).toEqual([`[foundry] If auth-1's report does not reach you, read ${ROOT}/reports/auth/auth-1.md once it stops.`])
  // the later calls return within the bound too, their appends queued behind the hung one
  expect(await returnsWithin(w, () => spawn(w, 'auth-2'))).toBe(true)
  expect(await returnsWithin(w, () => spawn(w, 'auth-3'))).toBe(true)
  // long after, still under the stall bound, so no wake adds a line of its own
  await w.clock.advance(10 * MIN)
  await settle()
  expect(lines(w)).toEqual([])
  expect(w.logs.filter(l => l === `${FAILED} no answer in ${EVENT_WAIT_MS}ms`).length).toBe(3)
  release()
  await drain(w, 3)
  expect(events(w).map(e => e.agent)).toEqual(['auth-1', 'auth-2', 'auth-3'])
  // and the queue runs on as normal afterwards
  await spawn(w, 'auth-4')
  await settle()
  expect(events(w).map(e => e.agent)).toEqual(['auth-1', 'auth-2', 'auth-3', 'auth-4'])
})

// ---------- the cross-crew message log is bounded the same way ----------

const MESSAGES = `${ROOT}/messages.jsonl`
const MSG_FAILED = 'foundry: message log failed, letting the call through:'
const msgs = (w: W) => lines(w, MESSAGES).map(l => (JSON.parse(l) as { summary: string }).summary)

test('with the message log hung, a cross-crew SendMessage returns within the bound and logs it', async ($, on) => {
  const w = world($, on)
  await startSession($)
  w.files.set(MESSAGES, '')
  w.holds.set(MESSAGES, never)
  expect(await returnsWithin(w, () => w.send('L1', 'billing'))).toBe(true)
  expect(w.ran.filter(c => c.tool === 'SendMessage').length).toBe(1)
  expect(w.logs.filter(l => l === `${MSG_FAILED} no answer in ${EVENT_WAIT_MS}ms`).length).toBe(1)
})

test('a message append that hangs holds the message appends after it, in order, and none is lost once it answers', async ($, on) => {
  const w = world($, on)
  await startSession($)
  let release = () => {}
  w.writeHolds.set(MESSAGES, new Promise<void>(r => (release = r)))
  const send = (s: string) => $.tool.call({ tool: 'SendMessage', to: 'billing', message: 'm', summary: s, agentId: 'L1' } as never)
  expect(await returnsWithin(w, () => send('one'))).toBe(true)
  expect(await returnsWithin(w, () => send('two'))).toBe(true)
  expect(await returnsWithin(w, () => send('three'))).toBe(true)
  expect(msgs(w)).toEqual([])
  expect(w.logs.filter(l => l === `${MSG_FAILED} no answer in ${EVENT_WAIT_MS}ms`).length).toBe(3)
  release()
  for (let i = 0; i < 200 && msgs(w).length < 3; i++) await w.clock.advance(0)
  expect(msgs(w)).toEqual(['one', 'two', 'three'])
})

test('red team B1: a write that lands after the bound does not clobber an append made in the meantime', async ($, on) => {
  const w = world($, on)
  await startSession($)
  w.files.set(EVENTS, OLD)
  const release = gate(w)
  void spawn(w, 'auth-1')
  await settle()
  await w.clock.advance(EVENT_WAIT_MS + 1)
  await settle()
  void spawn(w, 'auth-2')
  await settle()
  await w.clock.advance(EVENT_WAIT_MS + 1)
  await settle()
  release()
  await settle()
  await spawn(w, 'auth-3')
  await settle()
  expect(lines(w).filter(isOld).length).toBe(1)
  expect(events(w).map(e => e.agent).filter(a => a !== 'old')).toEqual(['auth-1', 'auth-2', 'auth-3'])
})

test('red team B2: a write that lands after the bound near ROLL_BYTES does not roll the old lines twice', async ($, on) => {
  const w = world($, on)
  await startSession($)
  // just under ROLL_BYTES: one spawn line takes the live log past it
  const n = Math.floor(ROLL_BYTES / OLD.length) - 1
  const fill = ROLL_BYTES - 60 - OLD.length * n
  const padded = `${JSON.stringify({ ...(JSON.parse(OLD) as object), pad: 'x'.repeat(fill - 140) })}\n`
  w.files.set(EVENTS, OLD.repeat(n) + padded)
  expect((w.files.get(EVENTS) ?? '').length).toBeLessThan(ROLL_BYTES)
  const release = gate(w)
  void spawn(w, 'auth-1')
  await settle()
  await w.clock.advance(EVENT_WAIT_MS + 1)
  await settle()
  for (const name of ['auth-2', 'auth-3']) {
    void spawn(w, name)
    await settle()
    await w.clock.advance(EVENT_WAIT_MS + 1)
    await settle()
  }
  release()
  await settle()
  await spawn(w, 'auth-4')
  await settle()
  const files = [...w.files.keys()].filter(k => /\/events\.\d+\.jsonl$/.test(k)).sort()
  const all = [...files, EVENTS].flatMap(k => lines(w, k))
  expect(all.filter(isOld).length).toBe(n + 1)
  expect(all.filter(l => !isOld(l)).map(l => (JSON.parse(l) as { agent: string }).agent)).toEqual(['auth-1', 'auth-2', 'auth-3', 'auth-4'])
  expect(files).toEqual([`${ROOT}/events.1.jsonl`])
})

test('past EVENT_BACKLOG_MAX queued appends a new event is dropped and logged; the queued ones land once the fs answers', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const release = gate(w)
  // the first append's write is held; every call after it queues behind it. Started in batches of 50, as many calls
  // at once cost the kit far more; the whole hold must stay inside the kit's 10 s real-time budget for one hook
  // (HookBudget.ms), past which the held fs.write hook is skipped.
  const calls: Promise<unknown>[] = []
  for (let i = 0; i < EVENT_BACKLOG_MAX; i++) {
    calls.push(spawn(w, `q-${i}`))
    if (i % 50 === 49) await w.clock.advance(0)
  }
  expect(lines(w)).toEqual([])
  // dropped at once, without waiting on the clock
  await spawn(w, 'over')
  expect(w.logs.filter(l => l === `${FAILED} ${EVENT_BACKLOG_MAX} appends already queued`).length).toBe(1)
  release()
  await drain(w, EVENT_BACKLOG_MAX)
  // every queued call returns once its append lands
  await Promise.all(calls)
  expect(lines(w).length).toBe(EVENT_BACKLOG_MAX)
  // the backlog has drained: a new event is queued again (the mock's agent ids all repeat, so lines are counted)
  await spawn(w, 'after')
  await drain(w, EVENT_BACKLOG_MAX + 1)
  expect(lines(w).length).toBe(EVENT_BACKLOG_MAX + 1)
  expect(w.logs.filter(l => l.startsWith(FAILED)).length).toBe(1)
})

test('a roll whose live rewrite fails is not copied again by the next append', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const big = `${'x'.repeat(ROLL_BYTES)}\n`
  w.files.set(EVENTS, big)
  let failed = false
  w.failWrite = p => {
    if (failed || p !== EVENTS) return false
    failed = true
    return true
  }
  await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-1', model: 'sonnet', effort: 'low' })
  await settle()
  expect(failed).toBe(true)
  expect(w.files.get(`${ROOT}/events.1.jsonl`)).toBe(big)
  await w.agentCall('A1', { subagent_type: 'kit:builder', name: 'auth-2', model: 'sonnet', effort: 'low' })
  await settle()
  expect(w.files.has(`${ROOT}/events.2.jsonl`)).toBe(false)
  expect(events(w).map(e => e.agent)).toEqual(['auth-2'])
})

test('the message log: a roll whose live rewrite fails is not copied again by the next message', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const LIVE = `${ROOT}/messages.jsonl`
  const big = `${'x'.repeat(ROLL_BYTES)}\n`
  w.files.set(LIVE, big)
  let failed = false
  w.failWrite = p => {
    if (failed || p !== LIVE) return false
    failed = true
    return true
  }
  await w.send('L1', 'billing')
  await w.send('L1', 'billing')
  await settle()
  expect(failed).toBe(true)
  expect(w.files.get(`${ROOT}/messages.1.jsonl`)).toBe(big)
  expect(w.files.has(`${ROOT}/messages.2.jsonl`)).toBe(false)
  expect(lines(w, LIVE).map(l => (JSON.parse(l) as { from: string }).from)).toEqual(['auth'])
})
