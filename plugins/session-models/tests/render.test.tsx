import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const opus = 'claude-opus-5-5'

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

// the world beneath the plugin: a clock, the surfaces, one running subagent, a status line
// and toasts kept in memory, a band line beneath as another plugin's would be, and every
// request answered with `context` tokens, all of them read from the cache
function world(on: On, surfaces: readonly ('terminal' | 'desktop' | 'vscode' | 'mobile')[], context: number) {
  const seen = { status: undefined as string | undefined, toasts: [] as string[], cwd: '/home/me/app' }
  mock.clock(on, { now: NOW })
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.model', () => ({ value: opus }))
  on('session.cwd', () => ({ value: seen.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('classic.CwdChanged', async () => ({}))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Builder A', type: 'general-purpose', status: 'running' as const }],
  }))
  on('ui.status', (_$, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: e.model,
        input_tokens: 0,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: context,
      },
    }
  })
  return seen
}

// one model request of an agent (main when `agentId` is absent), read to its end
async function step($: Engine, agentId?: string, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number) {
  const stream = $.turn.step({
    turnId: 't1',
    index: 0,
    model: opus,
    messageCount: 3,
    ...(agentId === undefined ? {} : { agentId }),
    ...(effort === undefined ? {} : { effort }),
  })
  for await (const _ of stream) {
    // drained: the result settles once the stream is read to its end
  }
  return stream.result
}

const CROWD = { options: { liveAgentsWarn: 2 } }

test('draws the line dim in the band, the crowd and big-context warnings in the warning color', CROWD, async ($, on) => {
  const seen = world(on, ['terminal', 'desktop'], 350_000)
  await step($)
  await step($, 'a1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-models', surface, component: 'AbovePrompt', props: BAND })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.filter(t => t.props.color === 'warning').map(t => t.text)).toEqual(['⚠ 2 live', '⚠ ctx 350K'])
    expect(texts.filter(t => t.props.dimColor === true).map(t => t.text)).toEqual([
      'model: Opus · agents: Opus (2) · ',
      ' · ',
      ' · cwd: ~/app',
    ])
    // what was drawn beneath stays, above this plugin's line
    expect(texts[0]!.text).toBe('beneath')
    await ui.unmount()
  }
  // the band carries the line, so no status pins it in yellow
  expect(seen.status).toBeUndefined()
})

test('draws a calm session all dim', async ($, on) => {
  world(on, ['terminal'], 50_000)
  await step($)
  const ui = await $.ui.mount({ plugin: 'session-models', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.filter(t => t.props.color === 'warning')).toEqual([])
  expect(texts.filter(t => t.props.dimColor === true).map(t => t.text)).toEqual(['model: Opus · cwd: ~/app'])
})

test("shows the main thread's effort, and follows a change at its next request", async ($, on) => {
  const seen = world(on, ['mobile'], 50_000)
  await step($, undefined, 'high')
  expect(seen.status).toBe('model: Opus · effort: high · cwd: ~/app')
  // a subagent's effort is its own, not the session's
  await step($, 'a1', 'low')
  expect(seen.status).toBe('model: Opus · effort: high · agents: Opus (1 high, 1 low) · cwd: ~/app')
  await step($, undefined, 'max')
  expect(seen.status).toBe('model: Opus · effort: max · agents: Opus (1 max, 1 low) · cwd: ~/app')
})

test('follows a directory change, and cuts a long one from its head in a narrow band', async ($, on) => {
  const seen = world(on, ['terminal'], 50_000)
  await step($)
  seen.cwd = '/srv/projects/claude-mods/plugins/session-models'
  await $.classic.CwdChanged({ old_cwd: '/home/me/app', new_cwd: seen.cwd } as never)
  const ui = await $.ui.mount({
    plugin: 'session-models',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND, bodyColumns: 45 },
  })
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.filter(t => t.props.dimColor === true).map(t => t.text)).toEqual([
    'model: Opus · cwd: …/plugins/session-models',
  ])
  await ui.unmount()
})

test('gives the status the whole directory', async ($, on) => {
  const seen = world(on, ['vscode'], 50_000)
  seen.cwd = '/srv/projects/claude-mods/plugins/session-models'
  await step($)
  expect(seen.status).toBe('model: Opus · cwd: /srv/projects/claude-mods/plugins/session-models')
})

test("keeps another plugin's band line beside its own", {
  plugins: [
    {
      name: 'other-band',
      register(on) {
        on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
          const { Box, Text } = $.ui.resolve(e)
          return (
            <Box flexDirection="column">
              {await next(e)}
              <Text>other line</Text>
            </Box>
          )
        })
      },
    },
  ],
}, async ($, on) => {
  world(on, ['terminal'], 50_000)
  await step($)
  const ui = await $.ui.mount({ plugin: 'session-models', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: 'other line' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'model: Opus · cwd: ~/app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'beneath' })).toBeDefined()
})

test('falls back to the status line only where no surface has a band', CROWD, async ($, on) => {
  const seen = world(on, ['mobile'], 350_000)
  await step($)
  await step($, 'a1')
  expect(seen.status).toBe('model: Opus · agents: Opus (2) · ⚠ 2 live · ⚠ ctx 350K · cwd: ~/app')
})

test('keeps the terminal quiet when a phone is attached beside it', CROWD, async ($, on) => {
  const seen = world(on, ['terminal', 'mobile'], 350_000)
  await step($)
  await step($, 'a1')
  expect(seen.status).toBeUndefined()
})
