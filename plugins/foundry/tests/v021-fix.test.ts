import { expect } from 'claude-code/testing'

import { NOW, ROOT, handBack, quiet, startSession, status, stop, world, test } from './harness'

// foundry 0.2.1 regression tests for the judge's FAIL: idle-lead reload, status and stint; the stop gate after a tagged
// SendMessage; tagged short hand-backs; edited decision-log lines.

const MIN = 60_000
const IDLE = '[foundry] idle lead:'
const idleLeads = (prompts: string[]) => prompts.filter(p => p.startsWith(IDLE))
type W = ReturnType<typeof world>
const setStatus = (w: W, id: string, s: W['agents'][number]['status']) => {
  w.agents = w.agents.map(a => (a.id === id ? { ...a, status: s } : a))
}
const blockOf = async ($: Parameters<typeof status>[0], id: string, text: string, active = false) =>
  ((await $.classic.SubagentStop(stop(id, text, active))) as { block?: string }).block
const AUTH = `${ROOT}/reports/auth/auth.md`

// a quiet world whose lead L1 the module watches go from running to idle
const wentIdle = async ($: Parameters<typeof status>[0], w: W, to: W['agents'][number]['status'] = 'idle') => {
  await startSession($)
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', to)
}

// ---------- 1. reload ----------

test('fix 1: a lead first seen already idle by a fresh module is never prompted', async ($, on) => {
  const w = quiet(world($, on))
  setStatus(w, 'L1', 'idle')
  await startSession($)
  await w.clock.advance(3 * 60 * MIN)
  expect(idleLeads(w.prompts)).toEqual([])
})

for (const report of ['Summary: done\n\n## Proof\nran the tests', 'CHECKPOINT: half merged', 'BLOCKED: no staging key', 'QUESTION: keep v1?', 'PROPOSAL: split the crew']) {
  test(`fix 1: a report already on disk excuses a lead a fresh module sees go idle (${report.split(/[:\n]/)[0]})`, async ($, on) => {
    const w = quiet(world($, on))
    // written by the module before the reload
    w.files.set(AUTH, report)
    w.mtimes.set(AUTH, NOW - 5 * MIN)
    await wentIdle($, w)
    await w.clock.advance(2 * 60 * MIN)
    expect(idleLeads(w.prompts)).toEqual([])
  })
}

test('fix 1 control: a non-final report on disk does not excuse the lead', async ($, on) => {
  const w = quiet(world($, on))
  w.files.set(AUTH, 'merged the first slice, more later')
  w.mtimes.set(AUTH, NOW - 5 * MIN)
  await wentIdle($, w)
  await w.clock.advance(20 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
})

// ---------- 2. status ----------

for (const s of ['waiting', 'killed', 'failed'] as const) {
  test(`fix 2: a lead that goes from running to ${s} is never prompted`, async ($, on) => {
    const w = quiet(world($, on))
    await wentIdle($, w, s)
    await w.clock.advance(3 * 60 * MIN)
    expect(idleLeads(w.prompts)).toEqual([])
  })
}

test('fix 2 control: a lead that goes from running to idle is prompted', async ($, on) => {
  const w = quiet(world($, on))
  await wentIdle($, w, 'idle')
  await w.clock.advance(20 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
})

// ---------- 3. stint ----------

const FINAL = 'Summary: merged both slices into auth.\n\n## Proof\n12 pass, 0 fail'

test('fix 3: a final hand-back excuses the lead even with activity recorded after it', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  expect(((await handBack($, 'L1', FINAL)) as { deny?: string }).deny).toBeUndefined()
  await w.clock.advance(30_000)
  await w.activity('L1')
  await w.step('L1')
  expect(await blockOf($, 'L1', 'Done.')).toBeUndefined()
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(2 * 60 * MIN)
  expect(idleLeads(w.prompts)).toEqual([])
})

test('fix 3: a final stop report excuses the lead even with activity recorded after it', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  expect(await blockOf($, 'L1', FINAL)).toBeUndefined()
  await w.clock.advance(30_000)
  await w.activity('L1')
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(2 * 60 * MIN)
  expect(idleLeads(w.prompts)).toEqual([])
})

