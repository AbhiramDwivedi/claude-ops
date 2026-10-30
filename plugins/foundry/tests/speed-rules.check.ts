// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry speed-rules goal: six prose rules, pinned before the prompts change.
// Each test needs the new rule's key phrase present AND the superseded sentence gone.
//
// Run with: node --test plugins/foundry/tests/speed-rules.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
// markdown noise (backticks, bold) dropped and whitespace collapsed, so line wraps and formatting don't matter
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/[`*]/g, '').replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
const LEAD = read('agents', 'lead.md')
const JUDGE = read('agents', 'judge.md')
const ARCH = read('agents', 'architect.md')
const RUN = read('skills', 'run', 'SKILL.md')

const has = (text: string, re: RegExp, what: string) => assert.match(text, re, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `superseded text still there: ${what}`)

describe('speed-rules', () => {
  test('1 red team: one round, DEFECT/GAP, mkdtemp clone, high-impact crews only', () => {
    has(LEAD, /(one|1|a single) red[- ]team round/i, 'lead: one red-team round')
    has(LEAD, /at most (once|one more|a single|1)|only once|at most one (re-?run|more)/i, 'lead: rerun at most once')
    has(LEAD, /real[- ]defect|\bDEFECT\b/i, 'lead: rerun only after a real-defect fix')
    has(JUDGE, /\bDEFECT\b/, 'judge: DEFECT label')
    has(JUDGE, /\bGAP\b/, 'judge: GAP label')
    has(JUDGE, /end-of-run/i, 'judge: GAPs go to the end-of-run list')
    has(JUDGE, /mkdtemp/i, 'judge: probes in a mkdtemp clone')
    has(JUDGE, /GIT_\w*/, 'judge: GIT_* variables')
    has(JUDGE, /unset/i, 'judge: GIT_* unset')
    has(RUN + LEAD, /red team[^.]{0,120}(high-impact|hooks, gates, merge)|(high-impact|hooks, gates, merge)[^.]{0,120}red team/i, 'red team only for high-impact crews')
    gone(LEAD, /After the fixes, run a fresh red team/i, 'lead: "After the fixes, run a fresh red team"')
    gone(LEAD, /Have every break it reports fixed/i, 'lead: "Have every break it reports fixed"')
  })

  test('2 dependency-driven start: after list, no wave hold, start every turn', () => {
    has(RUN, /every crew in its after list (has|have|is) (merged|\w+ or \w+)/i, 'crew starts when every crew in its after list has merged')
    has(RUN, /maxParallelCrews/, 'cap kept')
    has(RUN, /(every|each|end of) turn[^.]{0,160}start(ing)? (any|every|each) (startable|ready)|start(ing)? (any|every|each) (startable|ready)[^.]{0,120}(every|each) turn/i, 'foreman ends every turn by starting any startable crew')
    has(RUN, /disjoint/i, 'no wave-batch hold for disjoint owned files')
    gone(RUN, /A wave starts only when every crew in every earlier wave/i, 'run: "A wave starts only when every crew in every earlier wave"')
    gone(RUN, /When the whole wave has merged, start the next wave/i, 'run: "When the whole wave has merged, start the next wave"')
  })

  test('3 foreman never blocks: no AskUserQuestion while a crew runs; lead proceeds on its recommendation', () => {
    has(RUN, /(never|not|no|don.t)[^.]{0,80}AskUserQuestion[^.]{0,120}(crew|crews)[^.]{0,40}(runs?|running)|AskUserQuestion[^.]{0,80}(while|when)[^.]{0,40}(any )?crews? (is |are )?(running|runs)/i, 'run: no AskUserQuestion while any crew runs')
    has(RUN, /plain text/i, 'run: ask in plain text')
    has(RUN, /notifications?/i, 'run: keep handling notifications')
    has(LEAD, /recommended option/i, 'lead: proceeds on recommended option')
    has(LEAD, /different file sets/i, 'lead: stops only when options lead to different file sets')
    has(LEAD, /record(s|ed)?[^.]{0,60}(in|on) (your|its) (final )?report/i, 'lead: records the choice in its report')
    gone(LEAD, /Then wait; the answer arrives as a message/i, 'lead: "Then wait; the answer arrives as a message"')
  })

  test('4 design crews: ADR word budget, seams in goal files, one FAIL round', () => {
    has(ARCH, /3,?000 words/i, 'architect: 3,000-word budget per ADR')
    has(ARCH, /seams[^.]{0,120}(build crews?.{0,3}|crews?.{0,3}) goal files?|goal files?[^.]{0,120}seams/i, 'architect: seams go in the build crews goal files')
    has(LEAD, /design crew[^.]{0,200}(one|1) FAIL round|(one|1) FAIL round[^.]{0,200}design crew/i, 'lead: design crew gets one FAIL round')
    has(LEAD, /(only|just) bug findings|bug findings[^.]{0,80}(only|fixed)/i, 'lead: after it only bug findings are fixed')
    has(LEAD, /same writer/i, 'lead: fixed by the same writer')
    has(LEAD, /deferred?/i, 'lead: the rest are deferred')
    gone(ARCH, /The seams the crew.s test-writer must pin with contract tests/i, 'architect: seams the test-writer must pin, as an ADR/design output')
  })

  test('5 planning one round: empty-implementation self-check, parallel cynic review', () => {
    has(ARCH, /empty implementation/i, 'architect: checks every done-check against an empty implementation')
    has(RUN, /cynic[^.]{0,200}in parallel[^.]{0,120}(approval|plan)|in parallel with[^.]{0,80}(plan )?approval/i, 'run: cynic review in parallel with plan approval')
    has(RUN, /not a gate|isn.t a gate|no gate|never a gate|doesn.t gate|does not gate/i, 'run: the cynic review is not a gate')
    has(RUN, /gameable/i, 'run: send back only for a gameable done-check')
    gone(RUN, /the architect gets one round to reconcile/i, 'run: "the architect gets one round to reconcile" after a cynic disagree')
    gone(RUN, /the reconcile round has happened/i, 'run: "the reconcile round has happened"')
  })

  test('6 flatten small crews: at most 2 members and no red team runs without a lead', () => {
    has(RUN, /at most (2|two) members|(2|two) members or (fewer|less)/i, 'run: crew of at most 2 members')
    has(RUN, /no lead|without a lead/i, 'run: no lead')
    has(RUN, /foreman[^.]{0,120}(directly|itself)[^.]{0,200}(test-writer|builder|judge)|(directly|itself)[^.]{0,200}test-writer[^.]{0,80}builder[^.]{0,80}judge/i, 'run: foreman runs test-writer, builder, judge directly')
    has(RUN, /no red team/i, 'run: only crews with no red team')
    has(RUN, /Head\/Patch|patch id|merge gate/i, 'run: Head/Patch rules and merge gate kept')
  })
})
