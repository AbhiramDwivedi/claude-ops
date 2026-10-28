import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import * as W from '../hooks/register.ts'

// Contract test for repo ADR-0014 ("Seams"): worktrees reads kit's manifest at
// <main checkout>/.claude/kit/manifest.json and gives no worktree to a type it declares read-only.
// Written by foundry run 2's design crew before the producer exists. It imports nothing from the hooks:
// it drives classic.PreToolUse through $.tool.call, as hooks.test.ts does.

const MANIFEST = 'C:/r/.claude/kit/manifest.json'
const UNREADABLE = 'worktrees: kit manifest unreadable, ignoring it:'
const slashed = (p: string) => p.replace(/\\/g, '/')

type Agent = { name: unknown; readOnly: unknown; declaredBy?: unknown }
const manifest = (agents: Agent[], version: unknown = 1) =>
  JSON.stringify({ version, kit: '0.2.0', checks: [], agents, riskyPaths: [], setupScripts: [] })

const DECLARED = manifest([
  { name: 'foundry:cynic', readOnly: true, declaredBy: 'foundry' },
  { name: 'foundry:judge', readOnly: true, declaredBy: 'foundry' },
  { name: 'kit:builder', readOnly: false, declaredBy: 'kit' },
  { name: 'kit:reviewer', readOnly: true, declaredBy: 'kit' },
])

