// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0008 Seams 1-5: contract tests for interview/ledger.ts and interview/cli.ts. Written from the ADR before either file exists.
// Seams 6-7 (branches.md, SKILL.md wording) belong to other crews and are not tested here.
//
// Run with: node --test plugins/foundry/tests/contract-interview.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
// The code under test is imported inside each test, so a missing module fails that test with
// "producer missing: interview/ledger.ts" instead of crashing the file.
// Names the ADR leaves open are pinned in the describe('lead-pinned shapes ...') block at the end; adjust them there.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_PATH = join(PLUGIN, 'interview', 'cli.ts')
const LEDGER_PATH = join(PLUGIN, 'interview', 'ledger.ts')

const ledger = async () => {
  try {
    return await import('../interview/ledger.ts')
  } catch (e) {
    assert.fail(`producer missing: interview/ledger.ts (${e?.code ?? e?.message})`)
  }
}
const cli = async () => {
  try {
    return await import('../interview/cli.ts')
  } catch (e) {
    assert.fail(`producer missing: interview/cli.ts (${e?.code ?? e?.message})`)
  }
}
const source = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    assert.fail(`producer missing: ${path}`)
  }
}

// ---------- branches.md fixtures ----------

const blk = (id: string, over: Record<string, string | undefined> = {}): string => {
  const f = { Pack: 'core', Visit: 'standard', Ask: `Ask ${id}`, Recommend: `Rec ${id}`, Writes: 'constraint', ...over }
  return `## ${id}\n${Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n`
}

const SAMPLE = [
  blk('outcome', { Visit: 'standard, large', Ask: 'What is it for?', Recommend: 'the goal text', Writes: 'functional', Fact: 'README, docs/' }),
  blk('hosting', { Visit: 'standard, large', Ask: 'Where does it run?', Recommend: 'what the repo deploys to', Opens: 'environments, cost' }),
  blk('environments', { Visit: 'opened', Ask: 'Which environments?', Recommend: 'staging and production' }),
  blk('cost', { Visit: 'large', Writes: 'nfr', Ask: 'What is the budget?', Recommend: 'the current bill' }),
  blk('integrations', { Visit: 'standard, large', Ask: 'Which services does it call?', Recommend: 'the SDKs in use', Opens: 'webhooks, secrets' }),
  blk('secrets', { Ask: 'Where do secrets live?', Recommend: 'the existing vault' }),
  blk('authz', { Pack: 'service', Visit: 'standard', Ask: 'Who may do what?', Recommend: 'roles in the code' }),
  blk('webhooks', { Pack: 'service', Visit: 'opened', Ask: 'Which hooks?', Recommend: 'the ones in use' }),
  blk('browsers', { Pack: 'frontend', Visit: 'large', Ask: 'Which browsers?', Recommend: 'last two versions' }),
].join('\n')

const state = (over: Record<string, unknown> = {}) => ({
  goal: 'add invoice export',
  size: 'standard',
  packs: [],
  opened: [],
  requirements: [],
  visits: {},
  stopped: false,
  ...over,
})
const ids = (bs: { id: string }[]): string[] => bs.map((b) => b.id)

// ---------- requirements.md fixtures ----------

// ADR-0008 section 7, copied exactly
const EXAMPLE = `# Requirements

Kept by foundry's owner interview (ADR-0008). Ids are never reused.

## R-1: Owners can export their invoices as CSV
Status: open
Kind: functional
Added: 2026-10-29T19:42:00Z | add invoice export
Source: owner
Example: Given an account with 3 invoices, when the owner clicks Export, then a CSV with 3 rows downloads.

## R-2: The export finishes quickly for large accounts
Status: open
Kind: nfr
Measure: p95 under 5 s at 10,000 invoices
Added: 2026-10-29T19:42:00Z | add invoice export
Source: default

## Non-goals
- No PDF export.
`

