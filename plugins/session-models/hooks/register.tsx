import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register } from 'claude-code'

import type { AgentsSeen } from '../types'

const agentsSeen = atom({ plugin: 'session-models', key: 'agents' } as const, {} as AgentsSeen)

export type Thresholds = { liveAgents: number; context: number }

// the crowd toast re-arms only once the count drops this far below the threshold,
// and never fires twice within the quiet period
const CROWD_HYSTERESIS = 2
const CROWD_QUIET_MS = 10 * 60_000
// a busy session steps many times a second across its agents: redraw at most this often
const REFRESH_MIN_MS = 2_000
// the surfaces that raise the AbovePrompt band; any other gets the line as a status
const BAND_SURFACES: readonly string[] = ['terminal', 'desktop']

// claude-opus-5-5 -> Opus; an id outside the known families is shown as-is
export function family(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model)
  if (m === null) return model.replace(/^claude-/, '')
  const name = m[1]!.toLowerCase()
  return name[0]!.toUpperCase() + name.slice(1)
}

// 955492 -> 955K, 1200000 -> 1.2M
export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

// an agent at work: taking a turn, or held on background work it owns (a long shell,
// an Agent call it waits on); an idle teammate waits for a message and is not
export function isLive(status: AgentStatus): boolean {
  return status === 'running' || status === 'waiting'
}

// the agents running now: the main thread always, plus every live subagent or teammate
export function liveAgents(agents: AgentsSeen, running: ReadonlySet<string>): string[] {
  return Object.keys(agents).filter(id => id === 'main' || running.has(id))
}

// where an agent sits in the spawn tree: its parent, and the name it was given
export type AgentNode = { parentId?: string; name?: string }
export type Crew = { name: string; size: number; models: Map<string, number> }
const CREWS_SHOWN = 3

// a crew is a named top-level agent with at least one live descendant; its size is the
// lead plus those descendants, grandchildren included. Largest first, then by name
export function crews(tree: ReadonlyMap<string, AgentNode>, agents: AgentsSeen, running: ReadonlySet<string>): Crew[] {
  const byLead = new Map<string, string[]>()
  for (const id of running) {
    // climb to the top-level ancestor; the hop limit guards against a cycle
    let top = id
    for (let hops = 0; hops <= tree.size; hops++) {
      const parent = tree.get(top)?.parentId
      if (parent === undefined || parent === 'main' || !tree.has(parent)) break
      top = parent
    }
    if (top === id || tree.get(top)?.name === undefined || tree.get(top)?.name === '') continue
    byLead.set(top, [...(byLead.get(top) ?? []), id])
  }
  const out: Crew[] = []
  for (const [lead, members] of byLead) {
    const models = new Map<string, number>()
    for (const id of [lead, ...members]) {
      const model = agents[id]?.model
      if (model !== undefined) models.set(family(model).toLowerCase(), (models.get(family(model).toLowerCase()) ?? 0) + 1)
    }
    out.push({ name: tree.get(lead)!.name!, size: members.length + 1, models })
  }
  return out.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
}

// export 4 (opus 1, sonnet 3) · staffing 3 (opus 1, sonnet 2) · +2 more
export function crewsPart(list: readonly Crew[]): string | undefined {
  if (list.length === 0) return undefined
  const shown = list.slice(0, CREWS_SHOWN).map(c => {
    const models = [...c.models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m, n]) => `${m} ${n}`)
    return models.length > 0 ? `${c.name} ${c.size} (${models.join(', ')})` : `${c.name} ${c.size}`
  })
  if (list.length > CREWS_SHOWN) shown.push(`+${list.length - CREWS_SHOWN} more`)
  return `crews: ${shown.join(' · ')}`
}

// the live agent carrying the most context, when any carries at least `threshold`
export function biggestContext(agents: AgentsSeen, live: readonly string[], threshold: number) {
  let top: { id: string; context: number } | undefined
  for (const id of live) {
    const context = agents[id]?.context ?? 0
    if (context >= threshold && (top === undefined || context > top.context)) top = { id, context }
  }
  return top
}

// a level as named, an integer budget as a token count: high, 32K
export function effortLabel(effort: string | number): string {
  return typeof effort === 'number' ? tokens(effort) : effort
}

// /home/me/src/app -> ~/src/app; a path outside home, or no home known, as-is
export function shortPath(path: string, home: string | undefined): string {
  if (home === undefined || home === '') return path
  const h = home.replace(/[\\/]+$/, '')
  // a Windows path matches without case
  const isUnder = /^[a-z]:/i.test(h) ? path.toLowerCase().startsWith(h.toLowerCase()) : path.startsWith(h)
  if (!isUnder) return path
  const rest = path.slice(h.length)
  if (rest === '') return '~'
  // /home/meg is not under /home/me
  return /^[\\/]/.test(rest) ? `~${rest}` : path
}

