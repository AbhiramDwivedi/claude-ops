import { expect, test } from 'claude-code/testing'

import {
  agentLabel,
  biggestContext,
  crowdAlarm,
  effortLabel,
  family,
  fitLine,
  formatModels,
  isLive,
  liveAgents,
  setting,
  shortPath,
  tokens,
} from '../hooks/register'

const LIMITS = { liveAgents: 6, context: 300_000 }
const MIN = 60_000
const opus = 'claude-opus-5-5'
const sonnet = 'claude-sonnet-5-5'

test('names model families', async () => {
  expect(family(opus)).toBe('Opus')
  expect(family('claude-haiku-4-5-20251001')).toBe('Haiku')
  expect(family('claude-sonnet-5-5[1m]')).toBe('Sonnet')
})

test('formats token counts', async () => {
  expect(tokens(955_492)).toBe('955K')
  expect(tokens(1_200_000)).toBe('1.2M')
})

test('counts an agent held on its own background work as live', async () => {
  expect(isLive('running')).toBe(true)
  expect(isLive('waiting')).toBe(true)
  for (const status of ['pending', 'idle', 'completed', 'failed', 'killed'] as const) expect(isLive(status)).toBe(false)
})

test('shows the model alone until an agent beyond the main thread is running', async () => {
  expect(formatModels(opus, {}, new Set(), LIMITS)).toBe('model: Opus')
  expect(formatModels(opus, { main: { model: opus, context: 50_000 } }, new Set(), LIMITS)).toBe('model: Opus')
  // a finished agent is left out
  const agents = { main: { model: opus, context: 1 }, a1: { model: sonnet, context: 1, effort: 'low' } }
  expect(formatModels(opus, agents, new Set(), LIMITS)).toBe('model: Opus')
})

test("shows the main thread's effort once it has made a request", async () => {
  expect(formatModels(opus, { main: { model: opus, context: 1, effort: 'xhigh' } }, new Set(), LIMITS)).toBe(
    'model: Opus · effort: xhigh',
  )
  expect(effortLabel(32_000)).toBe('32K')
  // a model without effort shows none
  expect(formatModels(opus, { main: { model: opus, context: 1 } }, new Set(), LIMITS)).toBe('model: Opus')
})

test('counts the live agents by model and effort, the main thread included', async () => {
  const haiku = 'claude-haiku-4-5-20251001'
  const agents = {
    main: { model: opus, context: 50_000, effort: 'high' },
    a1: { model: sonnet, context: 20_000, effort: 'low' },
    a2: { model: sonnet, context: 20_000, effort: 'low' },
    a3: { model: opus, context: 20_000, effort: 'medium' },
    a4: { model: opus, context: 20_000, effort: 'medium' },
    // switched to Haiku, which takes no effort: counted by its latest model only
    t1: { model: haiku, context: 20_000 },
    done: { model: opus, context: 20_000, effort: 'max' },
  }
  const line = formatModels(opus, agents, new Set(['a1', 'a2', 'a3', 'a4', 't1']), LIMITS)
  expect(line).toBe('model: Opus · effort: high · agents: Opus (2 medium, 1 high), Sonnet (2 low), Haiku (1) · ⚠ 6 live')
})

test('marks the agents of a model that went without effort', async () => {
  const agents = { main: { model: opus, context: 1, effort: 'high' }, a1: { model: opus, context: 1 } }
  expect(formatModels(opus, agents, new Set(['a1']), LIMITS)).toBe(
    'model: Opus · effort: high · agents: Opus (1 high, 1 no effort)',
  )
})

test('skips an agent recorded before agents kept their latest model', async () => {
  const agents = { main: { model: opus, context: 1, effort: 'high' }, a1: { context: 1 }, a2: { model: opus, context: 1, effort: 'low' } }
  expect(formatModels(opus, agents, new Set(['a1', 'a2']), LIMITS)).toBe(
    'model: Opus · effort: high · agents: Opus (1 high, 1 low)',
  )
})

test('treats finished agents as not live, and main as always live', async () => {
  const agents = { main: { model: opus, context: 1 }, a1: { model: opus, context: 1 } }
  expect(liveAgents(agents, new Set())).toEqual(['main'])
})

