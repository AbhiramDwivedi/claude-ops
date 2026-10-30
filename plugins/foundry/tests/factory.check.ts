// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// foundry ADR-0009 Decision 1 (the factory CLI, plugins/foundry/bin/factory.ts) and Decision 2 (roles.json). Written
// from the ADR before the code. This file pins settings, plan-args, plan-write, plan-check, approve, check, integrate,
// sync, owns-check, the roles table, the label parse, the events schema and the usage-error contract. `start` and
// `finish` are pinned in tests/fixtures/workflow-run/start.cases.ts and finish.cases.ts, loaded at the end of this file.
//
// Run with: node --test plugins/foundry/tests/factory.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Every test builds temp git repos and foundry dirs through tests/fixtures/workflow-run/harness.ts. The CLI runs from a
// copy of the plugin whose workflows/plan.js and wave.js are stubs (another crew writes the real ones).
//
// Assumptions the ADR leaves open:
// - the crew worktree is <repo>/.claude/worktrees/foundry-<slug> on branch foundry-<slug> (ADR "start");
// - sync, integrate and owns-check find the repo from --repo (or the cwd) and the target from `settings`;
// - `bin/factory.ts` exports `parseLabel(label): {slug, role, n} | undefined` (n >= 2 for a `-<n>` suffix) and does not
//   run the CLI when imported;
// - a refusal (a gate said no) is exit 1, a usage or I/O error is exit 2.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as reg from '../hooks/register.ts'
import {
  REAL_FACTORY, REAL_PLUGIN, REAL_REPO, addCrewWorktree, appendEvent, assertOneLine, assertUsageError, caseFiles, crew, flat, git, gitStatus,
  head, mkEnv, mkRepo, mkRun, planObj, pluginCopy, putFile, readEvents, readPlan, runCli, tmp, validateEvent, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const { workflowRoleVerdict, workflowCallVerdict, parsePlan } = reg

const rolesJson = () => JSON.parse(readFileSync(`${REAL_PLUGIN}/workflows/roles.json`, 'utf8'))

// ---------------------------------------------------------------------------------------------------------------
// usage errors and the one-line contract

test('an unknown command exits 2 with {"error":...} on one line', () => {
  const env = mkEnv()
  assertUsageError(env.run('no-such-command'))
})

test('a missing required flag exits 2 with {"error":...} for every command that has one', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('s')]))
  const cases = [
    ['plan-args', { 'brief-file': null }],
    ['plan-write', { transcript: env.transcripts }], // no --label
    ['plan-write', { label: 'foundry-architect' }], // no --transcript
    ['plan-check', { dir: null }],
    ['approve', {}], // no --by
    ['check', { slug: 's' }], // no --expect
    ['check', { expect: 'red' }], // no --slug
    ['integrate', { slug: 's' }], // no --branch
    ['integrate', { branch: 'b' }], // no --slug
    ['sync', {}], // no --slug
    ['owns-check', {}], // no --slug
    ['finish', {}], // no --transcript
  ]
  for (const [cmd, flags] of cases) {
    const res = env.run(cmd, flags)
    try {
      assertUsageError(res)
    } catch (e) {
      throw new Error(`${cmd} ${JSON.stringify(flags)}: ${e.message}`)
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------
// settings

test('settings: .claude/foundry.json with both keys gives that source, keys in exact order', () => {
  const env = mkEnv({ config: { merge: 'single', target: 'develop' } })
  const res = env.run('settings', { dir: null })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '{"merge":"single","target":"develop","source":".claude/foundry.json"}\n')
})

test('settings: neither key set gives defaults, source "default", target is the current branch', () => {
  const env = mkEnv({ config: { architecture: 'docs/architecture.md' } })
  git(env.repo, ['checkout', '-q', '-b', 'topic'])
  const res = env.run('settings', { dir: null })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '{"merge":"sequential","target":"topic","source":"default"}\n')
})

test('settings: no .claude/foundry.json at all is the default source on main', () => {
  const env = mkEnv()
  const res = env.run('settings', { dir: null })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '{"merge":"sequential","target":"main","source":"default"}\n')
})

test('settings: one key set is "mixed", the missing one defaulted', () => {
  const onlyMerge = mkEnv({ config: { merge: 'single' } })
  assert.equal(onlyMerge.run('settings', { dir: null }).stdout, '{"merge":"single","target":"main","source":"mixed"}\n')
  const onlyTarget = mkEnv({ config: { target: 'release' } })
  assert.equal(onlyTarget.run('settings', { dir: null }).stdout, '{"merge":"sequential","target":"release","source":"mixed"}\n')
})

test('settings: --repo is honoured whatever the cwd, and the output is idempotent', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  const other = tmp('fcli-cwd-')
  const a = env.run('settings', { dir: null }, [], other)
  const b = env.run('settings', { dir: null }, [], other)
  assert.equal(a.stdout, '{"merge":"sequential","target":"main","source":".claude/foundry.json"}\n')
  assert.equal(a.stdout, b.stdout)
})

test('settings: this checkout, run from the real bin, gives "merge":"sequential"', () => {
  const res = runCli(REAL_FACTORY, 'settings', ['--repo', REAL_REPO])
  assert.equal(res.status, 0, res.stderr)
  const j = assertOneLine(res)
  assert.equal(j.merge, 'sequential')
  assert.match(res.stdout, /^\{"merge":"sequential","target":"[^"]+","source":"[^"]+"\}\n$/)
})

// ---------------------------------------------------------------------------------------------------------------
// plan-args

function briefFile(env, text = 'Build the thing.\nSecond line.') {
  const p = `${env.dir}/brief.md`
  writeFileSync(p, text)
  return p
}

const unapproved = () => planObj([crew('arch', { wave: 0, verdict: 'design' }), crew('s')], { approval: 'owner', approvedAt: null })

test('plan-args: builds {"foundry":{kind plan,...},"brief"} from the brief file, roles.json and the plugin dir', () => {
  const env = mkEnv()
  const res = env.run('plan-args', { 'brief-file': briefFile(env) })
  assert.equal(res.status, 0, res.stderr)
  const j = assertOneLine(res)
  assert.deepEqual(Object.keys(j), ['foundry', 'brief'])
  assert.equal(j.brief, 'Build the thing.\nSecond line.')
  const f = j.foundry
  assert.deepEqual(Object.keys(f), ['kind', 'dir', 'repo', 'plugin', 'schema', 'architecture', 'maxParallelCrews', 'repairBudget', 'roles', 'scriptPath'])
  assert.equal(f.kind, 'plan')
  assert.equal(flat(f.dir), env.dir)
  assert.equal(flat(f.repo), env.repo)
  assert.equal(flat(f.plugin), env.plugin)
  assert.equal(flat(f.schema), `${env.plugin}/docs/plan.schema.json`)
  assert.equal(typeof f.architecture, 'string')
  assert.equal(f.maxParallelCrews, 4)
  assert.equal(f.repairBudget, 2)
  assert.deepEqual(f.roles, JSON.parse(readFileSync(`${env.plugin}/workflows/roles.json`, 'utf8')))
  assert.equal(flat(f.scriptPath), `${env.plugin}/workflows/plan.js`)
})