// the engine beneath the plugin: git says the session is in a repo whose common dir is C:/r/.git, the
// files map serves fs.exists and fs.read, and each Agent call that reaches the engine is recorded
function world(on: On, files: Map<string, string>, readThrows = false) {
  const seen: Record<string, unknown>[] = []
  const logs: string[] = []
  on('process.run', async (_, e) => {
    const args = e.argv.join(' ')
    const stdout = args.includes('--git-common-dir') ? 'C:/r/.git\n' : args.includes('--is-inside-work-tree') ? 'true\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_, e) => ({ value: files.has(slashed(e.path)) }))
  on('fs.read', async (_, e) => {
    if (readThrows && slashed(e.path) === MANIFEST) throw new Error('EACCES: permission denied')
    const text = files.get(slashed(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_, e) => {
    files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('env.get', async () => ({ value: undefined }))
  on('session.cwd', async () => ({ value: 'C:/r' }))
  on('ui.log', async (_, e) => {
    logs.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('tool.call', async (_, e) => {
    seen.push(e as unknown as Record<string, unknown>)
    return { result: 'ok' }
  })
  return { seen, logs }
}

const call = ($: Parameters<Parameters<typeof test>[1]>[0], type: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: type, ...extra } as never) as Promise<{ deny?: string }>

test('1. a type the manifest declares read-only gets no worktree, matched case-folded', async ($, on) => {
  const { seen } = world(on, new Map([[MANIFEST, DECLARED]]))
  await call($, 'foundry:judge')
  await call($, 'Foundry:Judge')
  expect(seen.map(e => e.isolation)).toEqual([undefined, undefined])
})

test('2. a declared name matches only in full, and readOnly: false declares nothing', async ($, on) => {
  const { seen } = world(on, new Map([[MANIFEST, DECLARED]]))
  for (const t of ['judge', 'other:judge', 'kit:builder']) await call($, t)
  expect(seen.map(e => e.isolation)).toEqual(['worktree', 'worktree', 'worktree'])
})

test('2b. declarations only add: readOnly: false never takes a type out of the built-in no-isolate set', async ($, on) => {
  const { seen } = world(on, new Map([[MANIFEST, manifest([{ name: 'Explore', readOnly: false, declaredBy: 'project' }])]]))
  await call($, 'Explore')
  expect(seen[0]?.isolation).toBe(undefined)
})

test('2c. a bad entry adds nothing and the rest still count', async ($, on) => {
  const text = manifest([
    { name: 'bad name!', readOnly: true, declaredBy: 'project' },
    { name: 7, readOnly: true, declaredBy: 'project' },
    { name: 'x:y', readOnly: 'yes', declaredBy: 'x' },
    { name: 'foundry:judge', readOnly: true, declaredBy: 'foundry' },
  ])
  const { seen } = world(on, new Map([[MANIFEST, text]]))
  await call($, 'x:y')
  await call($, 'foundry:judge')
  expect(seen.map(e => e.isolation)).toEqual(['worktree', undefined])
})

test('2d. the manifest is read on every call, so a declaration made mid-session counts on the next call', async ($, on) => {
  const files = new Map<string, string>()
  const { seen } = world(on, files)
  await call($, 'foundry:judge')
  files.set(MANIFEST, DECLARED)
  await call($, 'foundry:judge')
  expect(seen.map(e => e.isolation)).toEqual(['worktree', undefined])
})

test('3. an explicit isolation on the call still wins', async ($, on) => {
  const { seen } = world(on, new Map([[MANIFEST, DECLARED]]))
  await call($, 'foundry:judge', { isolation: 'worktree' })
  expect(seen[0]?.isolation).toBe('worktree')
})

test('4a. with no manifest, worktrees behaves as 0.5.0 and logs nothing about it', async ($, on) => {
  const { seen, logs } = world(on, new Map())
  const r = await call($, 'foundry:judge')
  expect(r?.deny).toBeUndefined()
  expect(seen[0]?.isolation).toBe('worktree')
  expect(logs.filter(l => l.startsWith(UNREADABLE))).toEqual([])
})

const broken: [string, Map<string, string>, boolean][] = [
  ['not JSON', new Map([[MANIFEST, '{not json']]), false],
  ['version 2', new Map([[MANIFEST, manifest([{ name: 'foundry:judge', readOnly: true, declaredBy: 'foundry' }], 2)]]), false],
  ['fs.read throwing', new Map([[MANIFEST, DECLARED]]), true],
]

for (const [label, files, throws] of broken) {
  test(`4b. a manifest that is ${label} fails open to today's behaviour`, async ($, on) => {
    const { seen } = world(on, files, throws)
    const r = await call($, 'foundry:judge')
    expect(r?.deny).toBeUndefined()
    expect(seen[0]?.isolation).toBe('worktree')
  })

  test(`4c. a manifest that is ${label} is logged to the debug log`, async ($, on) => {
    const { logs } = world(on, files, throws)
    await call($, 'foundry:judge')
    expect(logs.filter(l => l.startsWith(UNREADABLE)).length).toBe(1)
  })
}

// ---- amendment 2026-10-27 to ADR-0014: refused read-only types ----

const REFUSED = ['general-purpose', 'kit:builder', 'kit:test-writer', 'foundry:architect', 'foundry:devops', 'foundry:lead', 'foundry:writer']
const IGNORING = 'worktrees: kit manifest declares editing types read-only, ignoring them: '
const ALL_DECLARED = manifest([
  ...REFUSED.map(name => ({ name, readOnly: true, declaredBy: 'kit' })),
  { name: 'foundry:judge', readOnly: true, declaredBy: 'foundry' },
])

for (const type of [...REFUSED, 'General-Purpose']) {
  test(`5. a declared read-only ${type} still gets isolation "worktree" and is not denied`, async ($, on) => {
    const { seen } = world(on, new Map([[MANIFEST, ALL_DECLARED]]))
    const r = await call($, type)
    expect(r?.deny).toBeUndefined()
    expect(seen[0]?.isolation).toBe('worktree')
  })
}

test('5. an unset subagent_type counts as general-purpose and gets a worktree even when declared read-only', async ($, on) => {
  const { seen } = world(on, new Map([[MANIFEST, ALL_DECLARED]]))
  const r = (await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)) as { deny?: string }
  expect(r?.deny).toBeUndefined()
  expect(seen[0]?.isolation).toBe('worktree')
})

test('5. positive control: foundry:judge declared read-only beside the refused types still gets no worktree', async ($, on) => {
  const { seen } = world(on, new Map([[MANIFEST, ALL_DECLARED]]))
  const r = await call($, 'foundry:judge')
  expect(r?.deny).toBeUndefined()
  expect(seen[0]?.isolation).toBe(undefined)
})

test('6. the debug log holds the ignoring line naming each refused entry, on each call that reads the manifest', async ($, on) => {
  const { logs } = world(on, new Map([[MANIFEST, ALL_DECLARED]]))
  await call($, 'foundry:judge')
  await call($, 'foundry:judge')
  const lines = logs.filter(l => l.startsWith(IGNORING))
  expect(lines.length).toBe(2)
  expect(lines[0]).toBe(`${IGNORING}${REFUSED.join(', ')}`)
})

test('6. with nothing refused the ignoring line is not logged', async ($, on) => {
  const { logs } = world(on, new Map([[MANIFEST, DECLARED]]))
  await call($, 'foundry:judge')
  expect(logs.filter(l => l.startsWith(IGNORING))).toEqual([])
})

test('7. REFUSED_READ_ONLY_TYPES is exported: the seven names, lower-case, in the ADR order', () => {
  expect((W as Record<string, unknown>).REFUSED_READ_ONLY_TYPES).toEqual(REFUSED)
})

test('7. declaredReadOnly returns types without refused names, refused in file order as written, and error only when broken', () => {
  const f = (W as Record<string, unknown>).declaredReadOnly as (t: string) => { types: Set<string>; refused: string[]; error?: string }
  const r = f(ALL_DECLARED)
  expect([...r.types]).toEqual(['foundry:judge'])
  expect(r.refused).toEqual(REFUSED)
  expect(r.error).toBeUndefined()
  const mixed = f(
    manifest([
      { name: 'Foundry:Lead', readOnly: true, declaredBy: 'x' },
      { name: 'GENERAL-PURPOSE', readOnly: true, declaredBy: 'x' },
      { name: 'lead', readOnly: true, declaredBy: 'x' },
      { name: 'plugin:general-purpose', readOnly: true, declaredBy: 'x' },
      { name: 'kit:builder', readOnly: false, declaredBy: 'x' },
    ]),
  )
  expect(mixed.refused).toEqual(['Foundry:Lead', 'GENERAL-PURPOSE'])
  expect([...mixed.types].sort()).toEqual(['lead', 'plugin:general-purpose'])
  const broken = f('{not json')
  expect(broken.refused).toEqual([])
  expect(typeof broken.error).toBe('string')
})
