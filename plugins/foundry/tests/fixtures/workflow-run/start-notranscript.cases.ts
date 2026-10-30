// @ts-nocheck
// `start` without --transcript fails closed: the runs root is unknown, so no crew is stale, running workflow
// crews are listed under `unfinished`, and `--resume stale` is a usage error naming --transcript.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, mkEnv, planObj, writeGoal, writePlan } from './harness.ts'

const old = () => new Date(Date.now() - 2 * 3_600_000).toISOString()

function staleWorld() {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('s', { status: 'running' })]))
  writeGoal(env.dir, 's')
  addCrewWorktree(env.repo, 's')
  appendEvent(env.dir, factorySpawn('s', old()))
  return env
}

test('start --wave next without --transcript: a would-be-stale crew is not under stale', () => {
  const env = staleWorld()
  const res = env.run('start', { wave: 'next' })
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(j.stale, [])
})

test('start --wave next without --transcript: the running workflow crew is listed under unfinished', () => {
  const env = staleWorld()
  const j = assertOneLine(env.run('start', { wave: 'next' }))
  assert.ok(Array.isArray(j.unfinished))
  assert.ok(j.unfinished.some((u) => u.slug === 's'), JSON.stringify(j.unfinished))
})

test('start --resume stale without --transcript: usage error naming --transcript, files untouched', () => {
  const env = staleWorld()
  const read = () => [readFileSync(`${env.dir}/plan.json`, 'utf8'), readFileSync(`${env.dir}/events.jsonl`, 'utf8')]
  const before = read()
  const res = env.run('start', { slug: 's', resume: 'stale' })
  const j = assertOneLine(res)
  assert.equal(res.status, 2, res.stderr)
  assert.equal(typeof j.error, 'string')
  assert.ok(j.error.includes('--transcript'), j.error)
  assert.deepEqual(read(), before)
})

test('control: with --transcript pointing at an empty run dir the same crew IS stale', () => {
  const env = staleWorld()
  const t = `${env.transcripts}/wf_empty`
  mkdirSync(t, { recursive: true })
  const j = assertOneLine(env.run('start', { wave: 'next', transcript: t }))
  assert.deepEqual(j.stale.map((x) => x.slug), ['s'])
})
