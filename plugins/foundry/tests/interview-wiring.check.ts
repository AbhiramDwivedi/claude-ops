// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0008 "Files touched": the prose that wires the interview skill into run, architect, init and README.
// Written from the ADR before the prose exists. Each new-wiring test slices the file to the section the ADR names,
// so a phrase in the wrong section fails. Regexes tolerate wording (case, spacing) but not absence.
//
// Run with: node --test plugins/foundry/tests/interview-wiring.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...p), 'utf8').replace(/^﻿/, '').replace(/\r/g, '')
  } catch {
    return ''
  }
}
const RUN = read('skills', 'run', 'SKILL.md')
const ARCH = read('agents', 'architect.md')
const INIT = read('skills', 'init', 'SKILL.md')
const README = read('README.md')

// text from the `## <n>. ` heading up to the next `## <m>. ` heading (or end)
const runSection = (n: number): string => {
  const m = RUN.match(new RegExp(`^## ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## \\d+\\. |(?![\\s\\S]))`, 'm'))
  return m ? m[0] : ''
}
// text from the `## <title>` heading up to the next `## ` heading (or end)
const mdSection = (text: string, title: string): string => {
  const m = text.match(new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))
  return m ? m[0] : ''
}
const has = (text: string, re: RegExp, what: string) => assert.match(text, re, what)

