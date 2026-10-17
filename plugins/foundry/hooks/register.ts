import type { AgentInfo, EngineInterface, Register, ToolCallResult } from 'claude-code'

// the agent type every crew lead runs as; only a lead the main thread started heads a crew
export const LEAD_TYPE = 'foundry:lead'
// marks text this mod wrote
export const MARK = '[foundry]'
// the main session, as SendMessage addresses it
export const MAIN = 'main'
// how a lead's question to the person begins
export const QUESTION = 'QUESTION:'
// past this size the message log is rolled to messages.<n>.jsonl, well under what one $.fs.read takes
export const ROLL_BYTES = 3 * 1024 * 1024
// statuses of an agent that is still working or can still be woken
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])

// What the mod needs of an agent. `name` is what SendMessage addresses it by (the engine's, which may carry a
// suffix); `label` is the name it was spawned with, else its id, and names its crew and its report file.
// `live`: in the latest agent list and still working; `seq`: when the mod first saw it, newest highest.
export type Agent = Pick<AgentInfo, 'id' | 'type' | 'status' | 'description'> & {
  name?: string
  parentId?: string
  label?: string
  live?: boolean
  seq?: number
}

// the crew an agent works in: the lead at its top, the crew's name, and whether the agent is that lead
export type Crew = { crew: string; leadId: string; leadName: string; isLead: boolean }

export function isLead(agent: Agent): boolean {
  return agent.type === LEAD_TYPE && agent.parentId === undefined
}

// the one name an agent's crew, report file and notes go by: its spawn name, else its id
export function labelOf(agent: Agent): string {
  if (agent.label !== undefined && agent.label !== '') return agent.label
  return agent.name !== undefined && agent.name !== '' ? agent.name : agent.id
}

// the crew's name is its lead's label
export function crewName(lead: Agent): string {
  return labelOf(lead)
}

function isLive(agent: Agent): boolean {
  return agent.live ?? LIVE.has(agent.status)
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

export function rolledPath(dir: string, n: number): string {
  return `${dir}/messages.${n}.jsonl`
}

// The agents `to` addresses: the one with that id; else those with that name (a listing's " [ref]" dropped) that
// are live; else, when none is, the newest one seen with it. Empty when nothing matches.
export function recipientsOf(to: string, agents: readonly Agent[]): Agent[] {
  const bare = to.replace(/\s*\[[^\]]*\]\s*$/, '')
  const byId = agents.find(a => a.id === bare)
  if (byId !== undefined) return [byId]
  const named = agents.filter(a => a.name === bare || labelOf(a) === bare)
  const live = named.filter(isLive)
  if (live.length > 0) return live
  const newest = named.reduce<Agent | undefined>((best, a) => (best === undefined || (a.seq ?? 0) > (best.seq ?? 0) ? a : best), undefined)
  return newest === undefined ? [] : [newest]
}

export type MessageVerdict =
  | { kind: 'pass' }
  | { kind: 'allow'; crossCrew: false }
  | { kind: 'allow'; crossCrew: true; fromCrew: string; toCrew: string }
  | { kind: 'deny'; reason: string }

const MEMBER_RULE = 'crew members message only their own lead and the other members of their crew'

// Who a crew agent may message. A member: its own lead and its crew's other members. A lead: "main", its own
// members, and the other leads. Anything else from inside a crew is refused, including an address no agent of this
// session has had; agents outside every crew are not this mod's business.
export function messageVerdict(senderId: string | undefined, to: unknown, agents: readonly Agent[]): MessageVerdict {
  const sender = crewOf(senderId, agents)
  if (sender === undefined) return { kind: 'pass' }
  const address = typeof to === 'string' ? to.trim() : ''
  if (address === MAIN || address.startsWith(`${MAIN} [`)) {
    if (sender.isLead) return { kind: 'allow', crossCrew: false }
    return { kind: 'deny', reason: `${MARK} Refused: ${MEMBER_RULE}. Put your question in a message to your lead, ${sender.leadName}, which asks "main" for you.` }
  }
  const targets = address === '' ? [] : recipientsOf(address, agents)
  const crews = targets.map(t => crewOf(t.id, agents))
  if (new Set(crews.map(c => c?.leadId)).size > 1) {
    return { kind: 'deny', reason: `${MARK} Refused: more than one live agent is named "${address}", in different crews. Address it by its agent id.` }
  }
  const target = crews[0]
  if (target !== undefined && target.leadId === sender.leadId) return { kind: 'allow', crossCrew: false }
  if (sender.isLead && target?.isLead) return { kind: 'allow', crossCrew: true, fromCrew: sender.crew, toCrew: target.crew }
  if (sender.isLead) {
    const via = target === undefined ? 'Message "main", your own members, or another crew\'s lead.' : `Send it to that crew's lead, ${target.leadName}, instead.`
    return { kind: 'deny', reason: `${MARK} Refused: a lead reaches another crew only through its lead. ${via}` }
  }
  return { kind: 'deny', reason: `${MARK} Refused: ${MEMBER_RULE}. To reach anyone else, tell your lead, ${sender.leadName}.` }
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

// the first line of a lead's question to the person, or undefined when the text is not one
export function questionOf(text: string): string | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith(QUESTION)) return undefined
  return trimmed.slice(QUESTION.length).split('\n')[0]?.trim() ?? ''
}

