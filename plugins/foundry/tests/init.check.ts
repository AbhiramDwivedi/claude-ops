// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry 0.4.1: init never sets kit up itself (foundry ADR-0002, amendment of 2026-10-27)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const init = readFileSync(new URL('../skills/init/SKILL.md', import.meta.url), 'utf8')
const NO_MANIFEST = 'no kit manifest; foundry init carries on without one (run /kit:init on its own to set kit up)'

test('init prints the no-manifest line and does not run kit:init without a manifest', () => {
  assert.ok(init.includes(NO_MANIFEST))
  assert.ok(init.includes("**Missing, and `kit:init` is among the session's skills:** don't run `kit:init`"))
  assert.ok(!init.includes('kit sets the project up'))
})

test('init still runs kit:init with the declare args when a manifest lacks the declarations', () => {
  assert.ok(init.includes("**Readable without the declarations, and `kit:init` is among the session's skills:** run it"))
})

test('the README and ADR-0002 carry the same no-manifest line', () => {
  for (const f of ['../README.md', '../docs/adr/0002-kit-manifest-and-config.md']) {
    assert.ok(readFileSync(new URL(f, import.meta.url), 'utf8').includes(NO_MANIFEST), f)
  }
})
