import type { AgentInfo, EngineInterface, Register, ToolCallResult } from 'claude-code'

// the agent type every crew lead runs as; only a lead the main thread started heads a crew
export const LEAD_TYPE = 'foundry:lead'
// marks text this mod wrote
export const MARK = '[foundry]'
// the main session, as SendMessage addresses it
export const MAIN = 'main'
// statuses of an agent that is still working or can still be woken
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])

// what the mod needs of an agent: its id, type, name and parent
export type Agent = Pick<AgentInfo, 'id' | 'type' | 'status' | 'description'> & { name?: string; parentId?: string }

// the crew an agent works in: the lead at its top, the crew's name, and whether the agent is that lead
export type Crew = { crew: string; leadId: string; leadName: string; isLead: boolean }

export function isLead(agent: Agent): boolean {
  return agent.type === LEAD_TYPE && agent.parentId === undefined
}

// the crew's name is its lead's name; a lead started without one goes by its id
export function crewName(lead: Agent): string {
  return lead.name !== undefined && lead.name !== '' ? lead.name : lead.id
}

// The crew `id` works in: it is a lead the main thread started, or one of its ancestors is. Undefined for every
// other agent, including the main thread and agents of a lead some other agent started.
export function crewOf(id: string | undefined, agents: readonly Agent[]): Crew | undefined {
  if (id === undefined) return undefined
  const byId = new Map(agents.map(a => [a.id, a]))
  const seen = new Set<string>()
  let at = byId.get(id)
  while (at !== undefined && !seen.has(at.id)) {
    seen.add(at.id)
    if (at.parentId === undefined) {
      if (!isLead(at)) return undefined
      return { crew: crewName(at), leadId: at.id, leadName: crewName(at), isLead: at.id === id }
    }
    at = byId.get(at.parentId)
  }
  return undefined
}

// a name safe as one path segment
export function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+|\.{2,}/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
  return cleaned === '' ? 'agent' : cleaned
}

function slashed(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

// Where this session's foundry files live: in the repo's git common dir, so every worktree of it shares one place,
// or under the home folder outside git. Undefined when neither is known.
export function foundryDir(gitCommonDir: string | undefined, home: string | undefined, sessionId: string): string | undefined {
  const base = gitCommonDir !== undefined && gitCommonDir !== '' ? slashed(gitCommonDir) : home !== undefined && home !== '' ? `${slashed(home)}/.claude` : undefined
  return base === undefined ? undefined : `${base}/foundry/${safeName(sessionId)}`
}

export function reportDir(dir: string, crew: string): string {
  return `${dir}/reports/${safeName(crew)}`
}

export function reportPath(dir: string, crew: string, agent: string): string {
  return `${reportDir(dir, crew)}/${safeName(agent)}.md`
}

export function messagesPath(dir: string): string {
  return `${dir}/messages.jsonl`
}

// the agent `to` addresses: by name (a listing's " [ref]" dropped) or by id
export function recipientOf(to: string, agents: readonly Agent[]): Agent | undefined {
  const bare = to.replace(/\s*\[[^\]]*\]\s*$/, '')
  return agents.find(a => a.id === bare) ?? agents.find(a => a.name === bare)
}

export type MessageVerdict =
  | { kind: 'pass' }
  | { kind: 'allow'; crossCrew: false }
  | { kind: 'allow'; crossCrew: true; fromCrew: string; toCrew: string }
  | { kind: 'deny'; reason: string }