const AT = '2026-10-29T19:42:00Z | add invoice export'
const req = (n: number, o: Record<string, string | undefined> = {}, lines: string[] = [], title = `Title ${n}`): string => {
  const f = { Status: 'open', Kind: 'constraint', Added: AT, Source: 'owner', ...o }
  return [
    `## R-${n}: ${title}`,
    ...Object.entries(f)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`),
    ...lines,
    '',
  ].join('\n')
}
const doc = (...parts: string[]): string => `# Requirements\n\nKept.\n\n${parts.join('\n')}\n## Non-goals\n- none\n`
const errs = async (md: string): Promise<string[]> => (await ledger()).parseRequirements(md).errors

// ---------- cli fixtures ----------

const tmp = (): string => mkdtempSync(join(tmpdir(), 'interview-contract-'))
const put = (dir: string, name: string, content: string): string => {
  const p = join(dir, name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
const lines = (r: { out: unknown }): string[] => {
  const o = Array.isArray(r.out) ? r.out.join('\n') : String(r.out ?? '')
  return o
    .split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter((l) => l !== '')
}
const run = async (...argv: string[]) => (await cli()).main(argv)

// ======================= Seam 1 =======================

describe('Seam 1: ledger exports and erasable-TypeScript rules', () => {
  test('ledger.ts exports the seven names; PACKS is the seven packs', async () => {
    const m = await ledger()
    for (const name of ['parseBranches', 'remainingBranches', 'nextBranches', 'parseRequirements', 'goalRequirementLines', 'checkTrace']) {
      assert.equal(typeof m[name], 'function', `${name} must be an exported function`)
    }
    assert.ok(Array.isArray(m.PACKS), 'PACKS must be an array')
    assert.deepEqual([...m.PACKS], ['core', 'service', 'frontend', 'data', 'ai', 'infra', 'library'])
  })

  test('cli.ts exports COMMANDS and main', async () => {
    const m = await cli()
    assert.equal(typeof m.main, 'function')
    assert.ok(m.COMMANDS && typeof m.COMMANDS === 'object', 'COMMANDS must be an object')
    for (const c of ['next', 'remaining', 'check', 'trace']) assert.ok(c in m.COMMANDS, `COMMANDS.${c} missing`)
  })

  for (const [label, path] of [['ledger.ts', LEDGER_PATH], ['cli.ts', CLI_PATH]]) {
    test(`${label}: erasable TypeScript, .ts import extensions, node: built-ins only`, () => {
      const text = source(path)
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      assert.doesNotMatch(code, /\benum\s+\w/, 'no enums')
      for (const m of code.matchAll(/constructor\s*\(([^)]*)\)/g)) {
        assert.doesNotMatch(m[1], /\b(public|private|protected|readonly)\b/, 'no constructor parameter properties')
      }
      const specs = [...code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const s of specs) {
        if (s.startsWith('.')) assert.match(s, /\.ts$/, `relative import must end in .ts: ${s}`)
        else assert.ok(s.startsWith('node:'), `only node: built-ins allowed: ${s}`)
      }
    })
  }
})

// ======================= Seam 2 =======================

describe('Seam 2: parseBranches', () => {
  test('parses a valid file into branches in file order', async () => {
    const { parseBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    assert.deepEqual(ids(bs), ['outcome', 'hosting', 'environments', 'cost', 'integrations', 'secrets', 'authz', 'webhooks', 'browsers'])
  })

  const bad: [string, string, string][] = [
    ['missing Pack', blk('alpha', { Pack: undefined }), 'alpha'],
    ['missing Visit', blk('alpha', { Visit: undefined }), 'alpha'],
    ['missing Ask', blk('alpha', { Ask: undefined }), 'alpha'],
    ['missing Recommend', blk('alpha', { Recommend: undefined }), 'alpha'],
    ['missing Writes', blk('alpha', { Writes: undefined }), 'alpha'],
    ['bad Pack', blk('alpha', { Pack: 'mobile' }), 'alpha'],
    ['bad Visit value', blk('alpha', { Visit: 'huge' }), 'alpha'],
    ['Visit small is never allowed', blk('alpha', { Visit: 'standard, small' }), 'alpha'],
    ['bad Writes', blk('alpha', { Writes: 'wish' }), 'alpha'],
    ['unknown field line', `${blk('alpha')}Colour: red\n`, 'alpha'],
    ['duplicate id', `${blk('alpha')}\n${blk('beta')}\n${blk('alpha')}`, 'alpha'],
    ['id with capital and underscore', blk('Bad_Id'), 'Bad_Id'],
    ['id with trailing dash', blk('bad-'), 'bad-'],
  ]
  for (const [label, md, name] of bad) {
    test(`throws an Error naming the branch: ${label}`, async () => {
      const { parseBranches } = await ledger()
      assert.throws(
        () => parseBranches(md),
        (e) => e instanceof Error && e.message.includes(name),
      )
    })
  }

  test('throws an Error when Opens names an id with no branch', async () => {
    const { parseBranches } = await ledger()
    assert.throws(
      () => parseBranches(`${blk('alpha', { Opens: 'ghost' })}\n${blk('beta')}`),
      (e) => e instanceof Error && (e.message.includes('alpha') || e.message.includes('ghost')),
    )
  })

  test('Opens may name a branch defined later in the file', async () => {
    const { parseBranches } = await ledger()
    assert.doesNotThrow(() => parseBranches(`${blk('alpha', { Opens: 'beta' })}\n${blk('beta', { Visit: 'opened' })}`))
  })
})

// ======================= Seam 3 =======================

describe('Seam 3: nextBranches and remainingBranches (section 5 candidate and batching rule)', () => {
  test('small size returns []', async () => {
    const { parseBranches, nextBranches } = await ledger()
    assert.deepEqual(nextBranches(parseBranches(SAMPLE), state({ size: 'small' }), 5), [])
  })

  test('stopped returns []', async () => {
    const { parseBranches, nextBranches } = await ledger()
    assert.deepEqual(nextBranches(parseBranches(SAMPLE), state({ stopped: true }), 5), [])
  })

  test('max below 1 throws RangeError', async () => {
    const { parseBranches, nextBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    assert.throws(() => nextBranches(bs, state(), 0), RangeError)
    assert.throws(() => nextBranches(bs, state(), -1), RangeError)
  })

  test('stops after the first returned branch that has Opens', async () => {
    const { parseBranches, nextBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    assert.deepEqual(ids(nextBranches(bs, state(), 10)), ['outcome', 'hosting'])
    assert.deepEqual(ids(nextBranches(bs, state({ visits: { outcome: { by: 'owner', note: 'x' } } }), 10)), ['hosting'])
  })

  test('caps at max', async () => {
    const { parseBranches, nextBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    const s = state({ packs: ['service'], visits: { hosting: { by: 'owner', note: 'x' }, integrations: { by: 'owner', note: 'x' } } })
    assert.deepEqual(ids(nextBranches(bs, s, 10)), ['outcome', 'secrets', 'authz'])
    assert.deepEqual(ids(nextBranches(bs, s, 2)), ['outcome', 'secrets'])
    assert.deepEqual(ids(nextBranches(bs, s, 1)), ['outcome'])
  })

  test('returns candidates in file order; the Opens branch is included, nothing after it', async () => {
    const { parseBranches, nextBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    const s = state({ packs: ['service'], visits: { outcome: { by: 'owner', note: 'x' }, hosting: { by: 'owner', note: 'x' } } })
    assert.deepEqual(ids(nextBranches(bs, s, 10)), ['integrations'])
    const s2 = state({ packs: ['service'], visits: { outcome: { by: 'owner', note: 'x' }, hosting: { by: 'owner', note: 'x' }, integrations: { by: 'owner', note: 'x' } } })
    assert.deepEqual(ids(nextBranches(bs, s2, 10)), ['secrets', 'authz'])
  })

  test('an opened-only branch appears only once its id is in opened', async () => {
    const { parseBranches, nextBranches, remainingBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    assert.ok(!ids(remainingBranches(bs, state({ size: 'large', packs: ['service'] }))).includes('environments'))
    assert.ok(!ids(remainingBranches(bs, state({ size: 'large', packs: ['service'] }))).includes('webhooks'))
    const s = state({ opened: ['environments'], visits: { outcome: { by: 'owner', note: 'x' }, hosting: { by: 'owner', note: 'x' } } })
    assert.deepEqual(ids(nextBranches(bs, s, 10)), ['environments', 'integrations'])
  })

  test('an opened id is a candidate even when its pack is not in packs', async () => {
    const { parseBranches, remainingBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    assert.ok(ids(remainingBranches(bs, state({ packs: [], opened: ['webhooks'] }))).includes('webhooks'))
  })

  test('a visits entry with any "by" removes the branch', async () => {
    const { parseBranches, remainingBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    for (const by of ['owner', 'closed', 'default', 'fact']) {
      const r = ids(remainingBranches(bs, state({ visits: { outcome: { by, note: 'n' } } })))
      assert.ok(!r.includes('outcome'), `by:${by} must remove outcome`)
    }
    const r = ids(remainingBranches(bs, state({ opened: ['environments'], visits: { environments: { by: 'closed', note: 'n' } } })))
    assert.ok(!r.includes('environments'), 'a visited opened branch is not a candidate')
  })

  test('a branch needs the size in its Visit; pack must be core or in packs', async () => {
    const { parseBranches, remainingBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    assert.deepEqual(ids(remainingBranches(bs, state())), ['outcome', 'hosting', 'integrations', 'secrets'])
    assert.deepEqual(ids(remainingBranches(bs, state({ packs: ['service'] }))), ['outcome', 'hosting', 'integrations', 'secrets', 'authz'])
    // browsers is large-only: absent at standard even with its pack
    assert.ok(!ids(remainingBranches(bs, state({ packs: ['frontend'] }))).includes('browsers'))
    assert.deepEqual(ids(remainingBranches(bs, state({ size: 'large', packs: ['frontend'] }))), ['outcome', 'hosting', 'cost', 'integrations', 'secrets', 'browsers'])
  })

  test('remainingBranches ignores stopped, the max cap and the Opens stop', async () => {
    const { parseBranches, remainingBranches, nextBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    const s = state({ stopped: true })
    assert.deepEqual(nextBranches(bs, s, 5), [])
    assert.deepEqual(ids(remainingBranches(bs, s)), ['outcome', 'hosting', 'integrations', 'secrets'])
    assert.equal(nextBranches(bs, state(), 1).length, 1)
  })
})

// ======================= Seam 4 =======================

describe('Seam 4: parseRequirements', () => {
  test("section 7's example has no errors, 2 requirements and 1 non-goal", async () => {
    const { parseRequirements } = await ledger()
    const r = parseRequirements(EXAMPLE)
    assert.deepEqual(r.errors, [])
    assert.equal(r.requirements.length, 2)
    assert.equal(r.nonGoals.length, 1)
  })

  test('a leading BOM and CRLF line ends change nothing', async () => {
    const { parseRequirements } = await ledger()
    const r = parseRequirements(`﻿${EXAMPLE.replace(/\n/g, '\r\n')}`)
    assert.deepEqual(r.errors, [])
    assert.equal(r.requirements.length, 2)
    assert.equal(r.nonGoals.length, 1)
  })

  test('more prose before the first ## is fine', async () => {
    assert.deepEqual(await errs(`# Requirements\n\nSome words.\nMore: words - and "- dashes".\n\n${req(1)}\n## Non-goals\n`), [])
  })

  test('Source: default, goal and repo:<path> are accepted', async () => {
    assert.deepEqual(await errs(doc(req(1, { Source: 'default' }), req(2, { Source: 'goal' }), req(3, { Source: 'repo:docs/x.md' }))), [])
  })

  test('Status open, met, dropped and replaced by a later id are accepted', async () => {
    assert.deepEqual(await errs(doc(req(1, { Status: 'met' }), req(2, { Status: 'dropped' }), req(3, { Status: 'replaced by R-4' }), req(4))), [])
  })

  test('RFC 3339 time with offset or fractional seconds is accepted; gaps in ids are fine', async () => {
    assert.deepEqual(await errs(doc(req(1, { Added: '2026-10-29T19:42:00+02:00 | g' }), req(5, { Added: '2026-10-29T19:42:00.123Z | g' }))), [])
  })

  test('Example may repeat; constraint needs neither Example nor Measure', async () => {
    assert.deepEqual(await errs(doc(req(1, { Kind: 'functional' }, ['Example: one', 'Example: two']), req(2))), [])
  })

  test('## Non-goals with zero lines is fine', async () => {
    const { parseRequirements } = await ledger()
    const r = parseRequirements(`# Requirements\n\n${req(1)}\n## Non-goals\n`)
    assert.deepEqual(r.errors, [])
    assert.equal(r.nonGoals.length, 0)
  })

  for (const f of ['Status', 'Kind', 'Added', 'Source']) {
    test(`missing ${f}`, async () => {
      assert.ok((await errs(doc(req(1, { [f]: undefined })))).includes(`R-1: missing ${f}`))
    })
  }

  const badCases: [string, Record<string, string>, string][] = [
    ['Status', { Status: 'done' }, 'done'],
    ['Status', { Status: 'replaced by 2' }, 'replaced by 2'],
    ['Kind', { Kind: 'feature' }, 'feature'],
    ['Added', { Added: '2026-10-29 19:42 | g' }, '2026-10-29 19:42 | g'],
    ['Added', { Added: 'yesterday | g' }, 'yesterday | g'],
    ['Added', { Added: '2026-10-29T19:42:00Z' }, '2026-10-29T19:42:00Z'],
    ['Source', { Source: 'guess' }, 'guess'],
  ]
  for (const [f, o, v] of badCases) {
    test(`bad ${f}: ${v}`, async () => {
      assert.ok((await errs(doc(req(1, o)))).includes(`R-1: bad ${f}: ${v}`))
    })
  }

  test('functional needs an Example', async () => {
    assert.ok((await errs(doc(req(1, { Kind: 'functional' })))).includes('R-1: functional needs an Example'))
  })

  test('nfr needs a Measure with a number', async () => {
    const e1 = await errs(doc(req(1, { Kind: 'nfr' }, ['Measure: fast enough'])))
    assert.ok(e1.includes('R-1: nfr needs a Measure with a number'))
    const e2 = await errs(doc(req(1, { Kind: 'nfr' })))
    assert.ok(e2.includes('R-1: nfr needs a Measure with a number'))
  })

  test('duplicate id', async () => {
    assert.ok((await errs(doc(req(1), req(1)))).includes('R-1: duplicate id'))
  })

  test('id out of order', async () => {
    assert.ok((await errs(doc(req(2), req(1)))).includes('R-1: id out of order'))
  })

  test('replaced by an id that is not in the file', async () => {
    assert.ok((await errs(doc(req(1, { Status: 'replaced by R-9' }), req(2)))).includes('R-1: replaced by unknown R-9'))
  })

  test('replaced by an earlier id is an error', async () => {
    assert.ok((await errs(doc(req(1), req(2, { Status: 'replaced by R-1' })))).includes('R-2: replaced by unknown R-1'))
  })

  const base = '# Requirements\n\n## R-1: T\nStatus: open\nKind: constraint\nAdded: 2026-10-29T19:42:00Z | g\nSource: owner\n'
  test('line <i>: unexpected: <text> for a stray line, 1-based', async () => {
    assert.ok((await errs(`${base}stray words\n\n## Non-goals\n- x\n`)).includes('line 8: unexpected: stray words'))
  })

  test('an unknown field line inside a requirement is unexpected', async () => {
    assert.ok((await errs(`${base}Colour: red\n\n## Non-goals\n- x\n`)).includes('line 8: unexpected: Colour: red'))
  })

  test('a non-"- " line under ## Non-goals is unexpected', async () => {
    assert.ok((await errs(`${base}\n## Non-goals\n- x\nnope\n`)).includes('line 11: unexpected: nope'))
  })

  test('line numbers and text are the same with CRLF and a BOM', async () => {
    const md = `﻿${base}stray words\n\n## Non-goals\n- x\n`.replace(/\n/g, '\r\n')
    assert.ok((await errs(md)).includes('line 8: unexpected: stray words'))
  })

  test('missing ## Non-goals', async () => {
    assert.ok((await errs(`# Requirements\n\n${req(1)}`)).includes('missing ## Non-goals'))
  })

  test('an unknown ## heading is an error', async () => {
    const e = await errs(`${doc(req(1))}\n## Other\n- x\n`)
    assert.ok(e.length > 0 && e.some((m) => m.includes('## Other')), `expected an error mentioning "## Other", got ${JSON.stringify(e)}`)
  })
})

describe('Seam 4: goalRequirementLines and checkTrace (behaviour fixed by the ADR)', () => {
  const LEDGER_MD = doc(req(1, {}, [], 'One'), req(2, {}, [], 'Two'), req(3, { Status: 'met' }, [], 'Three'), req(4, {}, [], 'Four'))

  test('checkTrace returns [] when every goal line matches an open requirement and every run id is covered', async () => {
    const { parseRequirements, checkTrace } = await ledger()
    const l = parseRequirements(LEDGER_MD)
    assert.deepEqual(checkTrace(l, ['R-1', 'R-2'], [{ name: 'g', text: '# G\n\n## Requirements\n- R-1: One\n- R-2: Two\n' }]), [])
  })

  test('checkTrace: exact strings, goals sorted by name, lines in file order, then run ids in order', async () => {
    const { parseRequirements, checkTrace } = await ledger()
    const l = parseRequirements(LEDGER_MD)
    const goals = [
      { name: 'b', text: '## Requirements\n- R-1: One\n- R-3: Three\n## Other\n- R-9: ignored\n' },
      { name: 'a', text: '# G\n\n## Requirements\n- R-9: Nine\n- R-2: Twox\n' },
    ]
    assert.deepEqual(checkTrace(l, ['R-1', 'R-5', 'R-4'], goals), [
      'TRACE: unknown R-9 in a',
      'TRACE: text differs R-2 in a',
      'TRACE: not open R-3 in b',
      'TRACE: run id not in ledger R-5',
      'TRACE: uncovered R-4',
    ])
  })
})

// ======================= Seam 5 =======================

describe('Seam 5: cli COMMANDS and main', () => {
  const range = (v: unknown): [number, number] | null => {
    if (Array.isArray(v) && typeof v[0] === 'number') return [v[0], v[1] ?? v[0]]
    if (typeof v === 'number') return [v, v]
    if (v && typeof v === 'object' && typeof v.min === 'number') return [v.min, v.max ?? v.min]
    return null
  }

  test('COMMANDS holds the arities: next 2-3, remaining 2, check 1, trace 3', async () => {
    const { COMMANDS } = await cli()
    const want: Record<string, [number, number]> = { next: [2, 3], remaining: [2, 2], check: [1, 1], trace: [3, 3] }
    for (const [c, w] of Object.entries(want)) {
      const got = range(COMMANDS[c])
      assert.ok(got, `cannot read an arity from COMMANDS.${c}: ${JSON.stringify(COMMANDS[c])}`)
      assert.deepEqual(got, w, `arity of ${c}`)
    }
  })

  test('exit 2 for an unknown command, no command, and wrong argument counts', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state()))
    const r = put(d, 'requirements.md', EXAMPLE)
    const cases: string[][] = [
      ['frobnicate', r],
      [],
      ['next', b],
      ['next', b, s, '3', 'extra'],
      ['remaining', b],
      ['remaining', b, s, 'extra'],
      ['check'],
      ['check', r, r],
      ['trace', r, s],
      ['trace', r, s, d, 'extra'],
    ]
    for (const argv of cases) assert.equal((await run(...argv)).code, 2, `argv ${JSON.stringify(argv)}`)
  })

  test('exit 2 for unreadable files', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state()))
    const nope = join(d, 'nope')
    assert.equal((await run('check', nope)).code, 2)
    assert.equal((await run('next', nope, s)).code, 2)
    assert.equal((await run('next', b, nope)).code, 2)
    assert.equal((await run('remaining', nope, s)).code, 2)
    assert.equal((await run('remaining', b, nope)).code, 2)
  })

  test('exit 2 for a branches parse error', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', blk('Bad_Id'))
    const s = put(d, 'interview.json', JSON.stringify(state()))
    assert.equal((await run('next', b, s, '3')).code, 2)
    assert.equal((await run('remaining', b, s)).code, 2)
  })

  const badStates: [string, Record<string, unknown>][] = [
    ['goal missing', { goal: undefined }],
    ['goal not a string', { goal: 5 }],
    ['size missing', { size: undefined }],
    ['size not one of the three', { size: 'tiny' }],
    ['packs missing', { packs: undefined }],
    ['packs not an array', { packs: 'core' }],
    ['opened missing', { opened: undefined }],
    ['opened not an array', { opened: 'environments' }],
    ['requirements missing', { requirements: undefined }],
    ['requirements not an array', { requirements: 'R-1' }],
    ['visits missing', { visits: undefined }],
    ['visits not an object', { visits: 'none' }],
    ['visits null', { visits: null }],
    ['stopped missing', { stopped: undefined }],
    ['stopped not a boolean', { stopped: 'no' }],
  ]
  for (const [label, over] of badStates) {
    test(`exit 2 for a bad state file: ${label}`, async () => {
      const d = tmp()
      const b = put(d, 'branches.md', SAMPLE)
      const s = put(d, 'interview.json', JSON.stringify(state(over)))
      assert.equal((await run('next', b, s, '3')).code, 2)
      assert.equal((await run('remaining', b, s)).code, 2)
    })
  }

  test('exit 2 for a state file that is not JSON', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', '{not json')
    assert.equal((await run('next', b, s, '3')).code, 2)
  })

  test('size small and large are valid states', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    for (const size of ['small', 'standard', 'large']) {
      const s = put(d, `${size}.json`, JSON.stringify(state({ size })))
      assert.equal((await run('next', b, s, '3')).code, 0, size)
    }
  })

  test('next prints exact NEXT lines for the batch, comma-and-space ids, exit 0', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state()))
    const r = await run('next', b, s, '3')
    assert.equal(r.code, 0)
    assert.deepEqual(lines(r), [
      'NEXT: outcome | core | What is it for? | the goal text | opens: none',
      'NEXT: hosting | core | Where does it run? | what the repo deploys to | opens: environments, cost',
    ])
  })

  test('next works with two arguments', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state()))
    const r = await run('next', b, s)
    assert.equal(r.code, 0)
    assert.ok(lines(r).length >= 1 && lines(r)[0].startsWith('NEXT: outcome | core |'))
  })

  test('next honours the max argument', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state({ visits: { hosting: { by: 'owner', note: 'x' }, integrations: { by: 'owner', note: 'x' } } })))
    assert.deepEqual(lines(await run('next', b, s, '1')), ['NEXT: outcome | core | What is it for? | the goal text | opens: none'])
  })

  test('next prints NEXT: none when stopped, small, or nothing is left', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const all = Object.fromEntries(['outcome', 'hosting', 'integrations', 'secrets'].map((i) => [i, { by: 'owner', note: 'x' }]))
    for (const over of [{ stopped: true }, { size: 'small' }, { visits: all }]) {
      const s = put(d, 'interview.json', JSON.stringify(state(over)))
      const r = await run('next', b, s, '3')
      assert.equal(r.code, 0)
      assert.deepEqual(lines(r), ['NEXT: none'], JSON.stringify(over))
    }
  })

  test('remaining prints every remaining branch uncapped, even when stopped', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state({ stopped: true })))
    const r = await run('remaining', b, s)
    assert.equal(r.code, 0)
    assert.deepEqual(lines(r), [
      'NEXT: outcome | core | What is it for? | the goal text | opens: none',
      'NEXT: hosting | core | Where does it run? | what the repo deploys to | opens: environments, cost',
      'NEXT: integrations | core | Which services does it call? | the SDKs in use | opens: webhooks, secrets',
      'NEXT: secrets | core | Where do secrets live? | the existing vault | opens: none',
    ])
  })

  test('remaining prints NEXT: none when nothing remains', async () => {
    const d = tmp()
    const b = put(d, 'branches.md', SAMPLE)
    const all = Object.fromEntries(['outcome', 'hosting', 'integrations', 'secrets'].map((i) => [i, { by: 'default', note: 'x' }]))
    const s = put(d, 'interview.json', JSON.stringify(state({ stopped: true, visits: all })))
    const r = await run('remaining', b, s)
    assert.equal(r.code, 0)
    assert.deepEqual(lines(r), ['NEXT: none'])
  })

  test('check prints OK with counts on the example, exit 0', async () => {
    const d = tmp()
    const r = await run('check', put(d, 'requirements.md', EXAMPLE))
    assert.equal(r.code, 0)
    assert.deepEqual(lines(r), ['OK: 2 requirements, 1 non-goals'])
  })

  test('check prints one ERROR line per error, exit 1', async () => {
    const d = tmp()
    const md = doc(req(1, { Status: undefined }), req(2, { Source: 'x' }))
    const r = await run('check', put(d, 'requirements.md', md))
    assert.equal(r.code, 1)
    assert.deepEqual(lines(r), ['ERROR: R-1: missing Status', 'ERROR: R-2: bad Source: x'])
  })

  test('check exits 2 for an unreadable file', async () => {
    assert.equal((await run('check', join(tmp(), 'nope.md'))).code, 2)
  })
})

