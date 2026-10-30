// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0008 Seam 6: contract test for skills/interview/branches.md and skills/interview/SKILL.md.
// Written from the ADR before either file exists. Checks structure through the merged interview/ledger.ts
// (parseBranches, remainingBranches, parseRequirements) and cli.ts COMMANDS; no whole-file wording greps.
//
// Run with: node --test plugins/foundry/tests/interview-skill.check.ts
// The files under test are read inside each test, so a missing file fails that test with a clear message.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRANCHES_PATH = join(PLUGIN, 'skills', 'interview', 'branches.md')
const SKILL_PATH = join(PLUGIN, 'skills', 'interview', 'SKILL.md')
const LEDGER_URL = pathToFileURL(join(PLUGIN, 'interview', 'ledger.ts')).href
const CLI_URL = pathToFileURL(join(PLUGIN, 'interview', 'cli.ts')).href

const read = (path: string, what: string): string => {
  try {
    return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r/g, '')
  } catch (e) {
    assert.fail(`producer missing: ${what} (${e?.code ?? e?.message})`)
  }
}
const ledger = async () => {
  try {
    return await import(LEDGER_URL)
  } catch (e) {
    assert.fail(`producer missing: interview/ledger.ts (${e?.code ?? e?.message})`)
  }
}
const cliModule = async () => {
  try {
    return await import(CLI_URL)
  } catch (e) {
    assert.fail(`producer missing: interview/cli.ts (${e?.code ?? e?.message})`)
  }
}
const parsed = async () => {
  const l = await ledger()
  const branches = l.parseBranches(read(BRANCHES_PATH, 'skills/interview/branches.md'))
  return { l, branches, byId: new Map(branches.map((b) => [b.id, b])) }
}
const skill = () => read(SKILL_PATH, 'skills/interview/SKILL.md')

// every ``` fence: { info, body }
const fences = (md: string): { info: string; body: string }[] => {
  const out = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,})(.*)$/.exec(lines[i])
    if (!m) continue
    const body = []
    let j = i + 1
    while (j < lines.length && !new RegExp(`^\\s*${m[1]}\\s*$`).test(lines[j])) body.push(lines[j++])
    out.push({ info: m[2].trim(), body: body.join('\n') })
    i = j
  }
  return out
}

const SECTION5 = {
  core: ['outcome', 'users', 'acceptance', 'non-goals', 'hosting', 'environments', 'integrations', 'auth', 'secrets', 'data-sensitivity', 'scale', 'latency', 'availability', 'cost', 'compliance'],
  service: ['authz', 'idempotency', 'rate-limits', 'webhooks'],
  frontend: ['browsers', 'accessibility', 'i18n'],
  data: ['retention', 'backfill', 'lineage'],
  ai: ['model-choice', 'eval-set', 'model-cost'],
  infra: ['iac', 'regions', 'ci-cd'],
  library: ['consumers', 'versioning'],
}

const state = (over = {}) => ({ goal: 'g', size: 'standard', packs: ['core'], opened: [], requirements: [], visits: {}, stopped: false, ...over })
const openedOnly = (branches) => branches.filter((x) => x.visit.length === 1 && x.visit[0] === 'opened')