test('fix 3 control: a final report from an earlier stint does not excuse the lead after a resume', async ($, on) => {
  const w = quiet(world($, on))
  await startSession($)
  await w.clock.advance(2 * MIN)
  expect(await blockOf($, 'L1', FINAL)).toBeUndefined()
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(5 * MIN)
  setStatus(w, 'L1', 'running')
  await w.clock.advance(2 * MIN)
  setStatus(w, 'L1', 'idle')
  await w.clock.advance(20 * MIN)
  expect(idleLeads(w.prompts).length).toBe(1)
})

// ---------- 4. gate ----------

for (const tagged of ['QUESTION: keep v1?', 'BLOCKED: no API key', 'PROPOSAL: split the crew']) {
  const kind = tagged.split(':')[0]
  test(`fix 4: a lead that sent ${kind} to main may stop with any text until main answers`, async ($, on) => {
    const w = quiet(world($, on))
    await w.send('L1', 'main', `${tagged}\ndetails`)
    expect(await blockOf($, 'L1', 'waiting for the foreman')).toBeUndefined()
    expect(await blockOf($, 'L1', 'still waiting', true)).toBeUndefined()
    // main answers: the gate applies again
    await w.send(undefined, 'auth', 'Go ahead with v2.')
    expect(await blockOf($, 'L1', 'chatter')).toBeDefined()
  })
}

test('fix 4 control: an untagged message to main does not open the gate', async ($, on) => {
  const w = quiet(world($, on))
  await w.send('L1', 'main', 'Merged the first slice.')
  expect(await blockOf($, 'L1', 'chatter')).toBeDefined()
})

// ---------- 5. tagged hand-backs ----------

test('fix 5: a short hand-back with text after QUESTION, BLOCKED, PROPOSAL or CHECKPOINT passes', async ($, on) => {
  const w = world($, on)
  const texts = ['QUESTION: keep v1?', 'BLOCKED: no key', 'PROPOSAL: split it', 'CHECKPOINT: half done', '  QUESTION: why?  ']
  for (const from of ['A1', 'L1']) {
    for (const message of texts) expect(((await handBack($, from, message)) as { deny?: string }).deny).toBeUndefined()
  }
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(2 * texts.length)
})

test('fix 5: a tag with nothing after it is denied', async ($, on) => {
  const w = world($, on)
  for (const message of ['QUESTION:', 'BLOCKED:   ', 'PROPOSAL:\n', '  CHECKPOINT:  ']) {
    expect(((await handBack($, 'A1', message)) as { deny?: string }).deny).toBeDefined()
  }
  expect(w.ran.filter(c => c.tool === 'SubagentHandback').length).toBe(0)
})

// ---------- 6. edited decision-log lines keep their time ----------

const LOG = `${ROOT}/decisions.md`
const pad = (n: number) => String(n).padStart(2, '0')
const at = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const ran = (w: W, tool: string) => w.ran.filter(c => c.tool === tool).at(-1)

test('fix 6: an Edit that changes a logged line keeps its time', async ($, on) => {
  const w = world($, on)
  w.files.set(LOG, '- 10:40 | merged auth\n')
  await $.tool.call({ tool: 'Edit', file_path: LOG, old_string: '- 10:40 | merged auth', new_string: '- 10:40 | merged auth (squash)' } as never)
  expect(ran(w, 'Edit')?.new_string).toBe('- 10:40 | merged auth (squash)')
})

test('fix 6: a Write keeps the time of an old line left as it is or with trailing whitespace', async ($, on) => {
  const w = world($, on)
  w.files.set(LOG, '- 09:05 | start two crews\n- 09:10 | merge auth\n')
  await $.tool.call({ tool: 'Write', file_path: LOG, content: '- 09:05 | start two crews\n- 09:10 | merge auth   \n' } as never)
  expect(ran(w, 'Write')?.content).toBe('- 09:05 | start two crews\n- 09:10 | merge auth   \n')
})

test('fix 6: a brand-new line whose typed time is not in the old text is stamped, beside an edited line that keeps its time', async ($, on) => {
  const w = world($, on)
  w.files.set(LOG, '- 10:40 | merged auth\n')
  expect(at(NOW)).not.toBe('10:41')
  await $.tool.call({
    tool: 'Edit',
    file_path: LOG,
    old_string: '- 10:40 | merged auth\n',
    new_string: '- 10:40 | merged auth (squash)\n- 10:41 | defer docs\n',
  } as never)
  expect(ran(w, 'Edit')?.new_string).toBe(`- 10:40 | merged auth (squash)\n- ${at(NOW)} | defer docs\n`)
})