describe('Seam 5: running cli.ts as a script', () => {
  test('as the entry script it runs main: stdout has OK:, exit 0', () => {
    const d = tmp()
    const r = spawnSync(process.execPath, [CLI_PATH, 'check', put(d, 'requirements.md', EXAMPLE)], { encoding: 'utf8' })
    assert.equal(r.status, 0, `status ${r.status}: ${r.stderr}`)
    assert.match(r.stdout, /OK: 2 requirements, 1 non-goals/)
  })

  test('as the entry script a ledger error gives exit 1 and ERROR on stdout', () => {
    const d = tmp()
    const r = spawnSync(process.execPath, [CLI_PATH, 'check', put(d, 'requirements.md', doc(req(1, { Kind: undefined })))], { encoding: 'utf8' })
    assert.equal(r.status, 1, `status ${r.status}: ${r.stderr}`)
    assert.match(r.stdout, /ERROR: R-1: missing Kind/)
  })

  test('as the entry script a usage error gives exit 2', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'frobnicate'], { encoding: 'utf8' })
    assert.equal(r.status, 2, `status ${r.status}: ${r.stderr}`)
  })

  test('importing cli.ts does not run main or print', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(CLI_PATH).href)})`], { encoding: 'utf8' })
    assert.equal(r.status, 0, `status ${r.status}: ${r.stderr}`)
    assert.equal(r.stdout, '')
  })
})

// ======================= lead-pinned =======================

describe('lead-pinned shapes (ADR leaves open)', () => {
  test('branch object: { id, pack, visit[], fact?, ask, recommend, writes, opens[] }', async () => {
    const { parseBranches } = await ledger()
    const bs = parseBranches(SAMPLE)
    const out = bs.find((b) => b.id === 'outcome')
    const hosting = bs.find((b) => b.id === 'hosting')
    const env = bs.find((b) => b.id === 'environments')
    assert.equal(out.pack, 'core')
    assert.deepEqual([...out.visit], ['standard', 'large'])
    assert.equal(out.fact, 'README, docs/')
    assert.equal(out.ask, 'What is it for?')
    assert.equal(out.recommend, 'the goal text')
    assert.equal(out.writes, 'functional')
    assert.deepEqual([...out.opens], [])
    assert.deepEqual([...hosting.opens], ['environments', 'cost'])
    assert.equal(hosting.fact, undefined)
    assert.deepEqual([...env.visit], ['opened'])
  })

  test('parseBranches accepts a title and prose before the first ## section', async () => {
    const { parseBranches } = await ledger()
    assert.equal(parseBranches(`# Interview branches\n\nSome prose.\n\n${blk('alpha')}`).length, 1)
  })

  test('parseRequirements item shape and nonGoals', async () => {
    const { parseRequirements } = await ledger()
    const r = parseRequirements(EXAMPLE)
    const [a, b] = r.requirements
    assert.equal(a.id, 'R-1')
    assert.equal(a.n, 1)
    assert.equal(a.title, 'Owners can export their invoices as CSV')
    assert.equal(a.status, 'open')
    assert.equal(a.kind, 'functional')
    assert.equal(a.added, '2026-10-29T19:42:00Z | add invoice export')
    assert.equal(a.source, 'owner')
    assert.deepEqual([...a.examples], ['Given an account with 3 invoices, when the owner clicks Export, then a CSV with 3 rows downloads.'])
    assert.equal(b.id, 'R-2')
    assert.equal(b.n, 2)
    assert.equal(b.kind, 'nfr')
    assert.equal(b.source, 'default')
    assert.equal(b.measure, 'p95 under 5 s at 10,000 invoices')
    assert.deepEqual([...b.examples], [])
    assert.deepEqual([...r.nonGoals], ['No PDF export.'])
  })

  test('an unknown ## heading error reads line <i>: unexpected: ## Other', async () => {
    const md = `${doc(req(1))}\n## Other\n- x\n`
    const at = md.split('\n').indexOf('## Other') + 1
    assert.ok((await errs(md)).includes(`line ${at}: unexpected: ## Other`))
  })

  test('goalRequirementLines returns { id, title }[] from the ## Requirements section only', async () => {
    const { goalRequirementLines } = await ledger()
    const text = '# Goal\n\n- R-7: not here\n\n## Requirements\n- R-1: One\n- R-12: Twelve things\n\n## Notes\n- R-3: not here either\n'
    assert.deepEqual(
      goalRequirementLines(text).map((x) => ({ id: x.id, title: x.title })),
      [
        { id: 'R-1', title: 'One' },
        { id: 'R-12', title: 'Twelve things' },
      ],
    )
    assert.deepEqual(goalRequirementLines('# Goal\n\nNo section.\n'), [])
  })

  test('cli trace: OK line and exit 0 over every *.md in the goals dir', async () => {
    const d = tmp()
    const req_ = put(d, 'requirements.md', EXAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state({ requirements: ['R-1', 'R-2'] })))
    put(d, 'goals/alpha.md', '# A\n\n## Requirements\n- R-1: Owners can export their invoices as CSV\n')
    put(d, 'goals/beta.md', '# B\n\n## Requirements\n- R-2: The export finishes quickly for large accounts\n')
    put(d, 'goals/notes.txt', '- R-9: ignored, not markdown\n')
    const r = await run('trace', req_, s, join(d, 'goals'))
    assert.equal(r.code, 0, JSON.stringify(lines(r)))
    assert.deepEqual(lines(r), ['OK: 2 requirements traced to 2 goal files'])
  })

  test('cli trace: TRACE lines, name is the file name without .md, exit 1', async () => {
    const d = tmp()
    const req_ = put(d, 'requirements.md', EXAMPLE)
    const s = put(d, 'interview.json', JSON.stringify(state({ requirements: ['R-1', 'R-2'] })))
    put(d, 'goals/alpha.md', '## Requirements\n- R-1: Owners can export their invoices as CSV\n- R-9: Nine\n')
    const r = await run('trace', req_, s, join(d, 'goals'))
    assert.equal(r.code, 1)
    assert.deepEqual(lines(r), ['TRACE: unknown R-9 in alpha', 'TRACE: uncovered R-2'])
  })

  test('cli trace: exit 2 for a bad state file or unreadable requirements', async () => {
    const d = tmp()
    const req_ = put(d, 'requirements.md', EXAMPLE)
    put(d, 'goals/alpha.md', '## Requirements\n')
    const bad = put(d, 'bad.json', JSON.stringify(state({ requirements: 'R-1' })))
    assert.equal((await run('trace', req_, bad, join(d, 'goals'))).code, 2)
    const ok = put(d, 'ok.json', JSON.stringify(state()))
    assert.equal((await run('trace', join(d, 'nope.md'), ok, join(d, 'goals'))).code, 2)
  })
})