describe('branches.md', () => {
  test('parses with parseBranches; holds every section 5 id with its pack', async () => {
    const { byId } = await parsed()
    for (const [pack, ids] of Object.entries(SECTION5))
      for (const id of ids) {
        assert.ok(byId.has(id), `branch missing: ${id}`)
        assert.equal(byId.get(id).pack, pack, `${id} pack`)
      }
  })

  test('every pack in PACKS has a branch; each non-core pack has at least two', async () => {
    const { l, branches } = await parsed()
    for (const pack of l.PACKS) {
      const n = branches.filter((b) => b.pack === pack).length
      assert.ok(n >= 1, `no branch for pack ${pack}`)
      if (pack !== 'core') assert.ok(n >= 2, `pack ${pack} has ${n} branch(es), need 2`)
    }
  })

  test("section 5's Opens edges are present", async () => {
    const { byId } = await parsed()
    const edges = { hosting: ['environments', 'cost'], integrations: ['webhooks', 'secrets'], auth: ['authz'], 'data-sensitivity': ['compliance', 'retention'] }
    for (const [from, tos] of Object.entries(edges))
      for (const to of tos) assert.ok(byId.get(from)?.opens.includes(to), `${from} should open ${to}`)
  })

  test('no branch lists small in Visit; no opened-only branch is unreachable', async () => {
    const { branches } = await parsed()
    for (const b of branches) assert.ok(!b.visit.includes('small'), `${b.id} visits small`)
    for (const b of openedOnly(branches))
      assert.ok(
        branches.some((o) => o.id !== b.id && o.opens.includes(b.id)),
        `${b.id} is opened-only but no other branch opens it`,
      )
  })

  test('ledger behaviour: remaining holds only core or listed-pack branches; opened-only ones appear only once opened', async () => {
    const { l, branches } = await parsed()
    const allPacks = [...l.PACKS]
    const rem = l.remainingBranches(branches, state({ size: 'standard', packs: allPacks }))
    assert.ok(rem.length > 0, 'remaining is empty at size standard')
    for (const b of rem) assert.ok(allPacks.includes(b.pack), `${b.id} has pack ${b.pack}`)
    const coreOnly = l.remainingBranches(branches, state({ size: 'large', packs: ['core'] }))
    for (const b of coreOnly) assert.ok(b.pack === 'core', `${b.id} (${b.pack}) leaked into a core-only run`)
    for (const b of openedOnly(branches)) {
      const without = l.remainingBranches(branches, state({ size: 'large', packs: allPacks }))
      assert.ok(!without.some((x) => x.id === b.id), `${b.id} is opened-only but a candidate while unopened`)
      const withIt = l.remainingBranches(branches, state({ size: 'large', packs: allPacks, opened: [b.id] }))
      assert.ok(withIt.some((x) => x.id === b.id), `${b.id} not a candidate once opened`)
    }
  })

  test('ledger behaviour: visiting hosting removes it and the branches it opened become candidates', async () => {
    const { l, branches, byId } = await parsed()
    const hosting = byId.get('hosting')
    assert.ok(hosting, 'hosting missing')
    for (const size of ['standard', 'large']) {
      const s = state({ size, visits: { hosting: { by: 'owner', note: 'x' } }, opened: hosting.opens })
      const rem = l.remainingBranches(branches, s).map((b) => b.id)
      assert.ok(!rem.includes('hosting'), `hosting still remaining at ${size}`)
      for (const id of ['environments', 'cost']) assert.ok(rem.includes(id), `${id} not a candidate after hosting opened it (${size})`)
      const next = l.nextBranches(branches, s, 3)
      assert.ok(next.length >= 1 && next.length <= 3)
      assert.ok(!next.some((b) => b.id === 'hosting'))
    }
    for (const by of ['owner', 'closed', 'default', 'fact']) {
      const rem = l.remainingBranches(branches, state({ visits: { hosting: { by, note: 'n' } } }))
      assert.ok(!rem.some((b) => b.id === 'hosting'), `visit by ${by} did not remove hosting`)
    }
  })

  test('Commit, scrubbed: the hosting and integrations questions say requirements.md is committed', async () => {
    const { byId } = await parsed()
    for (const id of ['hosting', 'integrations']) {
      const ask = (byId.get(id)?.ask ?? '').toLowerCase()
      assert.ok(ask.includes('requirements.md'), `${id} ask does not mention requirements.md`)
      assert.ok(ask.includes('committed'), `${id} ask does not say the file is committed`)
    }
  })

  test('Writes kinds follow section 7', async () => {
    const { byId } = await parsed()
    const want = { constraint: ['hosting', 'integrations', 'auth', 'secrets', 'data-sensitivity', 'compliance'], nfr: ['scale', 'latency', 'availability', 'cost'], 'non-goal': ['non-goals'] }
    for (const [kind, ids] of Object.entries(want)) for (const id of ids) assert.equal(byId.get(id)?.writes, kind, `${id} writes`)
  })
})