// "model: Opus · effort: high · agents: Opus (12 medium, 1 high), Sonnet (2 low) · crews: export 4 (opus 1, sonnet 3) · ⚠ 15 live · ⚠ ctx 955K · cwd: ~/src/app"
// the agents part counts the live ones, main included, by the model and effort of each
// one's latest request; it appears while anything beyond the main thread is running.
// The directory goes last, so a long path is cut (from its head, by fitLine) rather
// than pushing the warnings out of sight
export function formatModels(
  current: string,
  agents: AgentsSeen,
  running: ReadonlySet<string>,
  limits: Thresholds,
  cwd?: string,
  tree?: ReadonlyMap<string, AgentNode>,
): string {
  return modelParts(current, agents, running, limits, cwd, tree).join(' · ')
}

// the line's parts, as formatModels joins them
export function modelParts(
  current: string,
  agents: AgentsSeen,
  running: ReadonlySet<string>,
  limits: Thresholds,
  cwd?: string,
  tree?: ReadonlyMap<string, AgentNode>,
): string[] {
  const parts = [`model: ${family(current)}`]
  // the main thread's latest request; unknown until it has made one
  const effort = agents.main?.effort
  if (effort !== undefined) parts.push(`effort: ${effortLabel(effort)}`)
  const live = new Set(liveAgents(agents, running))
  if (live.size > 1) {
    // family -> effort -> count; '' for a model that takes no effort
    const counts = new Map<string, Map<string, number>>()
    for (const id of live) {
      const seen = agents[id]
      // state written before agents kept their latest model
      if (seen?.model === undefined) continue
      const f = family(seen.model)
      const efforts = counts.get(f) ?? new Map<string, number>()
      const e = seen.effort === undefined ? '' : effortLabel(seen.effort)
      efforts.set(e, (efforts.get(e) ?? 0) + 1)
      counts.set(f, efforts)
    }
    const total = (efforts: Map<string, number>) => [...efforts.values()].reduce((a, b) => a + b, 0)
    const list = [...counts]
      .sort((a, b) => total(b[1]) - total(a[1]))
      .map(([f, efforts]) => {
        const byEffort = [...efforts]
          .sort((a, b) => b[1] - a[1])
          .map(([e, n]) => (e !== '' ? `${n} ${e}` : efforts.size > 1 ? `${n} no effort` : `${n}`))
        return `${f} (${byEffort.join(', ')})`
      })
      .join(', ')
    parts.push(`agents: ${list}`)
    // named leads with live helpers, by the same live agents counted above
    const crewsText = tree === undefined ? undefined : crewsPart(crews(tree, agents, running))
    if (crewsText !== undefined) parts.push(crewsText)
  }
  if (live.size >= limits.liveAgents) parts.push(`⚠ ${live.size} live`)
  const top = biggestContext(agents, [...live], limits.context)
  if (top !== undefined) parts.push(`⚠ ctx ${tokens(top.context)}`)
  if (cwd !== undefined) parts.push(`cwd: ${cwd}`)
  return parts
}

// the line within `columns`: a directory too long loses its head, cut back to a path
// separator where one falls in the kept tail, so the folders nearest it stay readable
export function fitLine(parts: readonly string[], columns: number): string[] {
  const last = parts[parts.length - 1]
  if (last === undefined || !last.startsWith('cwd: ')) return [...parts]
  const width = (s: string) => Array.from(s).length
  const path = Array.from(last.slice('cwd: '.length))
  const over = width(parts.join(' · ')) - columns
  if (over <= 0) return [...parts]
  const room = path.length - over - 1
  let tail = room > 0 ? path.slice(path.length - room).join('') : ''
  const cut = tail.search(/[\\/]/)
  if (cut > 0) tail = tail.slice(cut)
  return [...parts.slice(0, -1), `cwd: …${tail}`]
}

// the line as runs of text: each part marked ⚠ a warning run of its own, the other
// parts and the separators merged into dim runs
export type Run = { text: string; isWarning: boolean }
export function runs(parts: readonly string[]): Run[] {
  const out: Run[] = []
  parts.forEach((part, i) => {
    const pieces: Run[] = i > 0 ? [{ text: ' · ', isWarning: false }] : []
    pieces.push({ text: part, isWarning: part.startsWith('⚠') })
    for (const piece of pieces) {
      const last = out[out.length - 1]
      if (last !== undefined && !last.isWarning && !piece.isWarning) last.text += piece.text
      else out.push({ ...piece })
    }
  })
  return out
}

// whether no surface the session draws on raises a band (or nothing draws at all, as
// under -p or an SDK host), so the line goes out as a status instead; a phone or IDE
// attached beside a terminal goes without, so the terminal keeps its quiet band alone
export function needsStatus(surfaces: readonly string[]): boolean {
  return !surfaces.some(s => BAND_SURFACES.includes(s))
}

export type Crowd = { isArmed: boolean; lastToastAt: number }

