import { expect, test } from 'claude-code/testing'

import { NOW, ROOT, world } from './harness'

// foundry 0.2.1 C5: a `- HH:MM |` the foreman types on a new decision-log line is replaced with the clock's local time

const LOG = `${ROOT}/decisions.md`
const pad = (n: number) => String(n).padStart(2, '0')
const at = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const ran = (w: ReturnType<typeof world>, tool: string) => w.ran.filter(c => c.tool === tool).at(-1)

test('C5: a Write of the decision log gets the real time on each new line', async ($, on) => {
  const w = world($, on)
  await $.tool.call({ tool: 'Write', file_path: LOG, content: '- 10:40 | merge auth first | fewer conflicts | answer | followed\n- 10:41 | defer docs | none | followed\n' } as never)
  expect(ran(w, 'Write')?.content).toBe(`- ${at(NOW)} | merge auth first | fewer conflicts | answer | followed\n- ${at(NOW)} | defer docs | none | followed\n`)
})

test('C5: lines the log already holds keep their time', async ($, on) => {
  const w = world($, on)
  w.files.set(LOG, '# Decisions\n- 09:05 | start two crews | plan | none | followed\n')
  await w.clock.advance(7 * 60_000)
  await $.tool.call({ tool: 'Write', file_path: LOG, content: '# Decisions\n- 09:05 | start two crews | plan | none | followed\n- 23:59 | merge auth | judge PASS | none | followed\n' } as never)
  expect(ran(w, 'Write')?.content).toBe(`# Decisions\n- 09:05 | start two crews | plan | none | followed\n- ${at(NOW + 7 * 60_000)} | merge auth | judge PASS | none | followed\n`)
})

test('C5: an Edit of the decision log stamps its new lines only, and keeps its other fields', async ($, on) => {
  const w = world($, on)
  w.files.set(LOG, '- 09:05 | start two crews | plan | none | followed\n')
  await $.tool.call({
    tool: 'Edit',
    file_path: LOG,
    old_string: '- 09:05 | start two crews | plan | none | followed\n',
    new_string: '- 09:05 | start two crews | plan | none | followed\n- 10:40 | merge auth | judge PASS | none | followed\n',
  } as never)
  const call = ran(w, 'Edit')
  expect(call?.old_string).toBe('- 09:05 | start two crews | plan | none | followed\n')
  expect(call?.new_string).toBe(`- 09:05 | start two crews | plan | none | followed\n- ${at(NOW)} | merge auth | judge PASS | none | followed\n`)
})

test('C5: a Windows path to the log is matched, and CRLF lines keep their endings', async ($, on) => {
  const w = world($, on)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\r\\.git\\foundry\\s1\\decisions.md', content: '- 10:40 | a | b | none | followed\r\n' } as never)
  expect(ran(w, 'Write')?.content).toBe(`- ${at(NOW)} | a | b | none | followed\r\n`)
})

test('C5: other files, another session\'s log and lines without a leading time are left alone', async ($, on) => {
  const w = world($, on)
  const text = '- 10:40 | merge auth | x | none | followed\n'
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/notes/decisions.md', content: text } as never)
  expect(ran(w, 'Write')?.content).toBe(text)
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/.git/foundry/s2/decisions.md', content: text } as never)
  expect(ran(w, 'Write')?.content).toBe(text)
  const prose = 'merged at 10:40 | later\n  - 10:40 | indented\n'
  await $.tool.call({ tool: 'Write', file_path: LOG, content: prose } as never)
  expect(ran(w, 'Write')?.content).toBe(prose)
})

test('C5: fails open: a call the check cannot read goes through as made', async ($, on) => {
  const w = world($, on)
  // no file_path: the check throws, and the write goes on untouched for the tool to judge
  const text = '- 10:40 | merge auth | x | none | followed\n'
  const r = (await $.tool.call({ tool: 'Write', content: text } as never)) as { deny?: string }
  expect(r.deny).toBeUndefined()
  expect(ran(w, 'Write')?.content).toBe(text)
  expect(w.logs.some(l => l.includes('decision time failed'))).toBe(true)
})