// 95_000 -> 2m ago, 7_200_000 -> 2h ago
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export type CrewStatus = { crew: string; status: string; live: Record<string, number>; lastReportMs?: number; question?: string; dir?: string }

export function statusText(crews: readonly CrewStatus[], now: number, messages?: string): string {
  if (crews.length === 0) return 'No foundry crews in this session. Start them with /foundry:run.'
  const lines = [`Crews (${crews.length}):`]
  for (const c of crews) {
    const total = Object.values(c.live).reduce((a, b) => a + b, 0)
    const byModel = Object.entries(c.live).sort(([a], [b]) => a.localeCompare(b)).map(([m, n]) => `${m} ${n}`).join(', ')
    const members = total === 0 ? 'no live members' : `${total} live member${total === 1 ? '' : 's'} (${byModel})`
    const report =
      c.question !== undefined ? `waiting on you: ${c.question}` : c.lastReportMs === undefined ? 'no report yet' : `last report ${ago(now - c.lastReportMs)}`
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
  // the order agents were first seen in
  seq: number
  // the name each agent was spawned with, else its id: the one name its report file and crew go by
  labels: Map<string, string>
  // the model each agent was started on, from agent.spawn
  models: Map<string, string>
  // agents whose report was captured from their hand-back; their next stop leaves the file alone, once
  handedBack: Set<string>
  // the question each lead is waiting on the person for, by lead id
  waiting: Map<string, string>
  // this session's foundry folder, resolved once from the session's working directory
  root?: string
}

// The session's foundry folder: worked out once, from the session's own working directory, so the path a note
// names and the path a report is written to always agree. Not cached while it cannot be found.
async function rootOf($: $, state: State): Promise<string | undefined> {
  if (state.root !== undefined) return state.root
  const root = foundryDir(await gitCommonDir($, await $.session.cwd()), await homeDir($), await $.session.id())
  if (root !== undefined) state.root = root
  return root
}

// the live list, merged into what was seen before
async function agentsOf($: $, state: State): Promise<{ all: Agent[]; live: Agent[] }> {
  const listed = await $.agent.list()
  const ids = new Set(listed.map(a => a.id))
  for (const a of state.known.values()) if (!ids.has(a.id)) a.live = false
  const live: Agent[] = []
  for (const a of listed) {
    const before = state.known.get(a.id)
    const seq = before?.seq ?? state.seq++
    const agent: Agent = { id: a.id, type: a.type, status: a.status, description: a.description, name: a.name, parentId: a.parentId, label: state.labels.get(a.id), live: LIVE.has(a.status), seq }
    state.known.set(a.id, agent)
    live.push(agent)
  }
  return { all: [...state.known.values()], live }
}

async function writeReport($: $, state: State, crew: Crew, id: string, text: string) {
  const dir = await rootOf($, state)
  if (dir === undefined) return
  // an agent started before the mod loaded has no spawn name on record: its listed name, else its id
  const known = state.known.get(id)
  await $.fs.write(reportPath(dir, crew.crew, state.labels.get(id) ?? (known === undefined ? id : labelOf(known))), text)
  // a lead's captured text tells whether it stopped on a question for the person
  if (crew.isLead) {
    const question = questionOf(text)
    if (question === undefined) state.waiting.delete(id)
    else state.waiting.set(id, question)
  }
}

// one line onto the message log; past ROLL_BYTES the log moves to the next free messages.<n>.jsonl first
async function appendMessage($: $, state: State, entry: { from: string; to: string; summary: string }) {
  const dir = await rootOf($, state)
  if (dir === undefined) return
  const path = messagesPath(dir)
  let before = ''
  if (await $.fs.exists(path)) {
    const text = String(await $.fs.read(path))
    if ((await $.fs.stat(path)).size >= ROLL_BYTES) {
      let n = 1
      while (await $.fs.exists(rolledPath(dir, n))) n++
      await $.fs.write(rolledPath(dir, n), text)
    } else {
      before = text
    }
  }
  const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...entry })
  const sep = before === '' || before.endsWith('\n') ? '' : '\n'
  await $.fs.write(path, `${before}${sep}${line}\n`)
}