// whether this live count earns a crowd toast, and the alarm's next state
export function crowdAlarm(crowd: Crowd, live: number, now: number, threshold: number) {
  if (live < threshold - CROWD_HYSTERESIS) return { toast: false, crowd: { ...crowd, isArmed: true } }
  if (live >= threshold && crowd.isArmed && now - crowd.lastToastAt >= CROWD_QUIET_MS) {
    return { toast: true, crowd: { isArmed: false, lastToastAt: now } }
  }
  return { toast: false, crowd }
}

// an agent by the task it was given, falling back to its id when it has none
export function agentLabel(id: string, description: string | undefined): string {
  if (id === 'main') return 'The main thread'
  return description !== undefined && description !== '' ? description : `Agent ${id.slice(0, 8)}`
}

// a configured number, or the default when unset or not a number, held within bounds
export function setting(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

// module state: a reload starts these over, so a toast may repeat once after one
let crowd: Crowd = { isArmed: true, lastToastAt: -Infinity }
const flaggedContext = new Set<string>()
let lastRefreshAt = -Infinity
// the line the band draws
let line: string[] | undefined

// the band draws the line where it is raised; the status carries it where it is not
async function show($: EngineInterface, parts: string[]) {
  if (line === undefined || line.join(' · ') !== parts.join(' · ')) {
    line = parts
    $.ui.invalidate('ui.render')
  }
  $.ui.status(needsStatus(await $.session.surfaces()) ? parts.join(' · ') : undefined)
}

async function refresh($: EngineInterface, limits: Thresholds) {
  const now = await $.clock.now()
  lastRefreshAt = now
  const agents = await read($, agentsSeen)
  const listed = await $.agent.list()
  const running = new Set(listed.filter(a => isLive(a.status)).map(a => a.id))
  const descriptions = new Map(listed.map(a => [a.id, a.description]))
  const tree = new Map<string, AgentNode>(listed.map(a => [a.id, { parentId: a.parentId, name: a.name }]))
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const cwd = shortPath(await $.session.cwd(), home)
  await show($, modelParts(await $.session.model(), agents, running, limits, cwd, tree))

  const live = liveAgents(agents, running)
  const alarm = crowdAlarm(crowd, live.length, now, limits.liveAgents)
  crowd = alarm.crowd
  if (alarm.toast) $.ui.toast(`${live.length} agents are running at once in this session`)
  for (const id of live) {
    const context = agents[id]?.context ?? 0
    if (context >= limits.context && !flaggedContext.has(id)) {
      flaggedContext.add(id)
      $.ui.toast(`${agentLabel(id, descriptions.get(id))} is re-reading ${tokens(context)} of context on every request`)
    }
  }
}

export const register: Register = (on, options) => {
  const limits: Thresholds = {
    liveAgents: setting(options.liveAgentsWarn, 6, 2, 100),
    context: setting(options.contextWarnK, 300, 10, 10_000) * 1000,
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($, limits)
    // agents finish between steps: keep the live counts honest
    $.clock.every(15_000, () => refresh($, limits).catch(() => undefined))
    return result
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await update($, agentsSeen, () => ({}))
    flaggedContext.clear()
    crowd = { isArmed: true, lastToastAt: -Infinity }
    const result = await next(e)
    await refresh($, limits)
    return result
  })

  // every model request of the main loop, a subagent or an in-process teammate
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    // a request that got no response used no model
    if (usage === null) return result
    // the model that actually answered (a fallback may differ from the one asked)
    const model = usage.model
    const id = e.agentId ?? 'main'
    const context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    // absent for a model that takes no effort
    const effort = e.effort
    // a new agent, model or effort redraws at once; otherwise the throttle decides
    const before = (await read($, agentsSeen))[id]
    const isNew = before?.model !== model || before.effort !== effort
    await update($, agentsSeen, agents => ({ ...agents, [id]: { model, context, effort } }))
    if (isNew || (await $.clock.now()) - lastRefreshAt >= REFRESH_MIN_MS) await refresh($, limits)
    return result
  })

  // these two gate the engine: a failed redraw must not fail the switch or the move
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await refresh($, limits).catch(() => undefined)
    return result
  })

  // a shell `cd`, `/cd` or a worktree move
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    await refresh($, limits).catch(() => undefined)
    return result
  })

  // a phone or an IDE joining or leaving changes whether the status is needed
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (line !== undefined) await show($, line)
    return result
  })
  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    if (line !== undefined) await show($, line)
    return result
  })

  // one dim line in the band above the prompt, under what the plugins beneath drew;
  // only the parts marked ⚠ take the warning color
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || line === undefined) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Text wrap="truncate-end">
          {runs(fitLine(line, e.props.bodyColumns)).map(r => (r.isWarning ? <Text color="warning">{r.text}</Text> : <Text dimColor>{r.text}</Text>))}
        </Text>
      </Box>
    )
  })
}
