// @ts-nocheck
// Regression cases for `finish`, from red-team reproductions against the merge step and the session audit
// (foundry ADR-0009, "finish, session audit" and "finish, merge step" items 2 and 4). Loaded by tests/factory.check.ts.
//   1. the target moves during the done-check: the merge must be a compare-and-swap, so a concurrent commit is kept
//      and the crew goes to rework with why "target moved";
//   2. a tag named like the target must not make the CLI update the wrong ref and rewind the branch;
//   3. while any session-audit entry stands, finish merges nothing at all.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import * as reg from '../../../hooks/register.ts'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, judgeReport, mkEnv, mkRun, planObj, putFile, tmp, writePlan } from './harness.ts'

function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

/** One running crew `s` with a judged, passed branch. The caller moves main and checks main out nowhere. */
function world(doneCheck = 'true') {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('s', { status: 'running', doneCheck })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const wt = addCrewWorktree(env.repo, 's', 'main')
  putFile(wt, 'src/s/a.ts', 's\n', 'work')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  const patch = patchId(wt, base, hd)
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const agents = [
    { label: 's-builder', agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built' },
    { label: 's-judge', agentType: 'foundry:judge', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: judgeReport({ head: hd, patch }) },
  ]
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, judge: 's-judge' }]))
  return { env, wt, hd, patch, base, agents, resFile }
}
const listed = (j, key, slug) => (j[key] ?? []).some((x) => (typeof x === 'string' ? x : x.slug) === slug)
const entry = (j, key, slug) => (j[key] ?? []).find((x) => x.slug === slug)
const isAncestor = (repo, a, b) => gitStatus(repo, ['merge-base', '--is-ancestor', a, b]) === 0
const parsed = (r) => r.json ?? JSON.parse(r.stdout.trim().split('\n').pop())

test('finish merge: the target moving during the done-check is a failed compare-and-swap, not a lost commit', () => {
  // main moves before finish, so step 2 makes a merge commit and the done-check runs. The check script itself
  // fast-forwards main with a concurrent commit and exits 0: the race needs no timing.
  const w = world()
  const repo = w.env.repo
  putFile(repo, 'other.txt', 'earlier\n', 'earlier commit on main')
  git(repo, ['checkout', '-q', '-b', 'other-crew', 'main'])
  putFile(repo, 'concurrent.txt', 'concurrent\n', 'CONCURRENT commit')
  const concurrent = git(repo, ['rev-parse', 'other-crew'])
  git(repo, ['checkout', '-q', '-b', 'elsewhere'])
  const script = `${tmp('fcli-race-')}/race-check.js`.replace(/\\/g, '/')
  writeFileSync(script, `const { spawnSync } = require('node:child_process')\nconst r = spawnSync('git', ['push', '-q', '.', 'other-crew:main'], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' })\nprocess.exit(r.status === 0 ? 0 : 7)\n`)
  const plan = JSON.parse(readFileSync(`${w.env.dir}/plan.json`, 'utf8'))
  plan.crews[0].doneCheck = `node ${script}`
  writeFileSync(`${w.env.dir}/plan.json`, JSON.stringify(plan, null, 2))
  const mainBefore = git(repo, ['rev-parse', 'main'])
  const run = mkRun(w.env.transcripts, 'wf_1', w.agents)
  const r = w.env.run('finish', { transcript: run.dir, result: w.resFile })
  const j = parsed(r)
  assert.notEqual(mainBefore, concurrent, 'setup: the concurrent commit is not yet on main')
  assert.ok(isAncestor(repo, concurrent, 'main'), `the concurrent commit must survive in main: ${r.stdout}`)
  assert.ok(!listed(j, 'merged', 's'), `s must not be merged over a moved target: ${r.stdout}`)
  const rw = entry(j, 'rework', 's')
  assert.ok(rw, `s must be in rework: ${r.stdout}`)
  assert.equal(rw.why, 'target moved', r.stdout)
})

test('finish merge: a tag named like the target does not rewind the branch', () => {
  const w = world()
  const repo = w.env.repo
  git(repo, ['tag', 'main', 'main'])
  putFile(repo, 'other.txt', 'later\n', 'commit on main after the tag')
  const later = git(repo, ['rev-parse', 'refs/heads/main'])
  git(repo, ['checkout', '-q', '-b', 'elsewhere'])
  const run = mkRun(w.env.transcripts, 'wf_1', w.agents)
  const r = w.env.run('finish', { transcript: run.dir, result: w.resFile })
  assert.ok(isAncestor(repo, later, 'refs/heads/main'), `the post-tag commit on branch main must survive: ${r.stdout}`)
  if (listed(parsed(r), 'merged', 's')) {
    assert.ok(isAncestor(repo, w.hd, 'refs/heads/main'), `merged, so the crew's work must be in refs/heads/main: ${r.stdout}`)
  }
})

test('session audit: an entry from the run blocks every merge, even for a clean crew', () => {
  const w = world()
  const repo = w.env.repo
  git(repo, ['checkout', '-q', '-b', 'elsewhere'])
  const mainBefore = git(repo, ['rev-parse', 'main'])
  const run = mkRun(w.env.transcripts, 'wf_1', [
    ...w.agents,
    { label: 'foundry-builder', agentType: 'general-purpose', model: 'claude-fable-5', effort: 'medium', result: 'helper with no model, inherited the session model' },
  ])
  const r = w.env.run('finish', { transcript: run.dir, result: w.resFile })
  const j = parsed(r)
  assert.deepEqual(j.merged, [], `no merge while an audit entry stands: ${r.stdout}`)
  assert.equal(git(repo, ['rev-parse', 'main']), mainBefore, 'main is unchanged')
  assert.ok(Array.isArray(j.audit) && j.audit.length > 0, `the session audit must report the agent: ${r.stdout}`)
  assert.equal(r.status, 1, r.stdout)
})