test('plan-args: maxParallelCrews and repairBudget come from .claude/foundry.json', () => {
  const env = mkEnv({ config: { maxParallelCrews: 3, repairBudget: 0 } })
  const j = assertOneLine(env.run('plan-args', { 'brief-file': briefFile(env) }))
  assert.equal(j.foundry.maxParallelCrews, 3)
  assert.equal(j.foundry.repairBudget, 0)
})

test('plan-args --fix is accepted and still builds the plan args', () => {
  const env = mkEnv()
  const fix = `${env.dir}/fix.txt`
  writeFileSync(fix, 'slug "Bad" breaks the slug rule')
  const res = env.run('plan-args', { 'brief-file': briefFile(env), fix })
  assert.equal(res.status, 0, res.stderr)
  const j = assertOneLine(res)
  assert.equal(j.foundry.kind, 'plan')
  assert.equal(typeof j.brief, 'string')
})

test('plan-args --scripts-dir copies plan.js byte for byte to S/foundry-plan.js and sets scriptPath', () => {
  const env = mkEnv()
  const scripts = tmp('fcli-scripts-')
  const j = assertOneLine(env.run('plan-args', { 'brief-file': briefFile(env), 'scripts-dir': scripts }))
  assert.equal(flat(j.foundry.scriptPath), `${scripts}/foundry-plan.js`)
  assert.ok(readFileSync(`${scripts}/foundry-plan.js`).equals(readFileSync(`${env.plugin}/workflows/plan.js`)))
})

test('plan-args: the args pass the real workflowCallVerdict (by path) and workflowRoleVerdict', () => {
  const env = mkEnv()
  const j = assertOneLine(env.run('plan-args', { 'brief-file': briefFile(env) }))
  assert.equal(workflowRoleVerdict(j.foundry.roles), undefined)
  const plan = parsePlan(JSON.stringify(unapproved()))
  const planJs = readFileSync(`${env.plugin}/workflows/plan.js`, 'utf8')
  const waveJs = readFileSync(`${env.plugin}/workflows/wave.js`, 'utf8')
  const verdict = workflowCallVerdict(plan, { scriptPath: j.foundry.scriptPath, args: j, pluginDir: env.plugin, pluginScriptTexts: [planJs, waveJs] })
  assert.equal(verdict, undefined)
})

test('plan-args --scripts-dir: the args pass workflowCallVerdict through the byte-identical copy', () => {
  const env = mkEnv()
  const scripts = tmp('fcli-scripts-')
  const j = assertOneLine(env.run('plan-args', { 'brief-file': briefFile(env), 'scripts-dir': scripts }))
  const plan = parsePlan(JSON.stringify(unapproved()))
  const planJs = readFileSync(`${env.plugin}/workflows/plan.js`, 'utf8')
  const waveJs = readFileSync(`${env.plugin}/workflows/wave.js`, 'utf8')
  const scriptText = readFileSync(j.foundry.scriptPath, 'utf8')
  const verdict = workflowCallVerdict(plan, { scriptPath: j.foundry.scriptPath, scriptText, args: j, pluginDir: env.plugin, pluginScriptTexts: [planJs, waveJs] })
  assert.equal(verdict, undefined)
})

test('plan-args is idempotent: twice, same stdout (and same copy with --scripts-dir)', () => {
  const env = mkEnv()
  const scripts = tmp('fcli-scripts-')
  const flags = { 'brief-file': briefFile(env), 'scripts-dir': scripts }
  const a = env.run('plan-args', flags)
  const b = env.run('plan-args', flags)
  assert.equal(a.stdout, b.stdout)
  assert.ok(readFileSync(`${scripts}/foundry-plan.js`).equals(readFileSync(`${env.plugin}/workflows/plan.js`)))
})

// ---------------------------------------------------------------------------------------------------------------
// plan-write

const PLAN_JSON = JSON.stringify(planObj([crew('arch', { wave: 0, verdict: 'design' })], { approval: 'owner', approvedAt: null }), null, 2)
const messageOf = (json = PLAN_JSON, md = '# The plan\n\nBody.') => `Here is the plan.\n\n\`\`\`\`json plan.json\n${json}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n${md}\n\`\`\`\`\n`

function planRun(env, results) {
  // results: journal `result` values for label foundry-architect, in order
  const ts = '2026-10-29T10:00:00.000Z'
  const { dir } = mkRun(env.transcripts, 'wf_plan', [{ id: 'aarch', label: 'foundry-architect', agentType: 'foundry:architect', metaModel: 'opus', result: results[0], startTs: ts }])
  if (results.length > 1) {
    const lines = results.slice(1).map((r) => JSON.stringify({ type: 'result', key: 'v2:x', agentId: 'aarch', result: r }))
    writeFileSync(`${dir}/journal.jsonl`, readFileSync(`${dir}/journal.jsonl`, 'utf8') + lines.join('\n') + '\n')
  }
  return dir
}