test('warns about a crowd of live agents and the biggest live context', async () => {
  // the shape of a runaway session: a dozen background Opus agents near a million tokens each
  const agents: Record<string, { model: string; context: number; effort?: string }> = { main: { model: opus, context: 80_000 } }
  const running = new Set<string>()
  for (let i = 0; i < 12; i++) {
    agents[`a${i}`] = { model: opus, context: 800_000 + i * 10_000 }
    running.add(`a${i}`)
  }
  agents.done = { model: opus, context: 990_000 }
  expect(biggestContext(agents, liveAgents(agents, running), LIMITS.context)).toEqual({ id: 'a11', context: 910_000 })
  expect(formatModels(opus, agents, running, LIMITS)).toBe(
    'model: Opus · agents: Opus (13) · ⚠ 13 live · ⚠ ctx 910K',
  )
})

test('toasts a crowd once, not on every wobble around the threshold', async () => {
  let crowd = { isArmed: true, lastToastAt: -Infinity }
  const step = (live: number, at: number) => {
    const alarm = crowdAlarm(crowd, live, at, 6)
    crowd = alarm.crowd
    return alarm.toast
  }
  expect(step(6, 0)).toBe(true)
  // agents finish and start around the threshold: no repeat
  expect(step(5, MIN)).toBe(false)
  expect(step(6, 2 * MIN)).toBe(false)
  // it re-arms only once the count falls well below, and stays quiet for ten minutes
  expect(step(3, 3 * MIN)).toBe(false)
  expect(step(7, 4 * MIN)).toBe(false)
  expect(step(3, 5 * MIN)).toBe(false)
  expect(step(7, 11 * MIN)).toBe(true)
})

test('holds settings within bounds', async () => {
  expect(setting(undefined, 6, 2, 100)).toBe(6)
  expect(setting(0, 6, 2, 100)).toBe(2)
  expect(setting('lots', 6, 2, 100)).toBe(6)
})

test('shows the directory last, home as ~', async () => {
  expect(formatModels(opus, {}, new Set(), LIMITS, '~/src/app')).toBe('model: Opus · cwd: ~/src/app')
  expect(shortPath('/home/me/src/app', '/home/me')).toBe('~/src/app')
  expect(shortPath('/home/me', '/home/me/')).toBe('~')
  expect(shortPath('/home/meg/src', '/home/me')).toBe('/home/meg/src')
  expect(shortPath('c:\\users\\me\\src', 'C:\\Users\\me')).toBe('~\\src')
  expect(shortPath('C:\\sw\\claude-mods', 'C:\\Users\\me')).toBe('C:\\sw\\claude-mods')
  expect(shortPath('/srv/app', undefined)).toBe('/srv/app')
})

test('cuts a long directory from its head, at a separator, to fit the band', async () => {
  const parts = ['model: Opus', '⚠ 7 live', 'cwd: C:\\sw\\claude-mods\\plugins\\session-models']
  // it fits: untouched
  expect(fitLine(parts, 200)).toEqual(parts)
  // 'model: Opus · ⚠ 7 live · cwd: ' is 30 columns, leaving 26 for the path
  expect(fitLine(parts, 56)).toEqual(['model: Opus', '⚠ 7 live', 'cwd: …\\plugins\\session-models'])
  // no separator in the kept tail: a raw cut
  expect(fitLine(parts, 40)).toEqual(['model: Opus', '⚠ 7 live', 'cwd: …on-models'])
  // the warnings are never cut for it
  expect(fitLine(parts, 20)).toEqual(['model: Opus', '⚠ 7 live', 'cwd: …'])
  // a line without a directory is left alone
  expect(fitLine(['model: Opus'], 5)).toEqual(['model: Opus'])
})

test('names an agent by its task in the context toast', async () => {
  expect(agentLabel('main', undefined)).toBe('The main thread')
  expect(agentLabel('ae9ca49e548d4f774', 'Builder A: evidence checks')).toBe('Builder A: evidence checks')
  expect(agentLabel('ae9ca49e548d4f774', undefined)).toBe('Agent ae9ca49e')
})
