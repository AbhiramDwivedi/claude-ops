// @ts-nocheck
// foundry ADR-0007 Seams (contract-replaced): each wording check listed under `## Checks replaced` is gone from its
// file, and what covers it exists. Red until wave 2 (prompt-rules) deletes the checks. Imports nothing from evals/:
// it must fail on assertions, never on a missing module.
//
// Run with: node --test plugins/foundry/tests/contract-replaced.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ADR = readFileSync(join(ROOT, 'plugins', 'foundry', 'docs', 'adr', '0007-behaviour-evals.md'), 'utf8').replace(/\r/g, '')

// the lines after `## <heading>` up to the next line that starts with `## `
const section = (heading: string): string[] => {
  const all = ADR.split('\n')
  const at = all.indexOf(`## ${heading}`)
  if (at < 0) return []
  const rest = all.slice(at + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return end < 0 ? rest : rest.slice(0, end)
}

const LINE = /^- (plugins\/foundry\/tests\/[^:]+\.check\.ts): (.+) \(covered by (.+)\)$/
const CASE_REF = /^case ([a-z0-9]+(?:-[a-z0-9]+)*(?:, [a-z0-9]+(?:-[a-z0-9]+)*)*)$/
const SNIPPET_REF = /^snippet (\S+\.md): `([^`]+)`$/
const SNIPPET_LINE = /^- (plugins\/foundry\/\S+\.md): `([^`]+)` \((?:fenced|inline); placeholders: .+\)$/

const entries = section('Checks replaced')
  .filter((l) => l.startsWith('- '))
  .map((l) => {
    const m = LINE.exec(l)
    assert.ok(m, `malformed Checks replaced line: ${l}`)
    return { line: l, file: m[1], name: m[2], ref: m[3] }
  })
const snippetLines = section('Snippets').flatMap((l) => {
  const m = SNIPPET_LINE.exec(l)
  return m ? [{ file: m[1], opening: m[2] }] : []
})

test('ADR-0007 lists at least one replaced check', () => {
  assert.ok(entries.length >= 1, 'no lines under ## Checks replaced')
})

test('every ref is a case ref or a snippet ref of the ADR grammar', () => {
  assert.ok(entries.length >= 1, 'no lines under ## Checks replaced')
  for (const e of entries) assert.ok(CASE_REF.test(e.ref) || SNIPPET_REF.test(e.ref), `bad ref: ${e.line}`)
})

for (const e of entries) {
  test(`replaced and covered: ${e.file}: ${e.name}`, () => {
    // the test name is gone from its file (as '<name>', "<name>" or `<name>`), or the file is gone
    const path = join(ROOT, e.file)
    if (existsSync(path)) {
      const src = readFileSync(path, 'utf8')
      for (const q of ["'", '"', '`']) assert.ok(!src.includes(`${q}${e.name}${q}`), `${e.file} still holds the test ${q}${e.name}${q}`)
    }
    // its covering ref exists
    const c = CASE_REF.exec(e.ref)
    const s = SNIPPET_REF.exec(e.ref)
    if (c) {
      for (const id of c[1].split(', ')) assert.ok(existsSync(join(ROOT, 'plugins', 'foundry', 'evals', 'golden', `${id}.json`)), `no golden case ${id}`)
    } else {
      assert.ok(s, `bad ref: ${e.ref}`)
      assert.ok(snippetLines.some((l) => l.file === s[1] && l.opening === s[2]), `no ## Snippets line for ${s[1]}: \`${s[2]}\``)
    }
  })
}