test('plan-write: writes plan.json with approvedAt null and plan.md from the labelled agent\'s result', () => {
  const env = mkEnv()
  const t = planRun(env, [messageOf()])
  const res = env.run('plan-write', { transcript: t, label: 'foundry-architect' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(assertOneLine(res), { written: true })
  const plan = readPlan(env.dir)
  assert.equal(plan.approvedAt, null)
  assert.equal(plan.version, 2)
  assert.equal(plan.crews[0].slug, 'arch')
  assert.equal(readFileSync(`${env.dir}/plan.md`, 'utf8'), '# The plan\n\nBody.')
})

test('plan-write: the last journal result line for the label wins', () => {
  const env = mkEnv()
  const second = JSON.stringify({ ...JSON.parse(PLAN_JSON), goal: 'second goal' })
  const t = planRun(env, [messageOf(), messageOf(second, '# second')])
  const res = env.run('plan-write', { transcript: t, label: 'foundry-architect' })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(readPlan(env.dir).goal, 'second goal')
  assert.equal(readFileSync(`${env.dir}/plan.md`, 'utf8'), '# second')
})

test('plan-write: a missing block, a non-plan block and an unreadable plan write nothing, exit 1 with a reason', () => {
  const env = mkEnv()
  const noJson = env.run('plan-write', { transcript: planRun(env, ['````markdown plan.md\n# only md\n````\n']), label: 'foundry-architect' })
  assert.equal(noJson.status, 1)
  const j1 = assertOneLine(noJson)
  assert.equal(j1.written, false)
  assert.match(j1.reason, /no plan\.json block/)
  assert.equal(existsSync(`${env.dir}/plan.json`), false)

  const env2 = mkEnv()
  const noMd = env2.run('plan-write', { transcript: planRun(env2, [`\`\`\`\`json plan.json\n${PLAN_JSON}\n\`\`\`\`\n`]), label: 'foundry-architect' })
  assert.equal(noMd.status, 1)
  assert.match(assertOneLine(noMd).reason, /no plan\.md block/)
  assert.equal(existsSync(`${env2.dir}/plan.json`), false)

  const env3 = mkEnv()
  const notPlan = env3.run('plan-write', { transcript: planRun(env3, [messageOf('{"hello":1}')]), label: 'foundry-architect' })
  assert.equal(notPlan.status, 1)
  const j3 = assertOneLine(notPlan)
  assert.equal(j3.written, false)
  assert.match(j3.reason, /not a plan/)
  assert.equal(existsSync(`${env3.dir}/plan.json`), false)
})

test('plan-write never overwrites an approved plan, and says why', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('keep')], { goal: 'approved goal' }))
  const before = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const res = env.run('plan-write', { transcript: planRun(env, [messageOf()]), label: 'foundry-architect' })
  assert.equal(res.status, 1)
  const j = assertOneLine(res)
  assert.equal(j.written, false)
  assert.match(j.reason, /approved/)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), before)
  assert.equal(existsSync(`${env.dir}/plan.md`), false)
})

test('plan-write never overwrites an unreadable plan.json', () => {
  const env = mkEnv()
  writeFileSync(`${env.dir}/plan.json`, 'not json at all')
  const res = env.run('plan-write', { transcript: planRun(env, [messageOf()]), label: 'foundry-architect' })
  assert.equal(res.status, 1)
  assert.equal(assertOneLine(res).written, false)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), 'not json at all')
})

test('plan-write replaces an unapproved plan, and twice gives the same output and state', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('old', { wave: 0, verdict: 'design' })], { approval: 'owner', approvedAt: null, goal: 'old goal' }))
  const t = planRun(env, [messageOf()])
  const a = env.run('plan-write', { transcript: t, label: 'foundry-architect' })
  const state = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const b = env.run('plan-write', { transcript: t, label: 'foundry-architect' })
  assert.equal(a.status, 0)
  assert.equal(a.stdout, b.stdout)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), state)
  assert.equal(readPlan(env.dir).goal, 'test goal')
})

test('plan-write: an unknown label is an error, not a write', () => {
  const env = mkEnv()
  const res = env.run('plan-write', { transcript: planRun(env, [messageOf()]), label: 'no-such-label' })
  assert.notEqual(res.status, 0)
  assertOneLine(res)
  assert.equal(existsSync(`${env.dir}/plan.json`), false)
})

// ---------------------------------------------------------------------------------------------------------------
// plan-check

function checkPlan(plan, extra = {}) {
  const env = mkEnv()
  writePlan(env.dir, plan)
  const res = env.run('plan-check', { repo: null, ...extra })
  return { env, res, json: assertOneLine(res) }
}
const errorsFor = (json, slug) => (json.errors ?? []).filter((e) => e.startsWith(`${slug}: `))

test('plan-check: a good plan is ok and lists crews with doneCheckProved false under unproved', () => {
  const { res, json } = checkPlan(planObj([crew('alpha'), crew('beta', { doneCheckProved: false }), crew('gamma', { wave: 2, doneCheckProved: false })]))
  assert.equal(res.status, 0)
  assert.deepEqual(json, { ok: true, unproved: ['beta', 'gamma'] })
})

test('plan-check: all proved gives an empty unproved list', () => {
  const { json } = checkPlan(planObj([crew('alpha')]))
  assert.deepEqual(json, { ok: true, unproved: [] })
})

test('plan-check: version must be 2', () => {
  const { res, json } = checkPlan(planObj([crew('alpha')], { version: 1, repairBudget: undefined }))
  assert.equal(res.status, 1)
  assert.equal(json.ok, false)
  assert.ok(json.errors.length >= 1)
})

test('plan-check: approval is owner exactly when a wave-0 crew exists', () => {
  const ownerNoWave0 = checkPlan(planObj([crew('alpha')], { approval: 'owner', approvedAt: null }))
  assert.equal(ownerNoWave0.res.status, 1)
  assert.equal(ownerNoWave0.json.ok, false)
  const autoWithWave0 = checkPlan(planObj([crew('arch', { wave: 0, verdict: 'design' })], { approval: 'auto' }))
  assert.equal(autoWithWave0.res.status, 1)
  assert.equal(autoWithWave0.json.ok, false)
  const ownerWithWave0 = checkPlan(planObj([crew('arch', { wave: 0, verdict: 'design' }), crew('alpha')], { approval: 'owner', approvedAt: null }))
  assert.equal(ownerWithWave0.res.status, 0)
  assert.equal(ownerWithWave0.json.ok, true)
})

test('plan-check: slug pattern, trailing digits and reserved foundry are refused, each error starts "<slug>: "', () => {
  for (const bad of ['Bad', 'a_b', 'x-2', 'a--b', '-a', 'foundry']) {
    const { res, json } = checkPlan(planObj([crew('good'), crew(bad, { owns: [`lib/${bad}/**`] })]))
    assert.equal(res.status, 1, `slug ${bad} must be refused`)
    assert.equal(json.ok, false)
    assert.ok(errorsFor(json, bad).length >= 1, `an error for ${bad}: ${JSON.stringify(json.errors)}`)
    assert.equal(errorsFor(json, 'good').length, 0)
  }
  for (const good of ['a', 'a1', 'x-test', 'a-b-c', 'v2-core']) {
    const { res } = checkPlan(planObj([crew(good)]))
    assert.equal(res.status, 0, `slug ${good} must pass`)
  }
})

