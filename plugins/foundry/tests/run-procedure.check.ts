// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry run-wiring goal (ADR-0009 Decision 7): the foreman's procedure, config, schema, manifest and README
// that drive the factory CLI (bin/factory.ts) and the Workflow scripts (workflows/plan.js, wave.js).
// Pinned from the spec before the prose and config are written. Each assertion is scoped to its SKILL.md section.
//
// Run with: node --test plugins/foundry/tests/run-procedure.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.
//
// Scope note: owner ruling 06:22 "One round, real defects" reverses ADR-0009 owner decision #1, so nothing
// here pins red-team rounds sharing the repair budget.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(PLUGIN, '..', '..')
const raw = (...parts: string[]): string => {
  try {
    return readFileSync(join(...parts), 'utf8')
  } catch {
    return ''
  }
}
// markdown noise (backticks, bold) dropped and whitespace collapsed, so line wraps and formatting don't matter
const norm = (s: string): string => s.replace(/[`*]/g, '').replace(/\s+/g, ' ')
const RUN_RAW = raw(PLUGIN, 'skills', 'run', 'SKILL.md')
// the text of "## N. ..." up to the next "## " heading
const section = (n: number): string => {
  const m = RUN_RAW.match(new RegExp(`^## ${n}\\. [\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm'))
  return m === null ? '' : norm(m[0])
}
const S4 = section(4)
const S5 = section(5)
const S6 = section(6)
const S9 = section(9)
const README_RAW = raw(PLUGIN, 'README.md')
const README = norm(README_RAW)
const CHANGELOG_RAW = raw(PLUGIN, 'CHANGELOG.md')
const notes11 = (): string => {
  const m = CHANGELOG_RAW.match(/^## 0\.11\.0[\s\S]*?(?=^## |(?![\s\S]))/m)
  return m === null ? '' : norm(m[0])
}

const has = (text: string, re: RegExp, what: string) => assert.match(text, re, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `superseded text still there: ${what}`)
const json = (...parts: string[]): any => JSON.parse(raw(...parts))

describe('run-procedure: SKILL.md section 4 (plan)', () => {
  test('4 writes plan-brief.md and runs plan-args', () => {
    has(S4, /plan-brief\.md/i, 'plan-brief.md')
    has(S4, /plan-args/i, 'plan-args')
  })
  test('4 runs Workflow with plan.js, then plan-write and plan-check, in that order', () => {
    has(S4, /Workflow\(?\s*plan\.js/i, 'Workflow(plan.js)')
    has(S4, /plan-write/i, 'plan-write')
    has(S4, /plan-check/i, 'plan-check')
    has(S4, /plan-args[\s\S]*plan\.js[\s\S]*plan-write[\s\S]*plan-check/i, 'order: plan-args, plan.js, plan-write, plan-check')
  })
  test('4 resumes once on a failed plan-check', () => {
    has(S4, /(failed|fails|failing)\s+plan-check[^.]*resum|plan-check[^.]*fail[^.]*resum[^.]*\bonce\b|resum[^.]*\bonce\b[^.]*plan-check/i, 'resume once on failed plan-check')
    has(S4, /\bonce\b/i, 'once')
  })
  test('4 keeps the lead-path Agent architect text for sessions without Workflow, beside the new path', () => {
    has(S4, /lead path|without Workflow|no Workflow|Workflow (is )?(not available|unavailable)/i, 'lead-path / no-Workflow wording')
    has(S4, /Agent[^.]*architect|architect[^.]*Agent/i, 'Agent call of the architect')
    has(S4, /plan-brief\.md/i, 'new path present too, so this is not today\'s text')
  })
})

describe('run-procedure: SKILL.md section 5 (merge mode and target)', () => {
  test('5 no longer asks the owner two more things, and runs settings instead', () => {
    gone(S5, /Ask the owner two more things/i, '"Ask the owner two more things"')
    has(S5, /factory\.ts settings/i, 'factory.ts settings (so the section is the new one)')
  })
  test('5 shows settings as information in the plan table and logs it', () => {
    has(S5, /(information|informational|FYI)/i, 'shown as information')
    has(S5, /plan table/i, 'in the plan table')
    has(S5, /\blog(s|ged)?\b/i, 'logged')
    has(S5, /factory\.ts settings/i, 'factory.ts settings')
  })
  test('5 never asks merge mode or target', () => {
    has(S5, /never asks[^.]*(merge mode|target)|(merge mode|target)[^.]*never ask|never ask(s)? the owner (for|about) (the )?(merge|target)/i, 'never asks merge mode or target')
  })
  test('5 gets single only from config or the owner\'s own words', () => {
    has(S5, /single[^.]*(foundry\.json|config)[^.]*(owner|own words)|(foundry\.json|config)[^.]*single[^.]*(owner|own words)/i, 'single from config or owner words')
    has(S5, /own words|owner'?s? (instruction|words)/i, "owner's own words")
    has(S5, /single[^.]*lead path/i, 'a single run puts every crew on the lead path')
  })
})

describe('run-procedure: SKILL.md section 6 (goal files and start)', () => {
  test('6 goal files carry Approved scope, Red team (yes/no) and Engine (workflow/lead)', () => {
    has(S6, /## Approved scope/i, '## Approved scope')
    has(S6, /## Red team/i, '## Red team')
    has(S6, /## Engine/i, '## Engine')
    has(S6, /Red team[^.]*\byes\b[^.]*\bno\b/i, 'Red team first word yes or no')
    has(S6, /Engine[^.]*\bworkflow\b[^.]*\blead\b/i, 'Engine first word workflow or lead')
  })
  test('6 Workflow crews run start, Workflow(wave.js), then finish --transcript --result', () => {
    has(S6, /factory\.ts start|\bstart\b[\s\S]*Workflow\(?\s*wave\.js/i, 'start')
    has(S6, /Workflow\(?\s*wave\.js/i, 'Workflow(wave.js)')
    has(S6, /finish[^.]*--transcript[^.]*--result/i, 'finish --transcript ... --result')
  })
  test('6 passes --transcript to start and finish whenever a Workflow ran this session', () => {
    has(S6, /start[^.]*--transcript|--transcript[^.]*\bstart\b/i, '--transcript on start')
    has(S6, /finish[^.]*--transcript/i, '--transcript on finish')
    has(S6, /(whenever|when|if|once)[^.]*Workflow[^.]*(ran|run|started)[^.]*this session|this session'?s? transcript/i, 'whenever a Workflow ran this session')
  })
  test('6 restarts: --resume answers, --resume stale, run may be live, start --wave next', () => {
    has(S6, /--resume answers/i, '--resume answers')
    has(S6, /--resume stale/i, '--resume stale')
    has(S6, /run may be live/i, 'run may be live')
    has(S6, /start --wave next/i, 'start --wave next')
  })
  test('6 --no-workflow falls back to the lead path, with when to use it', () => {
    has(S6, /start --no-workflow/i, 'start --no-workflow')
    has(S6, /--no-workflow[^.]*(every crew|all crews)[^.]*lead path|lead path[^.]*--no-workflow/i, '--no-workflow puts every crew on the lead path')
    has(S6, /Workflow tool (is )?(unavailable|not available)|no Workflow tool|without the Workflow tool/i, 'when: Workflow tool unavailable')
    has(S6, /not opted in|has not opted|hasn'?t opted|did not opt|not opt/i, 'when: owner has not opted in')
  })
  test('6 deploy and raised-effort crews stay on the lead path', () => {
    has(S6, /deploy[^.]*lead path|lead path[^.]*deploy/i, 'deploy on the lead path')
    has(S6, /raised[- ]effort[^.]*lead path|lead path[^.]*raised[- ]effort|(xhigh|high effort)[^.]*lead path/i, 'raised-effort on the lead path')
  })
})

describe('run-procedure: SKILL.md section 9 (merge)', () => {
  test('9 finish is the gate for Workflow crews', () => {
    has(S9, /Workflow crews?[^.]*\bfinish\b|\bfinish\b[^.]*Workflow crews?/i, 'finish is the gate for Workflow crews')
    has(S9, /gate[^.]*\bfinish\b|\bfinish\b[^.]*gate/i, 'finish named as the gate')
  })
  test('9 rework: conflict and rework: rejudge go back through --resume merge-ready', () => {
    has(S9, /rework: conflict/i, 'rework: conflict')
    has(S9, /rework: rejudge/i, 'rework: rejudge')
    has(S9, /--resume merge-ready/i, '--resume merge-ready')
  })
})

describe('run-procedure: .claude/foundry.json', () => {
  test('parses and carries merge sequential and target main, keeping architecture and adr', () => {
    const cfg = json(REPO, '.claude', 'foundry.json')
    assert.equal(cfg.merge, 'sequential')
    assert.equal(cfg.target, 'main')
    assert.equal(cfg.architecture, 'docs/architecture.md')
    assert.equal(cfg.adr, 'docs/adr')
  })
  test('factory.ts settings --repo prints target main and its source', () => {
    let out = ''
    try {
      out = execFileSync(process.execPath, [join(PLUGIN, 'bin', 'factory.ts'), 'settings', '--repo', REPO], { cwd: REPO, encoding: 'utf8' })
    } catch (e) {
      out = String((e as any).stdout ?? '') + String((e as any).stderr ?? '')
    }
    const flat = out.replace(/\s+/g, '')
    has(flat, /"target":"main"/, '"target":"main" in settings output')
    has(flat, /"source":"\.claude\/foundry\.json"/, '"source":".claude/foundry.json" in settings output')
  })
})

describe('run-procedure: foundry-config.schema.json', () => {
  test('merge and target say every run, the foreman never asks; enum and type unchanged', () => {
    const p = json(PLUGIN, 'docs', 'foundry-config.schema.json').properties
    assert.match(p.merge.description, /of every run; the foreman never asks/i)
    assert.match(p.target.description, /of every run; the foreman never asks/i)
    assert.doesNotMatch(p.merge.description, /auto-started runs/i)
    assert.doesNotMatch(p.target.description, /auto-started runs/i)
    assert.deepEqual(p.merge.enum, ['sequential', 'single'])
    assert.equal(p.target.type, 'string')
  })
})

describe('run-procedure: plugin.json and README', () => {
  test('plugin.json version is the newest CHANGELOG heading, 0.11.0 or later', () => {
    const version = json(PLUGIN, '.claude-plugin', 'plugin.json').version as string
    assert.equal(version, CHANGELOG_RAW.match(/^## (\d+\.\d+\.\d+)$/m)?.[1], 'plugin.json version matches the first CHANGELOG heading')
    const [major, minor] = version.split('.').map(Number)
    assert.ok(major! > 0 || minor! >= 11, `${version} is 0.11.0 or later`)
  })
  test('README has a Workflow engine section', () => {
    assert.match(README_RAW, /^#{2,3} [^\n]*Workflow engine[^\n]*$/im, 'a heading naming the Workflow engine')
  })
  test('README config table: merge and target are of every run, never asked', () => {
    const rows = README_RAW.split('\n').filter((l) => /^\| `(merge|target)` \|/.test(l)).map(norm)
    assert.equal(rows.length, 2, 'merge and target rows')
    for (const r of rows) {
      has(r, /every run/i, `every run in: ${r}`)
      has(r, /never asks/i, `never asks in: ${r}`)
      gone(r, /auto-started/i, `auto-started in: ${r}`)
    }
  })
  test('CHANGELOG has 0.11.0 release notes', () => {
    assert.match(CHANGELOG_RAW, /^## 0\.11\.0$/m, '0.11.0 heading in CHANGELOG.md')
  })
  test('CHANGELOG 0.11.0 notes name the interview wiring and the Workflow run procedure', () => {
    const notes = notes11()
    has(notes, /interview/i, 'interview wiring')
    has(notes, /Workflow/i, 'Workflow')
    has(notes, /run procedure|SKILL\.md|foreman'?s? procedure|plan-args|wave\.js/i, 'Workflow run procedure')
  })
  test('CHANGELOG 0.11.0 notes name factory-scripts, intake-retro, speed-rules and critical-fixes work', () => {
    const notes = notes11()
    has(notes, /factory[- ]scripts|factory\.ts|plan\.js|wave\.js/i, 'factory-scripts')
    has(notes, /intake[- ]retro|intake/i, 'intake-retro')
    has(notes, /speed[- ]rules|one round|red[- ]team round/i, 'speed-rules')
    has(notes, /critical[- ]fixes|critical fix/i, 'critical-fixes')
  })
})

// Regression guards: tests/gates.check.ts:68-83 pins these in section 9; the edit must not drop them.
describe('run-procedure: section 9 guards (green today)', () => {
  test('9 still holds Head: , Patch: , git patch-id --stable and UNSCOPED', () => {
    assert.ok(S9.length > 200, 'section 9 not sliced')
    assert.ok(S9.includes('Head: '), 'Head: ')
    assert.ok(S9.includes('Patch: '), 'Patch: ')
    assert.ok(S9.includes('git patch-id --stable'), 'git patch-id --stable')
    assert.ok(S9.includes('UNSCOPED'), 'UNSCOPED')
  })
})
