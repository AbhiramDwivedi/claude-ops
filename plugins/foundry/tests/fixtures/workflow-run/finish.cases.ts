// @ts-nocheck
// `finish` cases for the factory CLI (foundry ADR-0009 Decision 1: record step, session audit, merge step, labels,
// gates kept, seams). Loaded by tests/factory.check.ts. Written from the ADR before bin/factory.ts existed.
//
// Assumptions the ADR leaves open (each is also listed in the test-writer report):
// - a run that merges nothing because a gate said no exits 1; a clean merge exits 0;
// - a step-1 gate refusal lists the crew under `refused`; "newest judge not a clean PASS" only means "not merged, still running";
// - an `audit` entry for a record-step problem is labelled with the bare Workflow label, a session-audit one `<runId>/<label>`
//   (tests look for the label as a substring so either spelling passes);
// - a spawn line's `model` and `effort` are the strings the transcript carries ("claude-sonnet-5-5", "medium");
// - the `judge` field of a `passed` result is informational: finish reads judge files from reports/;
// - member worktrees are found through `git worktree list`; the test names them foundry-<crew>-<member>;
// - `bin/factory.ts` exports `mergeHeadVerdict(plan, judge, head, patch): {block:string}|undefined` and does not run on import.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as reg from '../../../hooks/register.ts'
import {
  REAL_FACTORY, addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, git, gitStatus, head, judgeReport, mkEnv, mkRun, planObj,
  putFile, readEvents, readPlan, validateEvent, writePlan, writeReport,
} from './harness.ts'

const APPROVED = '2026-10-01T00:00:00.000Z'
const CFG = { merge: 'sequential', target: 'main' }
const OLD_SPAWN = () => new Date(Date.now() - 3 * 3600_000).toISOString()
const KEYS = ['merged', 'rework', 'blocked', 'refused', 'audit', 'incomplete']
const AAA = 'a'.repeat(40)
const BBB = 'b'.repeat(40)

/** The patch id of base...hd in `cwd`, computed with the exported PATCH_COMMAND; undefined for an empty diff. */
function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

const writeCheck = (dir, slug, n, exit, hd) => {
  mkdirSync(`${dir}/checks`, { recursive: true })
  writeFileSync(`${dir}/checks/${slug}-${n}.json`, JSON.stringify({ command: 'true', exit, head: hd, tail: '' }))
}

/**
 * One finish world. specs: [{slug, wave, status, spawn (false: no factory spawn line), spawnTs, worktree (false), files [[rel,text]...]
 * (default one file inside owns), doneCheck, owns, amend, red (false: no red record, number: red exit)}].
 * o: {skip (slugs with no agents in the run), config, plan (laid on the plan), judge (false: no judge agent), judgeLabel, judgeText(c), builder (agent overrides),
 * agents(slug, [builder, judge]) -> list, extraAgents, tweak(agent) -> overrides for every agent, runOpts, runId, results}.
 */
function scenario(specs, o = {}) {
  const env = mkEnv({ config: o.config ?? CFG })
  const crews = specs.map((sp) => crew(sp.slug, { wave: sp.wave ?? 1, status: sp.status ?? 'running', owns: sp.owns ?? [`src/${sp.slug}/**`], doneCheck: sp.doneCheck ?? 'true' }))
  writePlan(env.dir, planObj(crews, { approvedAt: APPROVED, ...(o.plan ?? {}) }))
  const c = {}
  for (const sp of specs) {
    const slug = sp.slug
    if (sp.spawn !== false && (sp.status ?? 'running') === 'running') appendEvent(env.dir, factorySpawn(slug, sp.spawnTs ?? OLD_SPAWN()))
    if (sp.worktree === false || (sp.status ?? 'running') !== 'running') continue
    const wt = addCrewWorktree(env.repo, slug)
    for (const [rel, text] of sp.files ?? [[`src/${slug}/a.ts`, `${slug}\n`]]) putFile(wt, rel, text, `work ${rel}`)
    const base = git(wt, ['merge-base', 'main', 'HEAD'])
    let hd = head(wt)
    const patch = hd === base ? undefined : patchId(wt, base, hd)
    const oldHead = hd
    if (sp.amend) {
      git(wt, ['commit', '--amend', '-q', '-m', 'reworded'])
      hd = head(wt)
    }
    c[slug] = { slug, wt, base, head: hd, oldHead, patch }
    if (sp.red !== false) writeCheck(env.dir, slug, 1, typeof sp.red === 'number' ? sp.red : 1, hd)
  }
  const w = { env, c, mainBefore: git(env.repo, ['rev-parse', 'main']), specs }
  const slugs = Object.keys(c).filter((s) => !(o.skip ?? []).includes(s))
  const agents = []
  for (const slug of slugs) {
    const cc = c[slug]
    const builder = { label: `${slug}-builder`, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...(o.builder ?? {}) }
    const judge = o.judge === false ? undefined : {
      label: o.judgeLabel ?? `${slug}-judge`, agentType: 'foundry:judge', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium',
      result: o.judgeText ? o.judgeText(cc) : judgeReport({ head: cc.head, patch: cc.patch }),
    }
    const pair = [builder, judge].filter(Boolean)
    agents.push(...(o.agents ? o.agents(slug, pair) : pair))
  }
  agents.push(...(o.extraAgents ?? []))
  const tweaked = agents.map((a) => ({ ...a, ...(o.tweak ? o.tweak(a) : {}) }))
  const run = mkRun(env.transcripts, o.runId ?? 'wf_1', tweaked, o.runOpts ?? {})
  w.t = run.dir
  w.ids = run.ids
  w.resFile = `${env.dir}/result.json`
  const results = o.results ?? slugs.map((s) => ({ slug: s, state: 'passed', head: c[s].head, base: c[s].base, judge: `${s}-judge` }))
  writeFileSync(w.resFile, JSON.stringify(results))
  w.finish = () => env.run('finish', { transcript: w.t, result: w.resFile })
  w.finishNoResult = () => env.run('finish', { transcript: w.t })
  return w
}