test('plan-check: on an unapproved plan every crew status must be planned', () => {
  const { res, json } = checkPlan(planObj([crew('arch', { wave: 0, verdict: 'design' }), crew('alpha', { status: 'running' })], { approval: 'owner', approvedAt: null }))
  assert.equal(res.status, 1)
  assert.ok(errorsFor(json, 'alpha').length >= 1)
  const approved = checkPlan(planObj([crew('alpha', { status: 'running' }), crew('beta', { status: 'merged' })]))
  assert.equal(approved.res.status, 0)
})

test('plan-check: two crews of one wave owning a common path are refused (equal globs, prefix of the literal part)', () => {
  const equal = checkPlan(planObj([crew('alpha', { owns: ['src/x/**'] }), crew('beta', { owns: ['src/x/**'] })]))
  assert.equal(equal.res.status, 1)
  assert.ok(equal.json.errors.some((e) => /^(alpha|beta): /.test(e)))

  const prefix = checkPlan(planObj([crew('alpha', { owns: ['src/x/**'] }), crew('beta', { owns: ['src/x/y/z.ts'] })]))
  assert.equal(prefix.res.status, 1)
  assert.ok(prefix.json.errors.length >= 1)

  // the literal part before the first * is a prefix of the other's: "src/a" is a prefix of "src/ab/"
  const star = checkPlan(planObj([crew('alpha', { owns: ['src/a*'] }), crew('beta', { owns: ['src/ab/**'] })]))
  assert.equal(star.res.status, 1)

  const qmark = checkPlan(planObj([crew('alpha', { owns: ['src/a?/**'] }), crew('beta', { owns: ['src/ab/c.ts'] })]))
  assert.equal(qmark.res.status, 1)

  const bracket = checkPlan(planObj([crew('alpha', { owns: ['src/[ab]/**'] }), crew('beta', { owns: ['src/'] })]))
  assert.equal(bracket.res.status, 1)
})

test('plan-check: disjoint globs in one wave, and equal globs in different waves, pass', () => {
  const disjoint = checkPlan(planObj([crew('alpha', { owns: ['src/a/**'] }), crew('beta', { owns: ['src/b/**'] })]))
  assert.equal(disjoint.res.status, 0)
  const siblings = checkPlan(planObj([crew('alpha', { owns: ['src/a/**'] }), crew('beta', { owns: ['src/ab/**'] })]))
  assert.equal(siblings.res.status, 0, 'src/a/ is not a prefix of src/ab/')
  const waves = checkPlan(planObj([crew('alpha', { wave: 1, owns: ['src/x/**'] }), crew('beta', { wave: 2, owns: ['src/x/**'] })]))
  assert.equal(waves.res.status, 0)
})

test('plan-check: idempotent, and a missing plan.json is a usage/I-O error (exit 2)', () => {
  const { env, res } = checkPlan(planObj([crew('alpha')]))
  assert.equal(env.run('plan-check', { repo: null }).stdout, res.stdout)
  const empty = mkEnv()
  assertUsageError(empty.run('plan-check', { repo: null }))
})

// ---------------------------------------------------------------------------------------------------------------
// approve

function unapprovedEnv(config) {
  const env = mkEnv({ config })
  writePlan(env.dir, planObj([crew('arch', { wave: 0, verdict: 'design' }), crew('alpha')], { approval: 'owner', approvedAt: null }))
  writeFileSync(`${env.dir}/decisions.md`, '## Run 2026-10-29T19:42:11Z | test goal\n- 15:42 | earlier decision | why | none | followed\n')
  return env
}