async function lastModified($: $, dir: string): Promise<number | undefined> {
  if (!(await $.fs.exists(dir))) return undefined
  let last: number | undefined
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file') continue
    const { mtimeMs } = await $.fs.stat(`${dir}/${f.name}`)
    if (last === undefined || mtimeMs > last) last = mtimeMs
  }
  return last
}

async function statusOf($: $, state: State): Promise<string> {
  const { all, live } = await agentsOf($, state)
  const liveIds = new Set(live.map(a => a.id))
  const dir = await rootOf($, state)
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
    const lastReportMs = reports === undefined ? undefined : await lastModified($, reports)
    crews.push({ crew, status: liveIds.has(lead.id) ? lead.status : 'ended', live: counts, lastReportMs, question: state.waiting.get(lead.id), dir: reports })
  }
  const log = dir === undefined ? undefined : messagesPath(dir)
  return statusText(crews, await $.clock.now(), log !== undefined && (await $.fs.exists(log)) ? log : undefined)
}

export const register: Register = on => {
  const state: State = { known: new Map(), seq: 0, labels: new Map(), models: new Map(), handedBack: new Set(), waiting: new Map() }
  // appends to the messages log, one at a time
  let appending: Promise<unknown> = Promise.resolve()

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    state.known.clear()
    state.labels.clear()
    state.models.clear()
    state.handedBack.clear()
    state.waiting.clear()
    state.root = undefined
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id !== undefined) {
      const label = e.name !== undefined && e.name !== '' ? e.name : id
      state.labels.set(id, label)
      state.known.set(id, { id, type: e.subagentType, status: 'running', description: e.description, name: e.name, parentId: e.parentAgentId, label, live: true, seq: state.seq++ })
      state.models.set(id, started.model)
    }
    return started
  }).catch(failOpen)

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const input = e as unknown as { to?: unknown; summary?: unknown; message?: unknown }
    if (e.agentId === undefined) {
      // the foreman answering a lead: that lead is no longer waiting on the person
      const result = await next(e)
      if (result.deny === undefined && typeof input.to === 'string' && state.waiting.size > 0) {
        const to = input.to
        await safely($, 'answer check', async () => {
          for (const t of recipientsOf(to, (await agentsOf($, state)).all)) state.waiting.delete(t.id)
        })
      }
      return result
    }
    const sender = e.agentId
    const decided = await safely($, 'SendMessage check', async () => messageVerdict(sender, input.to, (await agentsOf($, state)).all))
    if (decided?.kind === 'deny') return { deny: decided.reason }
    const result = await next(e)
    if (decided?.kind !== 'allow' || result.deny !== undefined) return result
    if (input.to === MAIN && typeof input.message === 'string') {
      const question = questionOf(input.message)
      if (question !== undefined) state.waiting.set(sender, question)
    }
    if (decided.crossCrew) {
      const entry = { from: decided.fromCrew, to: decided.toCrew, summary: typeof input.summary === 'string' ? input.summary : '' }
      appending = appending.then(() => safely($, 'message log', () => appendMessage($, state, entry)))
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
      const dir = await rootOf($, state)
      const id = (result.result as { agentId?: unknown } | undefined)?.agentId
      if (dir === undefined || typeof id !== 'string') return undefined
      // the name agent.spawn recorded, which the report file will carry
      const name = state.labels.get(id) ?? (e.name !== undefined && e.name !== '' ? e.name : id)
      return reportNote(name, reportPath(dir, caller?.crew?.crew ?? name, name))
    })
    return note === undefined ? result : withNote(result, note)
  }).catch(failOpen)

  // a report sent through the hand-back tool is the agent's real report; its last message may be only a sign-off
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) !== 'SubagentHandback' || e.agentId === undefined) return next(e)
    const id = e.agentId
    const message = (e as unknown as { message?: unknown }).message
    if (typeof message === 'string' && message.trim() !== '') {
      // marked before any await, so a stop that races this capture never overwrites it
      state.handedBack.add(id)
      await safely($, 'hand-back capture', async () => {
        const crew = crewOf(id, (await agentsOf($, state)).all)
        if (crew !== undefined) await writeReport($, state, crew, id, message)
      })
    }
    return next(e)
  }).catch(failOpen)

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    // the hand-back already holds this stop's report; the agent's next stop is captured again
    if (state.handedBack.delete(e.agent_id)) return result
    await safely($, 'report capture', async () => {
      const text = e.last_assistant_message
      if (text === undefined || text.trim() === '') return
      const crew = crewOf(e.agent_id, (await agentsOf($, state)).all)
      if (crew !== undefined) await writeReport($, state, crew, e.agent_id, text)
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