const listed = (j, key, slug) => (j[key] ?? []).some((x) => (typeof x === 'string' ? x : x.slug) === slug)
const entry = (j, key, slug) => (j[key] ?? []).find((x) => x.slug === slug)
const statusOf = (w, slug) => readPlan(w.env.dir).crews.find((x) => x.slug === slug).status
const mainNow = (w) => git(w.env.repo, ['rev-parse', 'main'])

/** The crew was not merged: not listed as merged, plan.json still running, the target unchanged. */
function assertHeld(w, j, slug = 's') {
  assert.ok(!listed(j, 'merged', slug), `${slug} must not be merged: ${JSON.stringify(j)}`)
  assert.equal(statusOf(w, slug), 'running')
  assert.equal(mainNow(w), w.mainBefore, 'the target is unchanged')
}
function assertMerged(w, j, slug = 's') {
  assert.ok(listed(j, 'merged', slug), JSON.stringify(j))
  assert.equal(statusOf(w, slug), 'merged')
}
const dirListing = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : [])

// ---------------------------------------------------------------------------------------------------------------
// output shape

test('finish --result: a clean pass prints one line with the six keys in order, merges, exits 0', () => {
  const w = scenario([{ slug: 's' }])
  const res = w.finish()
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.deepEqual(Object.keys(j), KEYS)
  assert.deepEqual(j.merged, ['s'])
  assert.deepEqual([j.rework, j.blocked, j.refused, j.incomplete], [[], [], [], []])
  assert.equal(statusOf(w, 's'), 'merged')
  assert.equal(mainNow(w), w.c.s.head, 'fast-forwarded to the crew head')
})

test('finish: a refusal exits 1 and keeps the six keys', () => {
  const w = scenario([{ slug: 's', red: false }])
  const res = w.finish()
  const j = assertOneLine(res)
  assert.equal(res.status, 1)
  assert.deepEqual(Object.keys(j), KEYS)
  assertHeld(w, j)
})

// ---------------------------------------------------------------------------------------------------------------
// record step