test('approve: sets approvedAt to an ISO Z time, prints it, appends the decision line', () => {
  const env = unapprovedEnv({ merge: 'sequential', target: 'main' })
  const before = Date.now()
  const res = env.run('approve', { by: 'owner' })
  assert.equal(res.status, 0, res.stderr)
  const j = assertOneLine(res)
  assert.deepEqual(Object.keys(j), ['approvedAt'])
  assert.match(j.approvedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  assert.ok(Date.parse(j.approvedAt) >= before - 2000 && Date.parse(j.approvedAt) <= Date.now() + 2000)
  const plan = readPlan(env.dir)
  assert.equal(plan.approvedAt, j.approvedAt)
  assert.equal(plan.crews.length, 2)
  assert.equal(plan.approval, 'owner')
  const lines = readFileSync(`${env.dir}/decisions.md`, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  const last = lines[2]
  assert.match(last, /^- \d\d:\d\d \| plan approved \(owner\): merge sequential, target main from \.claude\/foundry\.json; approvedAt \d{4}-\d\d-\d\dT[^;]+Z; scope frozen \| /)
  assert.ok(last.includes(`approvedAt ${j.approvedAt};`))
  assert.match(last, / \| none \| followed$/)
})

test('approve --by auto names auto and the settings source in the decision line', () => {
  const env = unapprovedEnv()
  const res = env.run('approve', { by: 'auto' })
  assert.equal(res.status, 0, res.stderr)
  const last = readFileSync(`${env.dir}/decisions.md`, 'utf8').trim().split('\n').pop()
  assert.match(last, /plan approved \(auto\): merge sequential, target main from default;/)
})

test('approve refuses a second time: exit 1, plan and decisions unchanged', () => {
  const env = unapprovedEnv()
  assert.equal(env.run('approve', { by: 'owner' }).status, 0)
  const plan = readFileSync(`${env.dir}/plan.json`, 'utf8')
  const dec = readFileSync(`${env.dir}/decisions.md`, 'utf8')
  const again = env.run('approve', { by: 'owner' })
  assert.equal(again.status, 1)
  assertOneLine(again)
  assert.equal(readFileSync(`${env.dir}/plan.json`, 'utf8'), plan)
  assert.equal(readFileSync(`${env.dir}/decisions.md`, 'utf8'), dec)
})

test('approve: --by must be owner or auto', () => {
  const env = unapprovedEnv()
  assertUsageError(env.run('approve', { by: 'someone' }))
  assert.equal(readPlan(env.dir).approvedAt, null)
})

// ---------------------------------------------------------------------------------------------------------------
// check

function checkEnv(doneCheck, status = 'running') {
  const env = mkEnv({ config: { target: 'main' } })
  writePlan(env.dir, planObj([crew('s', { doneCheck, status })]))
  return env
}

test('check --expect red: a failing done-check meets the expectation; the record holds command, exit, head, tail', () => {
  const env = checkEnv('echo seen; exit 3')
  const res = env.run('check', { slug: 's', cwd: env.repo, expect: 'red' })
  assert.equal(res.status, 0, res.stderr)
  const j = assertOneLine(res)
  assert.equal(j.ok, true)
  assert.equal(j.exit, 3)
  assert.equal(j.head, head(env.repo))
  assert.match(j.tail, /seen/)
  const rec = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  assert.equal(rec.command, 'echo seen; exit 3')
  assert.equal(rec.exit, 3)
  assert.equal(rec.head, head(env.repo))
  assert.match(rec.tail, /seen/)
})

test('check: the expectation decides the exit code (red/green against failing/passing checks)', () => {
  const failing = checkEnv('exit 1')
  const passing = checkEnv('exit 0')
  const cases = [
    [failing, 'red', 0, true],
    [failing, 'green', 1, false],
    [passing, 'green', 0, true],
    [passing, 'red', 1, false],
  ]
  for (const [env, expect, status, ok] of cases) {
    const res = env.run('check', { slug: 's', cwd: env.repo, expect })
    assert.equal(res.status, status, `${expect}: ${res.stdout}`)
    assert.equal(assertOneLine(res).ok, ok)
  }
})

test('check runs the plan\'s doneCheck, not a command from the caller', () => {
  const env = checkEnv('echo from-plan; exit 0')
  const res = env.run('check', { slug: 's', cwd: env.repo, expect: 'green', command: 'echo from-caller; exit 7', 'done-check': 'exit 7' })
  const rec = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  assert.equal(rec.command, 'echo from-plan; exit 0')
  assert.equal(rec.exit, 0)
  assert.match(rec.tail, /from-plan/)
  assert.doesNotMatch(rec.tail, /from-caller/)
  assert.ok(res.status === 0 || res.status === 2, 'extra flags are ignored or a usage error, never obeyed')
})

test('check runs in --cwd', () => {
  const env = checkEnv('pwd; exit 0')
  const sub = `${env.repo}/subdir`
  mkdirSync(sub)
  const res = env.run('check', { slug: 's', cwd: sub, expect: 'green' })
  const j = assertOneLine(res)
  assert.match(j.tail.replace(/\\/g, '/'), /subdir/)
})

test('check keeps the last 40 lines of output only', () => {
  const env = checkEnv('for i in $(seq 1 100); do echo line$i; done; exit 0')
  const j = assertOneLine(env.run('check', { slug: 's', cwd: env.repo, expect: 'green' }))
  const lines = j.tail.split('\n').filter((l) => l !== '')
  assert.ok(lines.length <= 40, `tail has ${lines.length} lines`)
  assert.equal(lines[lines.length - 1], 'line100')
  assert.ok(!lines.includes('line60'))
  const rec = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  assert.equal(rec.tail, j.tail)
})

test('check adds a new record each run and never changes an old one', () => {
  const env = checkEnv('exit 5')
  env.run('check', { slug: 's', cwd: env.repo, expect: 'red' })
  const first = readFileSync(`${env.dir}/checks/s-1.json`, 'utf8')
  putFile(env.repo, 'x.txt', 'x', 'move head')
  env.run('check', { slug: 's', cwd: env.repo, expect: 'red' })
  env.run('check', { slug: 's', cwd: env.repo, expect: 'green' })
  assert.deepEqual(readdirSync(`${env.dir}/checks`).sort(), ['s-1.json', 's-2.json', 's-3.json'])
  assert.equal(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'), first)
  assert.equal(JSON.parse(readFileSync(`${env.dir}/checks/s-2.json`, 'utf8')).head, head(env.repo))
})

test('check: n is per slug, and an unknown slug is an error that writes no record', () => {
  const env = checkEnv('exit 0')
  assertUsageError(env.run('check', { slug: 'ghost', cwd: env.repo, expect: 'green' }))
  assert.ok(!existsSync(`${env.dir}/checks/ghost-1.json`))
  assert.equal(env.run('check', { slug: 's', cwd: env.repo, expect: 'green' }).status, 0)
  assert.ok(existsSync(`${env.dir}/checks/s-1.json`))
})

// ---------------------------------------------------------------------------------------------------------------
// integrate, sync, owns-check: crew worktrees in temp repos

function crewEnv(owns = ['src/s/**']) {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'a.txt': 'base\n' } })
  writePlan(env.dir, planObj([crew('s', { owns, status: 'running' })]))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt, start: head(wt) }
}

test('integrate: merges the branch into the crew worktree with --no-ff and prints the new head', () => {
  const { env, wt, start } = crewEnv()
  git(env.repo, ['branch', 'member', 'foundry-s'])
  const mw = tmp('fcli-member-')
  git(env.repo, ['worktree', 'add', '-q', `${mw}/m`, 'member'])
  git(`${mw}/m`, ['config', 'user.name', 'T'])
  git(`${mw}/m`, ['config', 'user.email', 't@example.invalid'])
  putFile(`${mw}/m`, 'src/s/new.ts', 'export {}\n', 'member work')
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 0, res.stderr + res.stdout)
  const j = assertOneLine(res)
  assert.equal(j.merged, true)
  assert.equal(j.head, head(wt))
  assert.notEqual(j.head, start)
  assert.equal(git(wt, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3, 'a merge commit with two parents even though a fast-forward was possible')
  assert.ok(existsSync(`${wt}/src/s/new.ts`))
  // idempotent: the branch is already in
  const again = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(again.status, 0)
  assert.equal(again.stdout, res.stdout)
})

test('integrate: a conflict leaves the merge in progress, lists the paths, exit 1', () => {
  const { env, wt } = crewEnv()
  git(env.repo, ['branch', 'member', 'foundry-s'])
  const mw = tmp('fcli-member-')
  git(env.repo, ['worktree', 'add', '-q', `${mw}/m`, 'member'])
  git(`${mw}/m`, ['config', 'user.name', 'T'])
  git(`${mw}/m`, ['config', 'user.email', 't@example.invalid'])
  putFile(`${mw}/m`, 'a.txt', 'member side\n', 'member edit')
  putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
  const res = env.run('integrate', { slug: 's', branch: 'member' })
  assert.equal(res.status, 1)
  const j = assertOneLine(res)
  assert.equal(j.merged, false)
  assert.deepEqual(j.conflicts, ['a.txt'])
  assert.equal(gitStatus(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), 0, 'the merge is left in progress')
})

test('sync: merges the target into the crew branch (a merge commit, the crew\'s own commits stay ancestors)', () => {
  const { env, wt } = crewEnv()
  const crewCommit = putFile(wt, 'src/s/mine.ts', 'mine\n', 'crew work')
  const targetHead = putFile(env.repo, 'other.txt', 'other\n', 'target moves')
  const res = env.run('sync', { slug: 's' })
  assert.equal(res.status, 0, res.stderr + res.stdout)
  const j = assertOneLine(res)
  assert.deepEqual(Object.keys(j), ['merged', 'head'])
  assert.equal(j.merged, true)
  assert.equal(j.head, head(wt))
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', targetHead, 'HEAD']), 0)
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', crewCommit, 'HEAD']), 0, 'never a rebase: the crew commit keeps its sha')
  assert.ok(existsSync(`${wt}/other.txt`))
})