// Who a crew agent may message: the main session always, its own crew, and, for a lead, the other leads.
// Anything else from inside a crew is refused; agents outside every crew are not this mod's business.
export function messageVerdict(senderId: string | undefined, to: unknown, agents: readonly Agent[]): MessageVerdict {
  const sender = crewOf(senderId, agents)
  if (sender === undefined) return { kind: 'pass' }
  const address = typeof to === 'string' ? to.trim() : undefined
  if (address === MAIN || address?.startsWith(`${MAIN} [`)) return { kind: 'allow', crossCrew: false }
  const target = address === undefined ? undefined : recipientOf(address, agents)
  // a member the lead named `<crew>-<role>` that has already ended is no longer listed
  const targetCrew = target !== undefined ? crewOf(target.id, agents) : address?.startsWith(`${sender.crew}-`) ? sender : undefined
  if (targetCrew !== undefined && targetCrew.leadId === sender.leadId) return { kind: 'allow', crossCrew: false }
  if (sender.isLead && targetCrew?.isLead) return { kind: 'allow', crossCrew: true, fromCrew: sender.crew, toCrew: targetCrew.crew }
  if (sender.isLead) {
    const via = targetCrew === undefined ? 'Message "main", your own members, or another crew\'s lead.' : `Send it to that crew's lead, ${targetCrew.leadName}, instead.`
    return { kind: 'deny', reason: `${MARK} Refused: a lead reaches another crew only through its lead. ${via}` }
  }
  return {
    kind: 'deny',
    reason: `${MARK} Refused: crew agents message only their own crew and "main". To reach another crew, tell your lead, ${sender.leadName}, and it will message that crew's lead.`,
  }
}

export const MODEL_REFUSAL = `${MARK} Refused: inside a crew, every Agent call sets \`model\`: "opus" for judgment-heavy work (design, debugging, review, tricky code), "sonnet" for mechanical or well-specified work. Call Agent again with model set.`

// an Agent call from inside a crew must name its model
export function agentVerdict(callerId: string | undefined, model: unknown, agents: readonly Agent[]): { deny: string } | undefined {
  if (crewOf(callerId, agents) === undefined) return undefined
  return typeof model === 'string' && model !== '' ? undefined : { deny: MODEL_REFUSAL }
}

export function reportNote(who: string, path: string): string {
  return `${MARK} If ${who}'s report does not reach you, read ${path} once it stops.`
}

// 95_000 -> 1m ago, 7_200_000 -> 2h ago
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export type CrewStatus = { crew: string; status: string; live: Record<string, number>; lastReportMs?: number; dir?: string }

export function statusText(crews: readonly CrewStatus[], now: number, messages?: string): string {
  if (crews.length === 0) return 'No foundry crews in this session. Start them with /foundry:run.'
  const lines = [`Crews (${crews.length}):`]
  for (const c of crews) {
    const total = Object.values(c.live).reduce((a, b) => a + b, 0)
    const byModel = Object.entries(c.live).sort(([a], [b]) => a.localeCompare(b)).map(([m, n]) => `${m} ${n}`).join(', ')
    const members = total === 0 ? 'no live members' : `${total} live member${total === 1 ? '' : 's'} (${byModel})`
    const report = c.lastReportMs === undefined ? 'no report yet' : `last report ${ago(now - c.lastReportMs)}`
    lines.push(`- ${c.crew}: ${c.status}, ${members}, ${report}`)
    if (c.dir !== undefined) lines.push(`  reports: ${c.dir}`)
  }
  if (messages !== undefined) lines.push(`Messages between leads: ${messages}`)
  return lines.join('\n')
}

// the model names `$.agent.spawn` answers ("claude-sonnet-4-6") counted by family
export function family(model: string | undefined): string {
  if (model === undefined || model === '') return 'unknown'
  const m = /(opus|sonnet|haiku|fable)/i.exec(model)
  return m?.[1] !== undefined ? m[1].toLowerCase() : model
}

type $ = EngineInterface

async function gitCommonDir($: $, cwd: string | undefined): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: 15_000 })
    const out = r.stdout.replace(/\r/g, '').trim()
    return r.exitCode === 0 && out !== '' ? out : undefined
  } catch {
    return undefined
  }
}

async function homeDir($: $): Promise<string | undefined> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
}