test('record step: reports, mtimes and schema-valid events for every crew label', () => {
  const w = scenario([{ slug: 's' }], { builder: { result: { report: 'REPORT BODY\n', files: ['x'] }, endTs: '2026-10-29T10:07:09.000Z' } })
  const j = assertOneLine(w.finish())
  assertMerged(w, j)
  const bp = `${w.env.dir}/reports/s/s-builder.md`
  assert.equal(readFileSync(bp, 'utf8').trim(), 'REPORT BODY', 'a schema result is written as its report field')
  assert.equal(readFileSync(`${w.env.dir}/reports/s/s-judge.md`, 'utf8').trim(), judgeReport({ head: w.c.s.head, patch: w.c.s.patch }).trim())
  assert.ok(Math.abs(statSync(bp).mtimeMs - Date.parse('2026-10-29T10:07:09.000Z')) < 1500, 'mtime is the last transcript timestamp')
  const ev = readEvents(w.env.dir).filter((e) => e.by === 'workflow:wf_1')
  const spawns = ev.filter((e) => e.event === 'spawn')
  assert.equal(spawns.length, 2)
  const sb = spawns.find((e) => e.agentId === w.ids['s-builder'])
  const sj = spawns.find((e) => e.agentId === w.ids['s-judge'])
  assert.ok(sb && sj)
  assert.equal(sb.type, 'general-purpose')
  assert.equal(sj.type, 'foundry:judge')
  assert.equal(sb.model, 'claude-sonnet-5-5')
  assert.equal(sb.effort, 'medium')
  assert.equal(sj.model, 'claude-opus-5-5')
  const reports = readEvents(w.env.dir).filter((e) => e.event === 'report' && e.crew === 's' && ['s-builder', 's-judge'].includes(e.agent))
  assert.equal(reports.length, 2)
  assert.ok(reports.some((e) => e.marker === 'VERDICT: PASS'))
  for (const e of readEvents(w.env.dir)) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

test('record step: labels that do not parse, name no running factory crew, or carry an unknown role are audited and filed nowhere', () => {
  const bad = ['zzz', 'ghost-builder', 's-wizard', 'p-builder', 'l-builder']
  const w = scenario([{ slug: 's' }, { slug: 'p', status: 'planned' }, { slug: 'l', spawn: false }], {
    extraAgents: bad.map((label) => ({ label, metaModel: 'sonnet' })),
  })
  const j = assertOneLine(w.finish())
  for (const label of bad) assert.ok(j.audit.some((a) => String(a.label).includes(label)), `audit entry for ${label}: ${JSON.stringify(j.audit)}`)
  const files = dirListing(`${w.env.dir}/reports`)
  for (const f of files) assert.ok(!/ghost|wizard|zzz|^p[\\/]|^l[\\/]/.test(f), `unexpected report ${f}`)
  assert.ok(files.some((f) => f.endsWith('s-builder.md')))
})

const AUDITS = [
  ['meta without model', { builder: { metaModel: undefined } }],
  ['transcript model claude-fable-x', { builder: { model: 'claude-fable-x' } }],
  ['transcript model haiku', { builder: { model: 'claude-haiku-4-5' } }],
  ['effort max', { builder: { effort: 'max' } }],
  ['effort high', { builder: { effort: 'high' } }],
  ['effort xhigh', { builder: { effort: 'xhigh' } }],
  ['judge run as general-purpose', { agents: (s, [b, jd]) => [b, { ...jd, agentType: 'general-purpose' }] }],
  ['judge with a Write tool use', { agents: (s, [b, jd]) => [b, { ...jd, tools: [{ name: 'Write', file_path: 'x.md' }] }] }],
  ['judge with an Edit tool use', { agents: (s, [b, jd]) => [b, { ...jd, tools: [{ name: 'Edit', file_path: 'x.md' }] }] }],
]
for (const [name, opts] of AUDITS) {
  test(`audit: ${name} gives an audit entry naming the agent and the crew is not merged`, () => {
    const w = scenario([{ slug: 's' }], opts)
    const j = assertOneLine(w.finish())
    assert.ok(j.audit.length >= 1, JSON.stringify(j))
    assert.ok(j.audit.every((a) => typeof a.label === 'string' && typeof a.why === 'string' && a.why.length > 0))
    const label = opts.builder ? 's-builder' : 's-judge'
    assert.ok(j.audit.some((a) => String(a.label).includes(label)), `${label} in ${JSON.stringify(j.audit)}`)
    assertHeld(w, j)
  })
}

test('audit: a redteam label run as a type other than foundry:judge is audited', () => {
  const w = scenario([{ slug: 's' }], { extraAgents: [{ label: 's-redteam', agentType: 'general-purpose', metaModel: 'opus', effort: 'medium' }] })
  const j = assertOneLine(w.finish())
  assert.ok(j.audit.some((a) => String(a.label).includes('s-redteam')), JSON.stringify(j.audit))
  assertHeld(w, j)
})

test('record step: an existing report with different text is audited and not overwritten; the same text is not', () => {
  const w = scenario([{ slug: 's' }], { judge: false })
  writeReport(w.env.dir, 's', 's-builder', 'DIFFERENT\n', Date.parse('2026-10-29T09:00:00Z'))
  const j = assertOneLine(w.finish())
  assert.equal(readFileSync(`${w.env.dir}/reports/s/s-builder.md`, 'utf8'), 'DIFFERENT\n')
  assert.ok(j.audit.some((a) => String(a.label).includes('s-builder')), JSON.stringify(j.audit))
  const w2 = scenario([{ slug: 's' }], { judge: false })
  writeReport(w2.env.dir, 's', 's-builder', 'built it', Date.parse('2026-10-29T09:00:00Z'))
  const j2 = assertOneLine(w2.finish())
  assert.ok(!j2.audit.some((a) => String(a.label).includes('s-builder')), JSON.stringify(j2.audit))
})

test('finish is idempotent: twice gives the same output, files and event lines', () => {
  const w = scenario([{ slug: 's' }], { judgeText: (c) => judgeReport({ verdict: 'FAIL', head: c.head, patch: c.patch }) })
  const r1 = w.finish()
  const snap = () => ({
    files: dirListing(`${w.env.dir}/reports`).map((f) => [f, statSync(`${w.env.dir}/reports/${f}`).isFile() ? readFileSync(`${w.env.dir}/reports/${f}`, 'utf8') : '']),
    events: readFileSync(`${w.env.dir}/events.jsonl`, 'utf8'),
    plan: readFileSync(`${w.env.dir}/plan.json`, 'utf8'),
  })
  const s1 = snap()
  const r2 = w.finish()
  assert.equal(r2.stdout, r1.stdout)
  assert.equal(r2.status, r1.status)
  assert.deepEqual(snap(), s1)
})

// ---------------------------------------------------------------------------------------------------------------
// finish without --result

const MIN = 60_000
const HOURS3 = () => Date.now() - 3 * 3600_000

test('no --result: a recent agent transcript write refuses with "run may be live" and writes nothing', () => {
  const w = scenario([{ slug: 's' }], { tweak: () => ({ mtimeMs: HOURS3() }), runOpts: { journalMtimeMs: HOURS3() } })
  const one = readdirSync(w.t).find((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  const recent = Date.now() / 1000 - 5 * 60
  utimesSync(`${w.t}/${one}`, recent, recent)
  const eventsBefore = readFileSync(`${w.env.dir}/events.jsonl`, 'utf8')
  const res = w.finishNoResult()
  const j = assertOneLine(res)
  assert.equal(res.status, 1)
  assert.equal(entry(j, 'refused', 's')?.why, 'run may be live', JSON.stringify(j))
  assert.deepEqual(j.incomplete, [])
  assert.deepEqual(dirListing(`${w.env.dir}/reports`).filter((f) => f.endsWith('.md')), [], 'no reports written')
  assert.equal(readFileSync(`${w.env.dir}/events.jsonl`, 'utf8'), eventsBefore, 'no events written')
})

test('no --result: a recent journal write, or a spawn line younger than 30 minutes, also refuses', () => {
  const a = scenario([{ slug: 's' }], { tweak: () => ({ mtimeMs: HOURS3() }), runOpts: { journalMtimeMs: Date.now() - 2 * MIN } })
  assert.equal(entry(assertOneLine(a.finishNoResult()), 'refused', 's')?.why, 'run may be live')
  const b = scenario([{ slug: 's', spawnTs: new Date(Date.now() - 2 * MIN).toISOString() }], { tweak: () => ({ mtimeMs: HOURS3() }), runOpts: { journalMtimeMs: HOURS3() } })
  const jb = assertOneLine(b.finishNoResult())
  assert.equal(entry(jb, 'refused', 's')?.why, 'run may be live')
  assert.deepEqual(dirListing(`${b.env.dir}/reports`).filter((f) => f.endsWith('.md')), [])
})

test('no --result on an old run: records and audits, merges nothing, writes one incomplete line per crew, lists the slugs', () => {
  const w = scenario([{ slug: 's' }, { slug: 'u' }], { tweak: () => ({ mtimeMs: HOURS3() }), runOpts: { journalMtimeMs: HOURS3() } })
  const res = w.finishNoResult()
  const j = assertOneLine(res)
  assert.deepEqual(Object.keys(j), KEYS)
  assert.deepEqual([...j.incomplete].sort(), ['s', 'u'])
  assert.deepEqual(j.merged, [])
  assertHeld(w, j, 's')
  assert.equal(statusOf(w, 'u'), 'running')
  assert.ok(existsSync(`${w.env.dir}/reports/s/s-judge.md`) && existsSync(`${w.env.dir}/reports/u/u-builder.md`), 'record step ran')
  const inc = readEvents(w.env.dir).filter((e) => e.event === 'incomplete')
  assert.equal(inc.length, 2)
  for (const e of inc) {
    assert.equal(e.v, 1)
    assert.equal(e.run, 'wf_1')
    assert.equal(e.agent, e.crew)
    assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
  }
  const again = w.finishNoResult()
  assert.equal(again.stdout, res.stdout)
  assert.equal(readEvents(w.env.dir).filter((e) => e.event === 'incomplete').length, 2, 'no duplicate incomplete lines')
  for (const e of readEvents(w.env.dir)) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

// ---------------------------------------------------------------------------------------------------------------
// session audit

const stray = (over = {}) => ({ label: 'weird', agentType: 'foundry:judge', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', startTs: '2026-10-29T09:00:00.000Z', ...over })
const withRun = (w, runId, agents) => mkRun(w.env.transcripts, runId, agents)

test('session audit: a foundry:* agent in a run that is not foundry\'s audits it, refuses every crew of the wave, merges nothing', () => {
  const w = scenario([{ slug: 's' }, { slug: 'u' }, { slug: 'late', wave: 2, status: 'planned' }])
  withRun(w, 'wf_other', [stray()])
  const j = assertOneLine(w.finish())
  assert.ok(j.audit.some((a) => a.label === 'wf_other/weird'), JSON.stringify(j.audit))
  for (const s of ['s', 'u']) {
    assert.equal(entry(j, 'refused', s)?.why, 'session audit', JSON.stringify(j))
    assertHeld(w, j, s)
  }
  assert.ok(!listed(j, 'refused', 'late'), 'a later wave is not part of the wave')
  assert.match(readFileSync(`${w.env.dir}/decisions.md`, 'utf8'), /wf_other\/weird/)
})

test('session audit: an agent without meta model in a foundry run (plan.js labels) is audited', () => {
  const w = scenario([{ slug: 's' }])
  withRun(w, 'wf_plan', [stray({ label: 'foundry-architect', agentType: 'foundry:architect', metaModel: undefined }), stray({ label: 'foundry-cynic-2', agentType: 'foundry:cynic' })])
  const j = assertOneLine(w.finish())
  assert.ok(j.audit.some((a) => a.label === 'wf_plan/foundry-architect'), JSON.stringify(j.audit))
  assert.ok(!j.audit.some((a) => a.label === 'wf_plan/foundry-cynic-2'))
  assert.equal(entry(j, 'refused', 's')?.why, 'session audit')
  assertHeld(w, j)
})

test('session audit: a clean plan.js run does not block the merge', () => {
  const w = scenario([{ slug: 's' }])
  withRun(w, 'wf_plan', [stray({ label: 'foundry-architect', agentType: 'foundry:architect' }), stray({ label: 'foundry-cynic-2', agentType: 'foundry:cynic' })])
  const j = assertOneLine(w.finish())
  assertMerged(w, j)
  assert.deepEqual(j.audit, [])
})

test('session audit: an unrelated run with no foundry agent and no foundry labels is ignored', () => {
  const w = scenario([{ slug: 's' }])
  withRun(w, 'wf_owner', [{ label: 'review-docs', agentType: 'general-purpose', startTs: '2026-10-29T09:00:00.000Z' }])
  const j = assertOneLine(w.finish())
  assertMerged(w, j)
  assert.deepEqual(j.audit, [])
})

test('session audit: only runs at or after the newest "## Run" header count', () => {
  const header = (ts) => `## Run ${ts} | goal\n`
  const early = scenario([{ slug: 's' }])
  writeFileSync(`${early.env.dir}/decisions.md`, header('2026-09-01T00:00:00Z') + header('2026-10-29T08:00:00Z'))
  withRun(early, 'wf_before', [stray({ startTs: '2026-10-29T07:00:00.000Z' })])
  assertMerged(early, assertOneLine(early.finish()))
  const late = scenario([{ slug: 's' }])
  writeFileSync(`${late.env.dir}/decisions.md`, header('2026-09-01T00:00:00Z') + header('2026-10-29T08:00:00Z'))
  withRun(late, 'wf_after', [stray({ startTs: '2026-10-29T08:00:00.000Z' })])
  const j2 = assertOneLine(late.finish())
  assert.ok(j2.audit.some((a) => a.label === 'wf_after/weird'))
  assertHeld(late, j2)
  const none = scenario([{ slug: 's' }])
  withRun(none, 'wf_ancient', [stray({ startTs: '2026-01-01T00:00:00.000Z' })])
  assertHeld(none, assertOneLine(none.finish()))
})

test('session audit: "audit waived: <run id>" in decisions.md lifts it', () => {
  const w = scenario([{ slug: 's' }])
  withRun(w, 'wf_other', [stray()])
  writeFileSync(`${w.env.dir}/decisions.md`, '- 11:00 | audit waived: wf_other | owner ruled | none | followed\n')
  assertMerged(w, assertOneLine(w.finish()))
})

// ---------------------------------------------------------------------------------------------------------------
// merge step gates

test('gate: no factory spawn line (lead path) leaves the crew untouched', () => {
  const w = scenario([{ slug: 's', spawn: false }])
  assertHeld(w, assertOneLine(w.finish()))
})

test('gate: a commit outside owns is refused', () => {
  const w = scenario([{ slug: 's', files: [['src/s/a.ts', 'a\n'], ['docs/stray.md', 'x\n']] }])
  const j = assertOneLine(w.finish())
  assert.ok(listed(j, 'refused', 's'), JSON.stringify(j))
  assertHeld(w, j)
})

test('gate: judgeFails above repairBudget is refused even with a later PASS; at the budget it merges', () => {
  const fail = (c) => judgeReport({ verdict: 'FAIL', head: c.head, patch: c.patch })
  const mk = (n) => {
    const w = scenario([{ slug: 's' }], { judgeLabel: `s-judge-${n + 1}` })
    for (let i = 1; i <= n; i++) writeReport(w.env.dir, 's', i === 1 ? 's-judge' : `s-judge-${i}`, fail(w.c.s), Date.parse('2026-10-29T09:00:00Z') + i)
    return w
  }
  const over = mk(3)
  const jo = assertOneLine(over.finish())
  assert.ok(listed(jo, 'refused', 's'), JSON.stringify(jo))
  assertHeld(over, jo)
  const ok = mk(2)
  assertMerged(ok, assertOneLine(ok.finish()))
})

test('gate: the red record must exist and have a non-zero exit', () => {
  const none = scenario([{ slug: 's', red: false }])
  const jn = assertOneLine(none.finish())
  assert.ok(listed(jn, 'refused', 's'), JSON.stringify(jn))
  assertHeld(none, jn)
  const green = scenario([{ slug: 's', red: 0 }])
  const jg = assertOneLine(green.finish())
  assert.ok(listed(jg, 'refused', 's'), JSON.stringify(jg))
  assertHeld(green, jg)
})

test('gate: the lowest-numbered checks file decides (numerically), later ones do not', () => {
  const a = scenario([{ slug: 's', red: 0 }])
  writeCheck(a.env.dir, 's', 2, 1, a.c.s.head)
  assert.ok(listed(assertOneLine(a.finish()), 'refused', 's'), 's-1 exit 0 refuses although s-2 is red')
  const b = scenario([{ slug: 's', red: false }])
  writeCheck(b.env.dir, 's', 2, 1, b.c.s.head)
  writeCheck(b.env.dir, 's', 10, 0, b.c.s.head)
  assertMerged(b, assertOneLine(b.finish()))
})

const judgeCases = [
  ['FAIL', (c) => judgeReport({ verdict: 'FAIL', head: c.head, patch: c.patch })],
  ['an UNSCOPED line', (c) => judgeReport({ head: c.head, patch: c.patch, unscoped: 1 })],
  ['no verdict', (c) => judgeReport({ verdict: null, head: c.head, patch: c.patch })],
]
for (const [name, judgeText] of judgeCases) {
  test(`gate: a newest judge with ${name} is not merged`, () => {
    const w = scenario([{ slug: 's' }], { judgeText })
    assertHeld(w, assertOneLine(w.finish()))
  })
}

test('gate: no judge since approvedAt is not merged; an older PASS does not count', () => {
  const w = scenario([{ slug: 's' }], { judge: false })
  writeReport(w.env.dir, 's', 's-judge', judgeReport({ head: w.c.s.head, patch: w.c.s.patch }), Date.parse('2026-09-30T00:00:00Z'))
  assertHeld(w, assertOneLine(w.finish()))
})

test('gate: the NEWEST judge rules: PASS then a later FAIL is held, FAIL then a later PASS merges', () => {
  const a = scenario([{ slug: 's' }], { judgeLabel: 's-judge-2', judgeText: (c) => judgeReport({ verdict: 'FAIL', head: c.head, patch: c.patch }) })
  writeReport(a.env.dir, 's', 's-judge', judgeReport({ head: a.c.s.head, patch: a.c.s.patch }), Date.parse('2026-10-29T09:00:00Z'))
  assertHeld(a, assertOneLine(a.finish()))
  const b = scenario([{ slug: 's' }], { judgeLabel: 's-judge-2' })
  writeReport(b.env.dir, 's', 's-judge', judgeReport({ verdict: 'FAIL', head: b.c.s.head, patch: b.c.s.patch }), Date.parse('2026-10-29T09:00:00Z'))
  assertMerged(b, assertOneLine(b.finish()))
})

// ---------------------------------------------------------------------------------------------------------------
// mergeHeadVerdict, fail closed

test('head: the patch must be defined even when HEAD equals the judge Head; an empty diff is "patch id unavailable"', () => {
  const w = scenario([{ slug: 's', files: [] }], { judgeText: (c) => judgeReport({ head: c.head, patch: BBB }) })
  const j = assertOneLine(w.finish())
  assert.equal(entry(j, 'refused', 's')?.why, 'patch id unavailable', JSON.stringify(j))
  assertHeld(w, j)
})

test('head: a judge file missing Head or missing Patch is "patch id unavailable"', () => {
  for (const [name, text] of [['Head', (c) => judgeReport({ patch: c.patch })], ['Patch', (c) => judgeReport({ head: c.head })]]) {
    const w = scenario([{ slug: 's' }], { judgeText: text })
    const j = assertOneLine(w.finish())
    assert.equal(entry(j, 'refused', 's')?.why, 'patch id unavailable', `${name}: ${JSON.stringify(j)}`)
    assertHeld(w, j)
  }
})

test('head: a version 1 plan with an undefined patch is refused although HEAD equals the judge Head', () => {
  const w = scenario([{ slug: 's', files: [] }], { plan: { version: 1 }, judgeText: (c) => judgeReport({ head: c.head, patch: BBB }) })
  const j = assertOneLine(w.finish())
  assert.equal(entry(j, 'refused', 's')?.why, 'patch id unavailable', JSON.stringify(j))
  assertHeld(w, j)
})

test('head: HEAD differs but the patch equals the judge Patch and the green check passes: merged', () => {
  const w = scenario([{ slug: 's', amend: true }], { judgeText: (c) => judgeReport({ head: c.oldHead, patch: c.patch }) })
  assert.notEqual(w.c.s.head, w.c.s.oldHead)
  assertMerged(w, assertOneLine(w.finish()))
  assert.equal(mainNow(w), w.c.s.head)
})

test('head: HEAD differs, the patch equals, but the green check fails: not merged', () => {
  const w = scenario([{ slug: 's', amend: true, doneCheck: 'false' }], { judgeText: (c) => judgeReport({ head: c.oldHead, patch: c.patch }) })
  assertHeld(w, assertOneLine(w.finish()))
})

test('head: HEAD and patch both differ from the judge: rework "rejudge"', () => {
  const w = scenario([{ slug: 's', amend: true }], { judgeText: (c) => judgeReport({ head: c.oldHead, patch: AAA }) })
  const j = assertOneLine(w.finish())
  assert.equal(entry(j, 'rework', 's')?.why, 'rejudge', JSON.stringify(j))
  assertHeld(w, j)
})

test('mergeHeadVerdict (unit): refuses every undefined input where headVerdict passes it; below v2 too', async () => {
  const mod = await import(pathToFileURL(REAL_FACTORY).href)
  assert.equal(typeof mod.mergeHeadVerdict, 'function', 'bin/factory.ts exports mergeHeadVerdict')
  const mhv = mod.mergeHeadVerdict
  const H = 'c'.repeat(40)
  const P = 'd'.repeat(40)
  const v2 = { version: 2, crews: [], repairBudget: 2, approvedAt: APPROVED }
  const v1 = { ...v2, version: 1 }
  const judge = reg.judgeRuling(judgeReport({ head: H, patch: P }))
  const noPatch = reg.judgeRuling(judgeReport({ head: H }))
  const noHead = reg.judgeRuling(judgeReport({ patch: P }))
  assert.equal(reg.headVerdict(v2, judge, H, undefined), undefined, 'headVerdict is fail-open on an undefined patch')
  assert.equal(reg.headVerdict(v2, judge, undefined, P), undefined, 'and on an undefined head')
  assert.equal(reg.headVerdict(v1, judge, H, undefined), undefined, 'and passes a version 1 plan')
  const refused = [[v2, judge, H, undefined], [v2, judge, undefined, P], [v2, noPatch, H, P], [v2, noHead, H, P], [v1, judge, H, undefined], [v1, judge, H, P], [v1, judge, undefined, undefined]]
  for (const [plan, jd, hd, pt] of refused.slice(0, 5).concat(refused.slice(6))) {
    assert.ok(mhv(plan, jd, hd, pt)?.block, `refused: ${JSON.stringify([plan.version, jd, hd, pt])}`)
  }
  assert.equal(mhv(v2, judge, H, P), undefined)
  assert.equal(mhv(v2, judge, H, 'e'.repeat(40)), undefined, 'HEAD equal passes')
  assert.equal(mhv(v2, judge, 'f'.repeat(40), P), undefined, 'patch equal passes')
  assert.ok(mhv(v2, judge, 'f'.repeat(40), 'e'.repeat(40))?.block, 'both differ')
})

// ---------------------------------------------------------------------------------------------------------------
// stale base, step 2 and step 4

test('stale base: a result whose base is an old SHA still merges; finish recomputes the merge-base after merging the target', () => {
  const stale = '1'.repeat(40)
  const w = scenario([{ slug: 's' }])
  writeFileSync(w.resFile, JSON.stringify([{ slug: 's', state: 'passed', head: w.c.s.head, base: stale, judge: 's-judge' }]))
  assertMerged(w, assertOneLine(w.finish()))
  const moved = scenario([{ slug: 's' }])
  putFile(moved.env.repo, 'other.txt', 'o\n', 'target moves')
  moved.mainBefore = mainNow(moved)
  writeFileSync(moved.resFile, JSON.stringify([{ slug: 's', state: 'passed', head: moved.c.s.head, base: stale, judge: 's-judge' }]))
  assertMerged(moved, assertOneLine(moved.finish()))
  assert.ok(existsSync(`${moved.env.repo}/other.txt`) && existsSync(`${moved.env.repo}/src/s/a.ts`), 'main holds both')
  assert.equal(gitStatus(moved.env.repo, ['merge-base', '--is-ancestor', moved.c.s.head, 'main']), 0)
})

test('step 2: a conflicting target change is rework "conflict", the merge is aborted, the target is untouched', () => {
  const w = scenario([{ slug: 's' }])
  putFile(w.env.repo, 'src/s/a.ts', 'main version\n', 'conflicting')
  w.mainBefore = mainNow(w)
  const j = assertOneLine(w.finish())
  assert.equal(entry(j, 'rework', 's')?.why, 'conflict', JSON.stringify(j))
  assertHeld(w, j)
  assert.notEqual(gitStatus(w.c.s.wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), 0, 'no MERGE_HEAD')
  assert.equal(git(w.c.s.wt, ['status', '--porcelain']), '', 'crew worktree is clean')
  assert.equal(head(w.c.s.wt), w.c.s.head)
})

test('step 4: target checked out and clean, with an untracked file elsewhere: fast-forwarded', () => {
  const w = scenario([{ slug: 's' }])
  writeFileSync(`${w.env.repo}/untracked.txt`, 'u\n')
  assertMerged(w, assertOneLine(w.finish()))
  assert.equal(mainNow(w), w.c.s.head)
  assert.ok(existsSync(`${w.env.repo}/src/s/a.ts`), 'the checked-out tree moved')
  assert.ok(existsSync(`${w.env.repo}/untracked.txt`))
})

test('step 4: a tracked change in the target tree is "blocked: target checked out dirty: <path>"; after cleaning, a later finish merges', () => {
  const w = scenario([{ slug: 's' }])
  writeFileSync(`${w.env.repo}/README.md`, 'dirty\n')
  const j = assertOneLine(w.finish())
  const b = entry(j, 'blocked', 's')
  assert.ok(b && b.why.startsWith('target checked out dirty: '), JSON.stringify(j))
  assert.ok(b.why.includes('README.md'))
  assertHeld(w, j)
  assert.ok(existsSync(w.c.s.wt), 'the crew worktree is kept')
  assert.equal(readFileSync(`${w.env.repo}/README.md`, 'utf8'), 'dirty\n', 'nothing touched')
  git(w.env.repo, ['checkout', '--', 'README.md'])
  assertMerged(w, assertOneLine(w.finish()))
})

test('step 4: target checked out nowhere: compare-and-swap moves the ref', () => {
  const w = scenario([{ slug: 's' }])
  git(w.env.repo, ['checkout', '-q', '-b', 'elsewhere'])
  assertMerged(w, assertOneLine(w.finish()))
  assert.equal(mainNow(w), w.c.s.head)
  assert.equal(git(w.env.repo, ['branch', '--show-current']), 'elsewhere')
})

test('step 4: an untracked file the fast-forward would overwrite is rework "target moved"', () => {
  const w = scenario([{ slug: 's' }])
  putFile(w.env.repo, 'src/s/a.ts', 'untracked in the way\n')
  const j = assertOneLine(w.finish())
  assert.equal(entry(j, 'rework', 's')?.why, 'target moved', JSON.stringify(j))
  assertHeld(w, j)
})

// ---------------------------------------------------------------------------------------------------------------
// step 5 and never-touched

test('step 5: merged status, a decision line, the crew worktree and merged member worktrees removed; an unmerged member kept', () => {
  const w = scenario([{ slug: 's' }], { judge: false })
  const { repo } = w.env
  const wt = w.c.s.wt
  const member = (name, merge) => {
    const mwt = `${repo}/.claude/worktrees/foundry-s-${name}`
    git(repo, ['worktree', 'add', '-q', '-b', `foundry-s-${name}`, mwt, 'foundry-s'])
    git(mwt, ['config', 'user.name', 'T'])
    git(mwt, ['config', 'user.email', 't@e.invalid'])
    putFile(mwt, `src/s/${name}.ts`, `${name}\n`, `member ${name}`)
    if (merge) git(wt, ['merge', '--no-ff', '-q', '-m', `merge ${name}`, `foundry-s-${name}`])
    return mwt
  }
  const done = member('m1', true)
  const open = member('m2', false)
  const hd = head(wt)
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  writeReport(w.env.dir, 's', 's-judge', judgeReport({ head: hd, patch: patchId(wt, base, hd) }), Date.now())
  const decBefore = readFileSync(`${w.env.dir}/decisions.md`, 'utf8')
  const j = assertOneLine(w.finish())
  assertMerged(w, j)
  const dec = readFileSync(`${w.env.dir}/decisions.md`, 'utf8')
  assert.ok(dec.length > decBefore.length && /\bs\b/.test(dec.slice(decBefore.length)), 'a decision line about s')
  assert.ok(!existsSync(wt), 'crew worktree removed')
  assert.ok(!existsSync(done), 'merged member worktree removed')
  assert.ok(existsSync(open), 'unmerged member worktree kept')
})

test('never touched: lead-path crews, later waves, merged and dropped crews; no remote is contacted', () => {
  const w = scenario([{ slug: 's' }, { slug: 'l', spawn: false }, { slug: 'm', status: 'merged' }, { slug: 'd', status: 'dropped' }, { slug: 'w2', wave: 2, status: 'planned' }], { skip: ['l'] })
  git(w.env.repo, ['remote', 'add', 'origin', 'C:/nonexistent/nowhere/repo.git'])
  const lwt = w.c.l.wt
  const lhead = head(lwt)
  const j = assertOneLine(w.finish())
  assertMerged(w, j)
  for (const [slug, st] of [['l', 'running'], ['m', 'merged'], ['d', 'dropped'], ['w2', 'planned']]) {
    assert.equal(statusOf(w, slug), st)
    for (const k of ['merged', 'rework', 'blocked', 'refused']) assert.ok(!listed(j, k, slug), `${slug} in ${k}`)
  }
  assert.ok(existsSync(lwt) && head(lwt) === lhead)
  assert.equal(git(w.env.repo, ['for-each-ref', 'refs/remotes']), '', 'nothing fetched')
  assert.equal(git(w.env.repo, ['config', '--get', 'remote.origin.url']), 'C:/nonexistent/nowhere/repo.git')
})

test('stopped result: not merged, the crew stays running', () => {
  const w = scenario([{ slug: 's' }])
  writeFileSync(w.resFile, JSON.stringify([{ slug: 's', state: 'stopped', tag: 'BLOCKED', text: 'needs the owner', at: 'step 4' }]))
  const j = assertOneLine(w.finish())
  assertHeld(w, j)
  assert.ok(existsSync(w.c.s.wt))
})