test('sync: when the target has nothing new it merges nothing and is idempotent', () => {
  const { env, wt } = crewEnv()
  putFile(wt, 'src/s/mine.ts', 'mine\n', 'crew work')
  const a = env.run('sync', { slug: 's' })
  const b = env.run('sync', { slug: 's' })
  assert.equal(a.status, 0)
  assert.equal(a.stdout, b.stdout)
  assert.equal(assertOneLine(a).head, head(wt))
  putFile(env.repo, 'other.txt', 'other\n', 'target moves')
  const c = env.run('sync', { slug: 's' })
  const d = env.run('sync', { slug: 's' })
  assert.equal(c.stdout, d.stdout, 'a second sync after the merge changes nothing')
})

test('sync: a conflict leaves the merge in progress and lists the paths, exit 1', () => {
  const { env, wt } = crewEnv()
  putFile(wt, 'a.txt', 'crew side\n', 'crew edit')
  putFile(env.repo, 'a.txt', 'target side\n', 'target edit')
  const res = env.run('sync', { slug: 's' })
  assert.equal(res.status, 1)
  const j = assertOneLine(res)
  assert.equal(j.merged, false)
  assert.deepEqual(j.conflicts, ['a.txt'])
  assert.equal(gitStatus(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), 0)
})

test('owns-check: files inside the owns globs are ok, files outside are listed (exit 1)', () => {
  const { env, wt } = crewEnv(['src/s/**', 'docs/*.md'])
  putFile(wt, 'src/s/deep/a.ts', 'a\n', 'inside')
  putFile(wt, 'docs/readme.md', 'd\n', 'inside too')
  const ok = env.run('owns-check', { slug: 's' })
  assert.equal(ok.status, 0, ok.stdout)
  assert.deepEqual(assertOneLine(ok), { ok: true })
  putFile(wt, 'lib/out.ts', 'x\n', 'outside')
  putFile(wt, 'docs/sub/n.md', 'x\n', 'outside: * does not cross /')
  const bad = env.run('owns-check', { slug: 's' })
  assert.equal(bad.status, 1)
  const j = assertOneLine(bad)
  assert.equal(j.ok, false)
  assert.deepEqual([...j.outside].sort(), ['docs/sub/n.md', 'lib/out.ts'])
  assert.equal(env.run('owns-check', { slug: 's' }).stdout, bad.stdout, 'idempotent')
})

test('owns-check: no change at all is ok', () => {
  const { env } = crewEnv()
  assert.deepEqual(assertOneLine(env.run('owns-check', { slug: 's' })), { ok: true })
})

test('owns-check: <base> is the merge-base with the target, so after a sync another crew\'s merged files are not listed', () => {
  const { env, wt, start } = crewEnv()
  putFile(wt, 'src/s/mine.ts', 'mine\n', 'crew work')
  assert.equal(git(wt, ['merge-base', 'main', 'HEAD']), start, 'before a sync the base is the start head')
  assert.deepEqual(assertOneLine(env.run('owns-check', { slug: 's' })), { ok: true })
  // another crew's work lands on the target, outside this crew's owns
  const targetHead = putFile(env.repo, 'src/other/z.ts', 'z\n', 'another crew merged')
  assert.deepEqual(assertOneLine(env.run('owns-check', { slug: 's' })), { ok: true }, 'unsynced: still only the crew\'s own commits')
  assert.equal(env.run('sync', { slug: 's' }).status, 0)
  assert.equal(git(wt, ['merge-base', 'main', 'HEAD']), targetHead, 'after a sync the base is the merged target head')
  const after = env.run('owns-check', { slug: 's' })
  assert.equal(after.status, 0, `another crew's src/other/z.ts must not be listed: ${after.stdout}`)
  assert.deepEqual(assertOneLine(after), { ok: true })
  // and the crew's own stray file after the sync is still caught
  putFile(wt, 'lib/stray.ts', 's\n', 'stray')
  const stray = env.run('owns-check', { slug: 's' })
  assert.equal(stray.status, 1)
  assert.deepEqual(assertOneLine(stray).outside, ['lib/stray.ts'])
})

// ---------------------------------------------------------------------------------------------------------------
// roles.json (Decision 2)

const TABLE = {
  architect: ['foundry:architect', 'opus', 'medium', 'worktree'],
  cynic: ['foundry:cynic', 'opus', 'medium', 'none'],
  planner: ['foundry:crew-planner', 'opus', 'medium', 'none'],
  tester: ['general-purpose', 'sonnet', 'medium', 'worktree'],
  builder: ['general-purpose', 'sonnet', 'medium', 'worktree'],
  resolver: ['general-purpose', 'sonnet', 'medium', 'none'],
  writer: ['foundry:writer', 'opus', 'medium', 'worktree'],
  rca: ['general-purpose', 'opus', 'medium', 'none'],
  redteam: ['foundry:judge', 'opus', 'medium', 'worktree'],
  judge: ['foundry:judge', 'opus', 'medium', 'none'],
  runner: ['general-purpose', 'sonnet', 'low', 'none'],
}

const tableRoles = () => Object.fromEntries(Object.entries(TABLE).map(([k, [agentType, model, effort, isolation]]) => [k, { agentType, model, effort, isolation }]))

test('roles.json: passes the real workflowRoleVerdict', () => {
  assert.equal(workflowRoleVerdict(rolesJson()), undefined)
})

test('roles.json: matches the Decision 2 table exactly, no lead, devops or integrator', () => {
  const roles = rolesJson()
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(TABLE).sort())
  for (const [key, [agentType, model, effort, isolation]] of Object.entries(TABLE)) {
    const r = roles[key]
    assert.equal(r.agentType, agentType, `${key}.agentType`)
    assert.equal(r.model, model, `${key}.model`)
    assert.equal(r.effort, effort, `${key}.effort`)
    assert.equal(r.isolation, isolation, `${key}.isolation`)
  }
  for (const banned of ['lead', 'devops', 'integrator']) assert.ok(!(banned in roles))
  for (const r of Object.values(roles)) assert.ok(!['foundry:lead', 'foundry:devops', 'foundry:integrator'].includes(r.agentType))
})

