// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry stability-fixes goal, items 1 and 3: key phrase present AND superseded sentence gone.
//
// Run with: node --test plugins/foundry/tests/stability-fixes.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/[`*]/g, '').replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
const LEAD = read('agents', 'lead.md')
const CYNIC = read('agents', 'cynic.md')
const WAVE = read('workflows', 'wave.js')

const has = (text: string, re: RegExp, what: string) => assert.match(text, re, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `still present: ${what}`)

describe('item 1: no-polling rule in every member brief', () => {
  const RULE = /runs? each long command once with run_in_background and waits? for its completion notification/i
  test('lead.md member-brief list carries the rule', () => {
    has(LEAD, RULE, 'no-polling rule')
    has(LEAD, /no polling loops, no sleep, no relaunching waiters/i, 'no polling loops, no sleep')
    has(LEAD, /never a shared temp path/i, 'no shared temp path')
  })
  test('wave.js memberPrompt carries the same rule', () => {
    has(WAVE, RULE, 'no-polling rule in wave.js')
    has(WAVE, /no polling loops, no sleep, no relaunching waiters/i, 'no polling loops in wave.js')
    has(WAVE, /never a shared temp path/i, 'no shared temp path in wave.js')
  })
})

describe('item 3: cynic.md agrees with the planning rule in run/SKILL.md', () => {
  test('the one-round reconcile and fresh-cynic sentence is gone', () => {
    gone(CYNIC, /gives the architect one round to reconcile, then may start a fresh cynic/, 'superseded reconcile sentence')
    gone(CYNIC, /still disagree after that round/, 'superseded first owner trigger')
    gone(CYNIC, /your brief says when the round has happened/, 'superseded round remark')
  })
  test('a disagreement does not send the plan back; the owner trigger is an unsettled disagreement', () => {
    has(CYNIC, /does not send the plan back/i, 'a disagree does not send the plan back')
    has(CYNIC, /architect's reason doesn't settle it/, 'owner trigger: architect reason does not settle it')
  })
})
