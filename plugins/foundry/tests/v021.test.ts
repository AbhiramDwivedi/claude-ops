import { expect } from 'claude-code/testing'

import * as foundry from '../hooks/register'
import { HEARTBEAT_MS, LIMIT_RESET, RESET_GRACE_MS, STALL_MS, STALLED, stallText } from '../hooks/register'
import { NOW, ROOT, agent, handBack, measure, quiet, startSession, status, stop, world, test } from './harness'

// foundry 0.2.1 (spec C1-C4, C6, C7). Names the spec leaves open, chosen here for the builder to match:
//   IDLE_LEAD = '[foundry] idle lead:'               exported constant
//   idleLeadText(label, crew, minutes): string        exported; <crew>-<n+1> is the next crew name: auth -> auth-2, auth-3 -> auth-4
//   /foundry member line, after the crew's reports line:  `  <label> <status> <n>m (<model family>), last activity <ago>`
// New exports are read through the namespace, so a missing one fails its own test, not the whole file.

const MIN = 60_000
const api = foundry as unknown as Record<string, unknown>
const IDLE = '[foundry] idle lead:'
const idleLeads = (prompts: string[]) => prompts.filter(p => p.startsWith(IDLE))
const stalls = (prompts: string[], label: string) => prompts.filter(p => p.startsWith(STALLED) && p.includes(` ${label} in crew`))
const setStatus = (w: ReturnType<typeof world>, id: string, s: ReturnType<typeof world>['agents'][number]['status']) => {
  w.agents = w.agents.map(a => (a.id === id ? { ...a, status: s } : a))
}
const blockOf = async ($: Parameters<typeof status>[0], id: string, text: string, active = false) =>
  ((await $.classic.SubagentStop(stop(id, text, active))) as { block?: string }).block

// ---------- C1. the stall clock resets on resume ----------

test('C1: the stall prompt tells the foreman to read the transcript tail first', () => {
  expect(stallText('auth-builder', 'auth', 15)).toBe(
    '[foundry] stalled: auth-builder in crew auth, no activity for 15m. Check /foundry and message the auth lead. Read its transcript tail before you stop it; a resumed agent may be compacting.',
  )
})

test('C1 flow: the stall prompt the main session gets carries the transcript-tail advice', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  const mine = stalls(w.prompts, 'auth-builder')
  expect(mine.length).toBe(1)
  expect(mine[0]).toContain('Read its transcript tail before you stop it; a resumed agent may be compacting.')
})