test('roles.json: the lead\'s shape - typeFromProject on tester and builder, "builder" on resolver, nowhere else', () => {
  const roles = rolesJson()
  assert.equal(roles.tester.typeFromProject, true)
  assert.equal(roles.builder.typeFromProject, true)
  assert.equal(roles.resolver.typeFromProject, 'builder')
  for (const [k, r] of Object.entries(roles)) {
    if (!['tester', 'builder', 'resolver'].includes(k)) assert.ok(!('typeFromProject' in r), `${k} has no typeFromProject`)
    assert.deepEqual(Object.keys(r).filter((x) => x !== 'typeFromProject'), ['agentType', 'model', 'effort', 'isolation'], `${k} keys`)
  }
})

function startEnv() {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's')
  return env
}

test('start --type builder=kit:builder changes builder and resolver only', () => {
  const env = startEnv()
  const res = env.run('start', { wave: 'next', type: 'builder=kit:builder' })
  assert.equal(res.status, 0, res.stderr + res.stdout)
  const roles = assertOneLine(res).foundry.roles
  const base = JSON.parse(readFileSync(`${env.plugin}/workflows/roles.json`, 'utf8'))
  assert.equal(roles.builder.agentType, 'kit:builder')
  assert.equal(roles.resolver.agentType, 'kit:builder')
  for (const k of Object.keys(base)) if (k !== 'builder' && k !== 'resolver') assert.deepEqual(roles[k], base[k], k)
  assert.equal(roles.builder.model, 'sonnet')
  assert.equal(workflowRoleVerdict(roles), undefined)
})

test('start --type tester=kit:test-writer changes tester only', () => {
  const env = startEnv()
  const roles = assertOneLine(env.run('start', { wave: 'next', type: 'tester=kit:test-writer' })).foundry.roles
  const base = JSON.parse(readFileSync(`${env.plugin}/workflows/roles.json`, 'utf8'))
  assert.equal(roles.tester.agentType, 'kit:test-writer')
  assert.equal(roles.builder.agentType, base.builder.agentType)
  assert.equal(roles.resolver.agentType, base.resolver.agentType)
})