describe('SKILL.md', () => {
  test('frontmatter has name: interview and a non-empty description', () => {
    const fm = /^---\n([\s\S]*?)\n---/.exec(skill())
    assert.ok(fm, 'no frontmatter')
    assert.match(fm[1], /^name:\s*interview\s*$/m)
    assert.match(fm[1], /^description:\s*\S/m)
  })

  test('first # Requirements fence parses with no errors and has a functional, an nfr and a non-goal', async () => {
    const l = await ledger()
    const f = fences(skill()).find((x) => x.body.trimStart().startsWith('# Requirements'))
    assert.ok(f, 'no fence starting # Requirements')
    const out = l.parseRequirements(f.body)
    assert.deepEqual(out.errors, [])
    assert.ok(out.requirements.some((r) => r.kind === 'functional'), 'no functional requirement')
    assert.ok(out.requirements.some((r) => r.kind === 'nfr'), 'no nfr requirement')
    assert.ok(out.nonGoals.length >= 1, 'no non-goal')
  })

  const invocations = () => {
    const out = []
    for (const line of skill().split('\n')) {
      const re = /interview\/cli\.ts\s+([A-Za-z][\w-]*)([^`\n]*)/g
      let m
      while ((m = re.exec(line))) {
        const args = (m[2].match(/(?:<[^>]*>|[^\s<])+/g) ?? []).filter((t) => t !== '\\')
        out.push({ command: m[1], args })
      }
    }
    return out
  }

  test('every interview/cli.ts command named is in COMMANDS; next, remaining and check are named', async () => {
    const { COMMANDS } = await cliModule()
    const inv = invocations()
    assert.ok(inv.length > 0, 'SKILL.md names no interview/cli.ts command')
    for (const { command } of inv) assert.ok(Object.hasOwn(COMMANDS, command), `unknown command: ${command}`)
    const names = new Set(inv.map((i) => i.command))
    for (const c of ['next', 'remaining', 'check']) assert.ok(names.has(c), `SKILL.md never names ${c}`)
  })

  test('each next invocation passes max as an integer from 1 to 3 when it gives one', () => {
    const nexts = invocations().filter((i) => i.command === 'next')
    assert.ok(nexts.length > 0, 'no next invocation')
    for (const { args } of nexts) if (args.length >= 3) assert.match(args[2], /^[123]$/, `next max is ${args[2]}`)
  })

  test('every Agent({ fence sets model sonnet|opus and effort low|medium; one is interview-facts on sonnet/low', () => {
    const agents = fences(skill()).filter((f) => f.body.trimStart().startsWith('Agent({'))
    assert.ok(agents.length >= 1, 'no Agent({ fence')
    for (const f of agents) {
      assert.match(f.body, /\bmodel:\s*"(sonnet|opus)"/, 'Agent fence model')
      assert.match(f.body, /\beffort:\s*"(low|medium)"/, 'Agent fence effort')
    }
    const facts = agents.find((f) => /\bname:\s*"interview-facts"/.test(f.body))
    assert.ok(facts, 'no interview-facts Agent fence')
    assert.match(facts.body, /\bmodel:\s*"sonnet"/)
    assert.match(facts.body, /\beffort:\s*"low"/)
  })

  test('Fill with defaults: the Stop the interview section writes Source: default and runs remaining', () => {
    const sections = skill().split(/^## /m)
    assert.ok(
      sections.some((s) => s.includes('Stop the interview') && s.includes('Source: default') && s.includes('remaining')),
      'no section holds Stop the interview, Source: default and remaining together',
    )
  })
})