// this session's foundry folder, as seen from `cwd`
async function dirFor($: $, cwd: string | undefined, sessionId?: string): Promise<string | undefined> {
  return foundryDir(await gitCommonDir($, cwd), await homeDir($), sessionId ?? (await $.session.id()))
}

// A hook step that must never break the session: an error is logged and the step skipped.
async function safely<T>($: $, what: string, step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step()
  } catch (error) {
    try {
      $.ui.log(`foundry: ${what} failed, letting the call through: ${String(error)}`, { to: 'debug' })
    } catch {
      // nothing left to do
    }
    return undefined
  }
}

// A hook that throws or overruns its budget anyway: answering undefined leaves the hook absent, so the call goes on
// as if foundry were not installed.
const failOpen = ($: $, _e: unknown, next: { error?: unknown }) => {
  try {
    $.ui.log(`foundry: a hook failed and was skipped: ${String(next.error)}`, { to: 'debug' })
  } catch {
    // nothing left to do
  }
  return undefined
}

function withNote(result: ToolCallResult, note: string): ToolCallResult {
  if (result.deny !== undefined) return result
  return { ...result, context: [...(result.context ?? []), note] }
}

// what the mod keeps for the session; a reload or /clear starts it over
type State = {
  // every agent seen this session, so a member whose lead has ended still resolves to its crew
  known: Map<string, Agent>
  // the model each agent was started on, from agent.spawn
  models: Map<string, string>
  // agents whose report was captured from their hand-back, which a later stop must not overwrite
  handedBack: Set<string>
}

// the live list, merged into what was seen before
async function agentsOf($: $, state: State): Promise<{ all: Agent[]; live: Agent[] }> {
  const live = (await $.agent.list()).map(a => ({ id: a.id, type: a.type, status: a.status, description: a.description, name: a.name, parentId: a.parentId }))
  for (const a of live) state.known.set(a.id, a)
  return { all: [...state.known.values()], live }
}

async function writeReport($: $, cwd: string | undefined, sessionId: string | undefined, crew: Crew, agent: Agent | undefined, id: string, text: string) {
  const dir = await dirFor($, cwd, sessionId)
  if (dir === undefined) return
  await $.fs.write(reportPath(dir, crew.crew, agent?.name ?? id), text)
}

async function appendMessage($: $, entry: { from: string; to: string; summary: string }) {
  const dir = await dirFor($, await $.session.cwd())
  if (dir === undefined) return
  const path = messagesPath(dir)
  const before = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...entry })
  const sep = before === '' || before.endsWith('\n') ? '' : '\n'
  await $.fs.write(path, `${before}${sep}${line}\n`)
}

async function statusOf($: $, state: State): Promise<string> {
  const { all, live } = await agentsOf($, state)
  const liveIds = new Set(live.map(a => a.id))
  const dir = await dirFor($, await $.session.cwd())
  const crews: CrewStatus[] = []
  for (const lead of all.filter(isLead)) {
    const crew = crewName(lead)
    const counts: Record<string, number> = {}
    for (const a of live) {
      if (a.id === lead.id || !LIVE.has(a.status) || crewOf(a.id, all)?.leadId !== lead.id) continue
      const m = family(state.models.get(a.id))
      counts[m] = (counts[m] ?? 0) + 1
    }
    const reports = dir === undefined ? undefined : reportDir(dir, crew)
    let lastReportMs: number | undefined
    if (reports !== undefined && (await $.fs.exists(reports))) {
      for (const f of await $.fs.list(reports)) if (f.kind === 'file' && (lastReportMs === undefined || f.mtimeMs > lastReportMs)) lastReportMs = f.mtimeMs
    }
    crews.push({ crew, status: liveIds.has(lead.id) ? lead.status : 'ended', live: counts, lastReportMs, dir: reports })
  }
  const log = dir === undefined ? undefined : messagesPath(dir)
  return statusText(crews, await $.clock.now(), log !== undefined && (await $.fs.exists(log)) ? log : undefined)
}