test('start --type for a role without typeFromProject (judge) or an unknown role is a usage error, and starts nothing', () => {
  for (const bad of ['judge=x', 'nope=x']) {
    const env = startEnv()
    assertUsageError(env.run('start', { wave: 'next', type: bad }))
    assert.equal(readPlan(env.dir).crews[0].status, 'planned', `${bad}: the crew must not start`)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// the label parse (Decision 1, "Labels")

test('label parse: crews x and x-test with roles tester and writer give four distinct labels, x-test-writer only (x-test, writer)', async () => {
  const mod = await import(pathToFileURL(REAL_FACTORY).href)
  assert.equal(typeof mod.parseLabel, 'function', 'bin/factory.ts exports parseLabel(label)')
  const p = mod.parseLabel
  const labels = ['x-tester', 'x-writer', 'x-test-tester', 'x-test-writer']
  const parsed = labels.map((l) => p(l))
  assert.deepEqual(parsed.map((r) => [r.slug, r.role]), [['x', 'tester'], ['x', 'writer'], ['x-test', 'tester'], ['x-test', 'writer']])
  assert.equal(new Set(parsed.map((r) => `${r.slug}/${r.role}`)).size, 4)
})

test('label parse: a trailing -<n> (n >= 2) is stripped first; foundry-architect-2 is slug foundry', async () => {
  const p = (await import(pathToFileURL(REAL_FACTORY).href)).parseLabel
  const a = p('foundry-architect-2')
  assert.deepEqual([a.slug, a.role, a.n], ['foundry', 'architect', 2])
  const j = p('x-test-judge-12')
  assert.deepEqual([j.slug, j.role, j.n], ['x-test', 'judge', 12])
  const plain = p('s-judge')
  assert.deepEqual([plain.slug, plain.role], ['s', 'judge'])
  assert.ok(plain.n === undefined || plain.n === 1)
  assert.equal(p('foundry-cynic').slug, 'foundry')
})

test('label parse: a label with no role segment does not parse', async () => {
  const p = (await import(pathToFileURL(REAL_FACTORY).href)).parseLabel
  assert.equal(p('solo'), undefined)
  assert.equal(p(''), undefined)
})

test('workflowRoleVerdict refuses a role key with a hyphen or a digit (real export)', () => {
  const ok = { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' }
  for (const key of ['test-writer', 'crew-planner', 'tester2', 'r2d2', 'Tester', 'tester_']) {
    const verdict = workflowRoleVerdict({ ...tableRoles(), [key]: ok })
    assert.ok(verdict && typeof verdict.deny === 'string', `key ${key} must be refused`)
  }
  assert.equal(workflowRoleVerdict({ ...tableRoles(), extra: ok }), undefined)
})

// ---------------------------------------------------------------------------------------------------------------
// events.schema.json: every line factory.ts appends must validate (an in-repo validator reads the real schema)

const TS = '2026-10-29T10:00:00.000Z'

test('schema: a factory spawn line (agentId null, type workflow-crew, by factory) validates', () => {
  const line = '{"v":1,"ts":"2026-10-29T10:00:00.000Z","event":"spawn","crew":"s","agent":"s","agentId":null,"type":"workflow-crew","model":null,"effort":null,"by":"factory"}'
  assert.deepEqual(validateEvent(line), [])
})

test('schema: workflow spawn lines validate (model and effort set, or null)', () => {
  const base = { v: 1, ts: TS, event: 'spawn', crew: 's', agent: 's-judge', agentId: 'a1b2c3', type: 'foundry:judge', by: 'workflow:wf_x' }
  assert.deepEqual(validateEvent({ ...base, model: 'claude-opus-5-5', effort: 'medium' }), [])
  assert.deepEqual(validateEvent({ ...base, model: null, effort: null }), [])
})

test('schema: the incomplete line {v,ts,event,crew,agent,run} validates', () => {
  const line = '{"v":1,"ts":"2026-10-29T10:00:00.000Z","event":"incomplete","crew":"s","agent":"s","run":"wf_25508836-f05"}'
  assert.deepEqual(validateEvent(line), [])
})

test('schema: an incomplete line without run is refused, for the missing run', () => {
  const errs = validateEvent({ v: 1, ts: TS, event: 'incomplete', crew: 's', agent: 's' })
  assert.ok(errs.length > 0)
  assert.ok(errs.some((e) => /required run/.test(e)), `the error names run: ${errs.join(' | ')}`)
})

test('schema: an incomplete line with an extra field is refused, for the extra field', () => {
  const errs = validateEvent({ v: 1, ts: TS, event: 'incomplete', crew: 's', agent: 's', run: 'wf_x', extra: 1 })
  assert.ok(errs.length > 0)
  assert.ok(errs.some((e) => /additionalProperties extra/.test(e)), `the error names extra: ${errs.join(' | ')}`)
})

test('schema: an incomplete line with an empty run is refused', () => {
  const errs = validateEvent({ v: 1, ts: TS, event: 'incomplete', crew: 's', agent: 's', run: '' })
  assert.ok(errs.some((e) => /run/.test(e)), errs.join(' | '))
})

test('schema: a spawn line with an extra field or without by is still refused', () => {
  const ok = { v: 1, ts: TS, event: 'spawn', crew: 's', agent: 's', agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' }
  assert.ok(validateEvent({ ...ok, extra: 1 }).length > 0)
  const { by, ...noBy } = ok
  assert.ok(validateEvent(noBy).length > 0)
})

test('schema: the validator is sound - it refuses a bad v, a non-ISO ts and an unknown event', () => {
  assert.ok(validateEvent({ v: 2, ts: TS, event: 'spawn', crew: 's', agent: 's' }).length > 0)
  assert.ok(validateEvent({ v: 1, ts: 'yesterday', event: 'budget-spent', crew: 's', agent: 's' }).length > 0)
  assert.ok(validateEvent({ v: 1, ts: TS, event: 'bogus', crew: 's', agent: 's' }).length > 0)
  assert.deepEqual(validateEvent({ v: 1, ts: TS, event: 'budget-spent', crew: 's', agent: 's-judge' }), [])
})

test('schema: the existing event kinds still validate', () => {
  const lines = [
    { v: 1, ts: TS, event: 'stall', crew: 's', agent: 's-x', kind: 'agent', minutes: 20 },
    { v: 1, ts: TS, event: 'tag', crew: 's', agent: 's', tag: 'QUESTION' },
    { v: 1, ts: TS, event: 'report', crew: 's', agent: 's-judge', marker: 'VERDICT: PASS' },
    { v: 1, ts: TS, event: 'report', crew: 's', agent: 's-x', marker: null },
    { v: 1, ts: TS, event: 'budget-spent', crew: 's', agent: 's-judge-3' },
    { v: 1, ts: TS, event: 'fetch', crew: 's', agent: 's-x', tool: 'WebFetch', url: 'https://example.com/a' },
    { v: 1, ts: TS, event: 'fetch', crew: 'main', agent: 'main', tool: 'WebSearch', query: 'foundry' },
    { v: 1, ts: TS, event: 'spawn', crew: 's', agent: 's', agentId: 'a1', type: 'foundry:lead', model: 'opus', effort: 'medium', by: 'main' },
  ]
  for (const l of lines) assert.deepEqual(validateEvent(l), [], JSON.stringify(l))
})

test('schema: sample lines of a real events.jsonl still validate', () => {
  const p = `${REAL_REPO}/.git/foundry`
  let sample = []
  try {
    for (const d of readdirSync(p)) {
      const f = `${p}/${d}/events.jsonl`
      if (!existsSync(f)) continue
      const kinds = new Set(['spawn', 'stall', 'tag', 'report', 'budget-spent', 'fetch'])
      sample = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => kinds.has(e.event)).slice(0, 40)
      if (sample.length) break
    }
  } catch {}
  for (const l of sample) assert.deepEqual(validateEvent(l), [], JSON.stringify(l))
})

test('schema: every line start appends validates (the factory spawn line)', () => {
  const env = startEnv()
  assert.equal(env.run('start', { wave: 'next' }).status, 0)
  const events = readEvents(env.dir)
  assert.ok(events.some((e) => e.event === 'spawn' && e.by === 'factory' && e.crew === 's'))
  for (const ev of events) assert.deepEqual(validateEvent(ev), [], JSON.stringify(ev))
})

// ---------------------------------------------------------------------------------------------------------------
// finish in single merge mode

test('finish: merge single exits 2 with exactly {"error":"single merge mode runs on the lead path"}', () => {
  const env = mkEnv({ config: { merge: 'single' } })
  writePlan(env.dir, planObj([crew('s', { status: 'running' })]))
  const { dir: t } = mkRun(env.transcripts, 'wf_one', [])
  const result = `${env.dir}/result.json`
  writeFileSync(result, '[]')
  for (const extra of [{ result }, {}]) {
    const res = env.run('finish', { transcript: t, ...extra })
    assert.equal(res.status, 2)
    assert.equal(res.stdout, '{"error":"single merge mode runs on the lead path"}\n')
  }
})

// ---------------------------------------------------------------------------------------------------------------
// the real tree: the script copies the tests rely on

test('the plugin copy used by these tests carries stub plan.js and wave.js, never another crew\'s scripts', () => {
  const copy = pluginCopy()
  assert.match(readFileSync(`${copy}/workflows/plan.js`, 'utf8'), /stub/)
  assert.match(readFileSync(`${copy}/workflows/wave.js`, 'utf8'), /stub/)
})

test('harness: mkRun writes the same file shapes as the static sample-run fixture (copied from the probe)', () => {
  const sample = `${flat(new URL('./fixtures/workflow-run/sample-run', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')}`
  const t = tmp('fcli-shape-')
  const { dir } = mkRun(t, 'wf_shape', [{ id: 'ajudge1', label: 's-judge', agentType: 'foundry:judge', metaModel: 'opus', effort: 'medium' }, { id: 'abuild1', label: 's-builder', effort: 'low', tools: [{ name: 'Write', file_path: 'x' }] }])
  const keys = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => Object.keys(JSON.parse(l)).join(','))
  assert.deepEqual(keys(`${dir}/journal.jsonl`).slice(0, 3), keys(`${sample}/journal.jsonl`).slice(0, 3))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(`${dir}/agent-ajudge1.meta.json`, 'utf8'))), Object.keys(JSON.parse(readFileSync(`${sample}/agent-ajudge1.meta.json`, 'utf8'))))
  assert.ok(!('model' in JSON.parse(readFileSync(`${dir}/agent-abuild1.meta.json`, 'utf8'))), 'no model key when the script gave none')
  const rec = readFileSync(`${dir}/agent-ajudge1.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(rec.every((r) => typeof r.timestamp === 'string'))
  assert.equal(rec.find((r) => r.type === 'assistant').message.model, 'claude-opus-5-5')
  assert.equal(rec.find((r) => r.type === 'api-request-blob').message.output_config.effort, 'medium')
})

// Case files written after this one register their tests by being loaded here.
for (const file of caseFiles()) await import(pathToFileURL(file).href)