test('C1 flow: an agent resumed after a long idle spell is not stalled on its first pass', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  setStatus(w, 'A1', 'idle')
  await w.clock.advance(26 * MIN)
  expect(stalls(w.prompts, 'auth-builder')).toEqual([])
  // resumed: compacting, no tool call or model step yet
  setStatus(w, 'A1', 'running')
  await w.clock.advance(HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder')).toEqual([])
  await w.clock.advance(STALL_MS - HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder')).toEqual([])
  // 15 minutes with no activity since the resume: now it is reported, once
  await w.clock.advance(2 * HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder').length).toBe(1)
  await w.clock.advance(60 * MIN)
  expect(stalls(w.prompts, 'auth-builder').length).toBe(1)
})

test('C1 flow: an agent that drops off the list and comes back running starts a fresh stall clock', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  const a1 = w.agents.find(a => a.id === 'A1')!
  w.agents = w.agents.filter(a => a.id !== 'A1')
  await w.clock.advance(30 * MIN)
  w.agents = [...w.agents, a1]
  await w.clock.advance(STALL_MS - HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder')).toEqual([])
  await w.clock.advance(2 * HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder').length).toBe(1)
})

test('C1 flow: a resume takes an agent off the stalled list, so a second stall is reported again', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await w.activity('A1')
  await w.clock.advance(STALL_MS + HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder').length).toBe(1)
  setStatus(w, 'A1', 'idle')
  await w.clock.advance(5 * MIN)
  setStatus(w, 'A1', 'running')
  await w.clock.advance(STALL_MS - HEARTBEAT_MS)
  // fresh clock from the resume, and no activity yet: not reported
  expect(stalls(w.prompts, 'auth-builder').length).toBe(1)
  await w.clock.advance(3 * HEARTBEAT_MS)
  expect(stalls(w.prompts, 'auth-builder').length).toBe(2)
})

test('C1 flow: agent.spawn counts as activity', async ($, on) => {
  const w = world($, on)
  on('agent.spawn', async () => ({ agentId: 'L9', model: 'claude-opus-4-1' }) as never)
  w.agents = [...w.agents, agent('L9', foundry.LEAD_TYPE, 'search')]
  // no session.start, so no heartbeat: only the spawn can have recorded activity
  await $.agent.spawn({ subagentType: foundry.LEAD_TYPE, prompt: 'p', description: 'd', name: 'search' } as never)
  await w.clock.advance(3 * MIN)
  const line = (await status($)).split('\n').find(l => l.startsWith('- search:'))
  expect(line).toContain(', last active 3m ago')
})

// ---------- C2. idle-lead check ----------

test('C2: exports IDLE_LEAD and idleLeadText with the exact prompt', () => {
  expect(api.IDLE_LEAD).toBe('[foundry] idle lead:')
  const text = api.idleLeadText as ((label: string, crew: string, minutes: number) => string) | undefined
  expect(typeof text).toBe('function')
  expect(text!('auth', 'auth', 17)).toBe(
    '[foundry] idle lead: auth in crew auth, no report for 17m and no member at work. Read its last message and resume it with SendMessage, or start auth-2 from its report.',
  )
  expect(text!('gateway-3', 'gateway-3', 20)).toBe(
    '[foundry] idle lead: gateway-3 in crew gateway-3, no report for 20m and no member at work. Read its last message and resume it with SendMessage, or start gateway-4 from its report.',
  )
})

test('C2 flow: an idle lead with no live member and no report is prompted once after 15 minutes', async ($, on) => {
  const w = quiet(world($, on))
  // the module must see the lead go from running to idle (v021-fix item 1)
  await startSession($)
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(14 * MIN)
  expect(idleLeads(w.prompts)).toEqual([])
  await w.clock.advance(3 * MIN)
  const got = idleLeads(w.prompts)
  expect(got.length).toBe(1)
  expect(got[0]!.startsWith('[foundry] idle lead: auth in crew auth, no report for ')).toBe(true)
  expect(got[0]).toContain('m and no member at work. Read its last message and resume it with SendMessage, or start auth-2 from its report.')
  // once per idle period, however long it lasts
  await w.clock.advance(3 * 60 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
  // the running lead L2 is never an idle lead
  expect(w.prompts.some(p => p.startsWith(IDLE) && p.includes('billing'))).toBe(false)
})

test('C2 flow: resuming the lead ends the idle period and re-arms the prompt', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(17 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
  setStatus(w, 'L1', 'running')
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(14 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
  await w.clock.advance(3 * MIN)
  expect(idleLeads(w.prompts).length).toBe(2)
})

test('C2 flow: no prompt while a member of the crew is live', async ($, on) => {
  const w = world($, on)
  setStatus(w, 'L1', 'idle')
  await startSession($)
  await w.clock.advance(2 * 60 * MIN)
  expect(idleLeads(w.prompts)).toEqual([])
})

for (const report of ['Summary: done\n\n## Proof\nran the tests', 'CHECKPOINT: half the slices merged', 'BLOCKED: no staging key']) {
  test(`C2 flow: no prompt for a lead whose captured report is final (${report.split('\n')[0]})`, async ($, on) => {
    const w = quiet(world($, on))
    await startSession($)
    await w.clock.advance(2 * MIN)
    expect(await blockOf($, 'L1', report)).toBeUndefined()
    setStatus(w, 'L1', 'idle')
    await w.clock.advance(2 * 60 * MIN)
    expect(idleLeads(w.prompts)).toEqual([])
  })
}

test('C2 flow: a captured report that is not final does not excuse the lead', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  // the gate sends two back; the third stop goes through and is captured, but has no Proof and no CHECKPOINT/BLOCKED
  expect(await blockOf($, 'L1', 'chatter', false)).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', true)).toBeDefined()
  expect(await blockOf($, 'L1', 'chatter', true)).toBeUndefined()
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(20 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
})

for (const tagged of ['QUESTION: keep v1?', 'BLOCKED: no API key', 'PROPOSAL: split the crew']) {
  test(`C2 flow: no prompt while the lead holds a waiting tag (${tagged.split(':')[0]})`, async ($, on) => {
    const w = quiet(world($, on))
    await startSession($)
    await w.send('L1', 'main', tagged)
    setStatus(w, 'L1', 'idle')
    await w.clock.advance(2 * 60 * MIN)
    expect(idleLeads(w.prompts)).toEqual([])
  })
}

test('C2 flow: only listed leads are checked: an unlisted lead, an idle member or an agent outside crews gets no prompt', async ($, on) => {
  const w = quiet(world($, on))
  // L1 drops off the list; B1 is an idle member; X is outside every crew
  w.agents = w.agents.filter(a => a.id !== 'L1')
  setStatus(w, 'B1', 'idle')
  setStatus(w, 'X', 'idle')
  await startSession($)
  await w.clock.advance(2 * 60 * MIN)
  expect(idleLeads(w.prompts)).toEqual([])
})

// ---------- C3. interim stops do not overwrite reports ----------

const AUTH = `${ROOT}/reports/auth/auth.md`
const AUTH_INTERIM = `${ROOT}/reports/auth/auth.interim.md`

test('C3 flow: an interim stop writes <label>.interim.md and leaves <label>.md untouched', async ($, on) => {
  const w = quiet(world($, on))
  expect(await blockOf($, 'L1', 'Summary: done\n\n## Proof\nran it')).toBeUndefined()
  expect(w.files.get(AUTH)).toBe('Summary: done\n\n## Proof\nran it')
  // a member is resumed, so the lead's next stop is interim
  setStatus(w, 'A1', 'running')
  expect(await blockOf($, 'L1', 'builder-4 is fixing the token test')).toBeUndefined()
  expect(w.files.get(AUTH)).toBe('Summary: done\n\n## Proof\nran it')
  expect(w.files.get(AUTH_INTERIM)).toBe('builder-4 is fixing the token test')
})

test('C3 flow: an interim stop after a hand-back writes the hand-back to the interim file only', async ($, on) => {
  const w = world($, on)
  await handBack($, 'L1', 'just a note on progress so far, more to come later on')
  // A1 is still running, so the stop is interim
  expect(await blockOf($, 'L1', 'Done.')).toBeUndefined()
  expect(w.files.has(AUTH)).toBe(false)
  expect(w.files.get(AUTH_INTERIM)).toBe('just a note on progress so far, more to come later on')
})

test('C3 flow: /foundry does not count an interim file as a report', async ($, on) => {
  const w = world($, on)
  expect(await blockOf($, 'L1', 'waiting on the builder')).toBeUndefined()
  expect(w.files.has(AUTH_INTERIM)).toBe(true)
  const line = (await status($)).split('\n').find(l => l.startsWith('- auth:'))
  expect(line).toContain('no report yet')
  expect(line).not.toContain('last report')
})

test('C3 flow: /foundry dates the last report from <label>.md, not from a newer interim file', async ($, on) => {
  const w = world($, on)
  w.files.set(AUTH, '## Proof\nx')
  w.mtimes.set(AUTH, NOW - 40 * MIN)
  w.files.set(AUTH_INTERIM, 'still going')
  w.mtimes.set(AUTH_INTERIM, NOW - MIN)
  quiet(w)
  const line = (await status($)).split('\n').find(l => l.startsWith('- auth:'))
  expect(line).toContain('last report 40m ago')
})

// a judge resumed after its ruling must not overwrite it: the merge gate reads the ruling from <label>.md
const JUDGE = `${ROOT}/reports/auth/auth-judge.md`
const JUDGE_INTERIM = `${ROOT}/reports/auth/auth-judge.interim.md`
const FAIL = 'VERDICT: FAIL\n\n## Findings\n- the done-check still fails on the token refresh path'
const PASS = 'VERDICT: PASS\n\n## Findings\n- none; the refresh test now advances the clock'
const reportEvents = (w: ReturnType<typeof world>) =>
  (w.files.get(`${ROOT}/events.jsonl`) ?? '')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(e => e.event === 'report' && e.agent === 'auth-judge')
const withJudge = (w: ReturnType<typeof world>) => w.agents.push(agent('J1', 'foundry:judge', 'auth-judge', 'L1'))

test('C3 flow: a judge follow-up with no ruling goes to the interim file and leaves the verdict', async ($, on) => {
  const w = quiet(world($, on))
  withJudge(w)
  await handBack($, 'J1', FAIL)
  expect(w.files.get(JUDGE)).toBe(FAIL)
  await handBack($, 'J1', 'The refresh test fails because the clock is not advanced past the expiry.')
  expect(w.files.get(JUDGE)).toBe(FAIL)
  expect(w.files.get(JUDGE_INTERIM)).toBe('The refresh test fails because the clock is not advanced past the expiry.')
  // the follow-up logs no report event, so it neither counts as a ruling nor spends the budget again
  expect(reportEvents(w).map(e => e.marker)).toEqual(['VERDICT: FAIL'])
})

test('C3 flow: a resumed judge that rules again replaces its verdict', async ($, on) => {
  const w = quiet(world($, on))
  withJudge(w)
  await handBack($, 'J1', FAIL)
  await handBack($, 'J1', PASS)
  expect(w.files.get(JUDGE)).toBe(PASS)
  expect(w.files.has(JUDGE_INTERIM)).toBe(false)
})

test('C3 flow: a red-team report is kept the same way', async ($, on) => {
  const w = quiet(world($, on))
  withJudge(w)
  await handBack($, 'J1', 'REDTEAM: 2 breaks found in the token refresh path')
  await handBack($, 'J1', 'Break 1 is the null token case, which the refresh path never checks.')
  expect(w.files.get(JUDGE)).toBe('REDTEAM: 2 breaks found in the token refresh path')
  expect(w.files.get(JUDGE_INTERIM)).toBe('Break 1 is the null token case, which the refresh path never checks.')
})

test('C3 flow: a report with no ruling is still replaced by the next one', async ($, on) => {
  const w = quiet(world($, on))
  withJudge(w)
  await handBack($, 'J1', 'Looking at the diff now.')
  await handBack($, 'J1', FAIL)
  expect(w.files.get(JUDGE)).toBe(FAIL)
})

test('C3 flow: the judge line ignores *.interim.md files', async ($, on) => {
  const w = world($, on)
  const put = (name: string, text: string, age: number) => {
    w.files.set(`${ROOT}/reports/auth/${name}`, text)
    w.mtimes.set(`${ROOT}/reports/auth/${name}`, NOW - age)
  }
  put('auth-judge.md', 'VERDICT: PASS', 30 * MIN)
  put('auth-judge.interim.md', 'VERDICT: FAIL - interim', MIN)
  put('auth-judge-9.interim.md', 'VERDICT: FAIL - numbered interim', MIN)
  const text = await status($)
  expect(text).toContain('  judge: PASS')
  expect(text).not.toContain('judge: FAIL')
})

// ---------- C4. empty hand-backs are refused ----------

const REFUSAL = 'Hand back your real report: what you did, the branch, and proof.'
const REAL = 'Summary: added the token test. Branch auth-tests. Proof: 12 pass.'

test('C4 flow: placeholder, TODO, tbd and short hand-backs from inside a crew are denied', async ($, on) => {
  const w = world($, on)
  const short = 'x'.repeat(39)
  for (const from of ['A1', 'A2', 'L1']) {
    for (const message of ['placeholder', 'Placeholder', 'TODO', 'todo', 'tbd', 'TBD', 'done', '', '   ', short, `   ${short}   \n`]) {
      const r = (await handBack($, from, message)) as { deny?: string }
      expect(r.deny).toBeDefined()
      expect(r.deny).toContain(REFUSAL)
    }
  }
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(0)
})

test('C4 flow: a real hand-back, 40 characters or more once trimmed, passes', async ($, on) => {
  const w = world($, on)
  expect(((await handBack($, 'A1', REAL)) as { deny?: string }).deny).toBeUndefined()
  expect(((await handBack($, 'A2', `  ${'y'.repeat(40)}  `)) as { deny?: string }).deny).toBeUndefined()
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(2)
  expect(w.files.get(`${ROOT}/reports/auth/auth-builder.md`)).toBe(REAL)
})

test('C4 flow: a hand-back from outside every crew is untouched', async ($, on) => {
  const w = world($, on)
  for (const from of ['X', 'C1', undefined]) {
    const r = (await $.tool.call({ tool: 'SubagentHandback', message: 'placeholder', agentId: from } as never)) as { deny?: string }
    expect(r.deny).toBeUndefined()
  }
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(3)
})

test('C4 flow: a denied hand-back is not captured; the member\'s stop is', async ($, on) => {
  const w = world($, on)
  const path = `${ROOT}/reports/auth/auth-builder.md`
  expect(((await handBack($, 'A1', 'placeholder')) as { deny?: string }).deny).toBeDefined()
  expect(w.files.has(path)).toBe(false)
  await $.classic.SubagentStop(stop('A1', REAL))
  expect(w.files.get(path)).toBe(REAL)
})

test('C4 flow: the check fails open when the agent list is down', async ($, on) => {
  const w = world($, on, { listFails: true })
  const r = (await handBack($, 'A1', 'placeholder')) as { deny?: string }
  expect(r.deny).toBeUndefined()
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(1)
})

// ---------- C6. a redundant reset wake is skipped ----------

const resetAt = (afterMs: number) => new Date(NOW + afterMs).toISOString()
const limit = (resetsAt: string) => [{ kind: 'five_hour', percentUsed: 100, resetsAt }]
const resets = (prompts: string[]) => prompts.filter(p => p.startsWith(LIMIT_RESET))
const mainToolCall = ($: Parameters<typeof status>[0]) => $.tool.call({ tool: 'Read', file_path: 'x' } as never)

test('C6 flow: a main-session tool call after resetsAt skips the wake, and the reset is still marked fired', async ($, on) => {
  const w = world($, on)
  await startSession($)
  const at = resetAt(60 * MIN)
  await measure($, limit(at))
  await w.clock.advance(60 * MIN + 30_000)
  await mainToolCall($)
  await w.clock.advance(RESET_GRACE_MS)
  expect(resets(w.prompts)).toEqual([])
  expect(w.stateValues.get('foundry/limitReset')).toEqual({ resetsAt: at, fired: true })
  // marked fired: the same resetsAt reported again, or a new session.start, never wakes later
  await measure($, limit(at))
  await startSession($)
  await w.clock.advance(3 * 60 * MIN)
  expect(resets(w.prompts)).toEqual([])
})

test('C6 flow: a main-session model step after resetsAt skips the wake too', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await measure($, limit(resetAt(60 * MIN)))
  await w.clock.advance(61 * MIN)
  await w.step(undefined)
  await w.clock.advance(3 * MIN)
  expect(resets(w.prompts)).toEqual([])
  expect((w.stateValues.get('foundry/limitReset') as { fired?: boolean } | undefined)?.fired).toBe(true)
})

test('C6 flow: main activity before resetsAt, or a member\'s activity after it, still wakes', async ($, on) => {
  const w = world($, on)
  await startSession($)
  await measure($, limit(resetAt(60 * MIN)))
  await w.clock.advance(30 * MIN)
  await mainToolCall($)
  await w.clock.advance(31 * MIN)
  await w.activity('A1')
  await w.step('L1')
  await w.clock.advance(2 * MIN)
  expect(resets(w.prompts).length).toBe(1)
})

// ---------- C7. /foundry shows each live member's running time and last activity ----------

test('C7 flow: /foundry lists each live member with status, model, running time and time since its last activity', async ($, on) => {
  const w = world($, on)
  on('agent.spawn', async () => ({ agentId: 'M9', model: 'claude-sonnet-4-6' }) as never)
  w.agents = [...w.agents, agent('M9', 'kit:test-writer', 'auth-tester', 'L1')]
  setStatus(w, 'A2', 'completed')
  await $.agent.spawn({ subagentType: 'kit:test-writer', prompt: 'p', description: 'd', name: 'auth-tester', parentAgentId: 'L1' } as never)
  await w.clock.advance(11 * MIN)
  await w.activity('M9')
  await w.activity('A1')
  await w.clock.advance(3 * MIN)
  const lines = (await status($)).split('\n')
  const auth = lines.findIndex(l => l.startsWith('- auth:'))
  const billing = lines.findIndex(l => l.startsWith('- billing:'))
  const block = lines.slice(auth + 1, billing > auth ? billing : undefined)
  expect(block).toContain('  auth-tester running 14m (sonnet), last activity 3m ago')
  const builder = block.find(l => l.startsWith('  auth-builder running '))
  expect(builder).toBeDefined()
  expect(builder).toContain(', last activity 3m ago')
  // a finished member is not listed
  expect(block.some(l => l.includes('auth-scout'))).toBe(false)
  // members are listed under their own crew only
  expect(lines.slice(billing + 1).some(l => l.includes('auth-tester'))).toBe(false)
  expect(lines.slice(billing + 1).some(l => l.startsWith('  billing-builder running '))).toBe(true)
})