describe('run/SKILL.md wiring', () => {
  test('section 0: greenfield paragraph sends the owner to the interview first', () => {
    const s = runSection(0)
    assert.ok(s, 'section 0 not found')
    has(s, /greenfield/i, 'section 0 has no greenfield case')
    has(s, /interview/i, 'section 0 does not run the interview')
    has(s, /Greenfield:\s*\S*requirements\.md/i, 'section 0 does not pass the `Greenfield:` line to init')
  })

  test('section 1: ### Interview the owner names the interview skill and docs/requirements.md', () => {
    const s = runSection(1)
    const m = s.match(/^### Interview the owner[^\n]*\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/im)
    assert.ok(m, 'section 1 has no `### Interview the owner` heading')
    has(m[1], /foundry:interview/, 'subsection does not name the foundry:interview skill')
    has(m[1], /requirements\.md/, 'subsection does not name requirements.md')
    has(m[1], /interview\.json/, 'subsection does not name interview.json')
  })

  test('section 4: architect brief passes the requirements path and R-ids', () => {
    const s = runSection(4)
    has(s, /requirements\.md/i, 'section 4 brief does not name requirements.md')
    has(s, /R-ids?/i, 'section 4 brief does not pass the run\'s R-ids')
  })

  test('section 4: a plan that does not trace every R-n is sent back', () => {
    const s = runSection(4)
    has(
      s,
      /(R-ids?|R-n|requirements?)[^\n]{0,160}(neither|not)[^\n]{0,60}(served|traced)|(unserved|not traced|untraced)[^\n]{0,120}(R-|requirement)/i,
      'section 4 has no send-back reason about requirements the plan does not trace'
    )
    has(s, /Unserved:/, 'section 4 does not mention `Unserved:`')
  })

  test('section 5: plan table has a Requirements column', () => {
    const s = runSection(5)
    has(s, /\|[^\n]*Requirements[^\n]*\|/, 'section 5 table has no Requirements column')
  })

  test('section 5: defaults and Unserved lines are listed under the plan table', () => {
    const s = runSection(5)
    has(s, /Source:\s*`?default/i, 'section 5 does not list `Source: default` requirements')
    has(s, /Unserved:/, 'section 5 does not list `Unserved:` ids')
  })

  test('section 5: auto-start message uses the exact `Defaults filled: R-<n> (<branch id>)` format (owner ruling #1)', () => {
    const s = runSection(5)
    has(s, /Defaults filled:\s*R-<n>\s*\(<branch id>\)/, 'section 5 lacks the literal `Defaults filled: R-<n> (<branch id>)` format')
    has(s, /Defaults filled:[^\n]*(,\s*\.\.\.|…)/, 'format does not show a repeated list (`, ...`)')
  })

  test('section 6: goal files get a ## Requirements section', () => {
    const s = runSection(6)
    has(s, /##\s*Requirements/, 'section 6 goal file has no `## Requirements`')
    has(s, /R-<n>:\s*<title>|R-\d+:\s*<?title/i, 'section 6 does not give the `- R-<n>: <title>` line form')
  })

  test('section 6: the foreman runs the interview cli trace before the first lead', () => {
    const s = runSection(6)
    has(s, /interview\/cli\.ts\s+trace\b/, 'section 6 does not run `interview/cli.ts trace`')
    has(s, /interview\.json/, 'section 6 trace call omits interview.json')
    has(s, /OK:/, 'section 6 does not wait for `OK:`')
  })

  test('section 10: requirements are marked met', () => {
    const s = runSection(10)
    has(s, /Status:\s*`?met`?|mark[^\n]{0,60}\bmet\b/i, 'section 10 does not mark requirements met')
    has(s, /requirements/i, 'section 10 does not mention requirements')
  })

  test('scrubbed commit (owner ruling #2): run/SKILL.md or README states the rule', () => {
    const rule = (text: string) =>
      text.split(/\n\s*\n/).some(
        (p) =>
          /requirements\.md/i.test(p) &&
          /commit/i.test(p) &&
          /\bnames?\b/i.test(p) &&
          /e-?mails?/i.test(p) &&
          /(user |home )?paths?/i.test(p) &&
          /(private )?infrastructure/i.test(p)
      )
    assert.ok(rule(RUN) || rule(README), 'no paragraph says requirements.md is committed with no names, emails, user paths or private infrastructure')
  })

  test('owner /goal principle: the foundry adapts to needs found in the interview', () => {
    has(RUN + README, /adapt[^\n]{0,120}interview|interview[^\n]{0,120}adapt/i, 'neither run/SKILL.md nor README ties adaptation to the interview')
  })
})

describe('architect.md wiring', () => {
  test('init mode: greenfield paragraph (planned modules citing R-ids)', () => {
    const s = mdSection(ARCH, 'init mode')
    assert.ok(s, 'init mode section not found')
    has(s, /greenfield/i, 'init mode has no greenfield paragraph')
    has(s, /planned/i, 'init mode does not label modules `planned`')
    has(s, /R-ids?|R-n/i, 'init mode does not cite R-ids')
  })

  test('plan mode: inputs name requirements.md', () => {
    const s = mdSection(ARCH, 'plan mode')
    assert.ok(s, 'plan mode section not found')
    const inputs = s.match(/\*\*Inputs\.\*\*[^\n]*/)
    assert.ok(inputs, 'plan mode has no Inputs paragraph')
    has(inputs[0], /requirements\.md/i, 'plan-mode Inputs do not name requirements.md')
  })

  test('plan mode: plan.md crew table has a Requirements column and an Unserved: line', () => {
    const s = mdSection(ARCH, 'plan mode')
    has(s, /Requirements`?\s+column|column[^\n]{0,40}Requirements/i, 'plan.md crew table has no Requirements column')
    has(s, /Unserved:/, 'plan mode does not describe the `Unserved:` line')
  })
})

describe('init/SKILL.md wiring', () => {
  test('step 3 passes the Greenfield: line into the architect brief', () => {
    const s = mdSection(INIT, '3\\.')
    assert.ok(s, 'init step 3 not found')
    has(s, /Greenfield:/, 'step 3 brief does not pass the `Greenfield:` line')
  })
})

describe('README wiring', () => {
  test('names the interview skill and docs/requirements.md', () => {
    has(README, /foundry:interview|interview skill/i, 'README does not name the interview skill')
    has(README, /docs\/requirements\.md/, 'README does not name docs/requirements.md')
  })
})

describe('regression guards: merged text that must survive the rewrite', () => {
  test('architect design mode keeps the 3,000-word ADR budget', () => {
    has(mdSection(ARCH, 'design mode'), /at most 3,000 words/i, '3,000-word ADR budget gone')
  })
  test('run keeps the leadless small crew rule', () => {
    has(runSection(6), /at most 2 members and no red team has no lead/i, 'leadless small-crew rule gone')
  })
  test('run keeps the plan table red team column', () => {
    has(runSection(5), /Red team \(yes\/no\)/, 'Red team (yes/no) column gone')
  })
  test('run keeps the extend pass commit and the cynic section', () => {
    has(RUN, /commit of each extend pass/i, 'extend pass commit wording gone')
    has(RUN, /^## The cynic/m, 'cynic section gone')
  })
  test('architect keeps its Extend or change and Diagrams sections', () => {
    has(ARCH, /^## Extend or change/m, 'Extend or change section gone')
    has(ARCH, /^## Diagrams/m, 'Diagrams section gone')
  })
})