export const register: Register = on => {
  const state: State = { known: new Map(), models: new Map(), handedBack: new Set() }
  // appends to the messages log, one at a time
  let appending: Promise<unknown> = Promise.resolve()

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    state.known.clear()
    state.models.clear()
    state.handedBack.clear()
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined) {
      state.known.set(started.agentId, { id: started.agentId, type: e.subagentType, status: 'running', description: e.description, name: e.name, parentId: e.parentAgentId })
      state.models.set(started.agentId, started.model)
    }
    return started
  }).catch(failOpen)

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const input = e as unknown as { to?: unknown; summary?: unknown }
    const decided = await safely($, 'SendMessage check', async () => messageVerdict(e.agentId, input.to, (await agentsOf($, state)).all))
    if (decided?.kind === 'deny') return { deny: decided.reason }
    const result = await next(e)
    if (decided?.kind === 'allow' && decided.crossCrew && result.deny === undefined) {
      const entry = { from: decided.fromCrew, to: decided.toCrew, summary: typeof input.summary === 'string' ? input.summary : '' }
      appending = appending.then(() => safely($, 'message log', () => appendMessage($, entry)))
      await appending
    }
    return result
  }).catch(failOpen)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const caller = await safely($, 'Agent check', async () => {
      if (e.agentId === undefined) return undefined
      const all = (await agentsOf($, state)).all
      return { crew: crewOf(e.agentId, all), refused: agentVerdict(e.agentId, e.model, all) }
    })
    if (caller?.refused !== undefined) return caller.refused
    const result = await next(e)
    const startsLead = e.agentId === undefined && e.subagent_type === LEAD_TYPE
    if (result.deny !== undefined || (caller?.crew === undefined && !startsLead)) return result
    const note = await safely($, 'report note', async () => {
      const dir = await dirFor($, await $.session.cwd())
      if (dir === undefined) return undefined
      const id = (result.result as { agentId?: unknown } | undefined)?.agentId
      const name = e.name !== undefined && e.name !== '' ? e.name : typeof id === 'string' ? id : undefined
      if (name === undefined) return undefined
      const crew = caller?.crew?.crew ?? name
      return reportNote(name, reportPath(dir, crew, name))
    })
    return note === undefined ? result : withNote(result, note)
  }).catch(failOpen)

  // a report sent through the hand-back tool is the agent's real report; its last message may be only a sign-off
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) !== 'SubagentHandback' || e.agentId === undefined) return next(e)
    const result = await next(e)
    if (result.deny !== undefined) return result
    const id = e.agentId
    await safely($, 'hand-back capture', async () => {
      const message = (e as unknown as { message?: unknown }).message
      if (typeof message !== 'string' || message.trim() === '') return
      const all = (await agentsOf($, state)).all
      const crew = crewOf(id, all)
      if (crew === undefined) return
      await writeReport($, await $.session.cwd(), undefined, crew, all.find(a => a.id === id), id, message)
      state.handedBack.add(id)
    })
    return result
  }).catch(failOpen)

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    await safely($, 'report capture', async () => {
      const text = e.last_assistant_message
      if (text === undefined || text.trim() === '' || state.handedBack.has(e.agent_id)) return
      const all = (await agentsOf($, state)).all
      const crew = crewOf(e.agent_id, all)
      if (crew === undefined) return
      await writeReport($, e.cwd, e.session_id, crew, all.find(a => a.id === e.agent_id), e.agent_id, text)
    })
    return result
  }).catch(failOpen)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await safely($, 'command register', () =>
      $.command.register({ name: 'foundry', description: 'Show the foundry crews in this session: status, live members by model, last report', argumentHint: '[status]' }),
    )
    return started
  })

  on('command.run', { command: 'foundry' }, async ($, e) => {
    const text = await safely($, 'status', () => statusOf($, state))
    return { text: text ?? 'foundry could not read the crews; see the debug log.' }
  })
}
