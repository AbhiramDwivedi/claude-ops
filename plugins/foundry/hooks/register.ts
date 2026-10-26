import type { AgentInfo, ClassicResult, EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'

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
// idle this long while running = stalled
export const STALL_MS = 15 * 60_000
// the stall check timer period
export const HEARTBEAT_MS = 60_000
// wake this long after a usage window's resetsAt
export const RESET_GRACE_MS = 2 * 60_000
// most blocks per lead per stop streak
export const LEAD_STOP_BLOCKS = 2
export const STALLED = '[foundry] stalled:'
export const LIMIT_RESET = '[foundry] limit reset:'
// how a lead says it cannot go on without help, proposes a change, or stops part-way
export const BLOCKED = 'BLOCKED:'
export const PROPOSAL = 'PROPOSAL:'
export const CHECKPOINT = 'CHECKPOINT:'
// the note the main session gets at its start, naming this session's foundry folder
export const DIR_NOTE = '[foundry] dir:'
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

// every agent whose parent chain reaches `id`, live or not
export function descendantsOf(id: string, agents: readonly Agent[]): Agent[] {
  const byId = new Map(agents.map(a => [a.id, a]))
  return agents.filter(a => {
    const seen = new Set<string>()
    let at = a.parentId
    while (at !== undefined && !seen.has(at)) {
      if (at === id) return true
      seen.add(at)
      at = byId.get(at)?.parentId
    }
    return false
  })
}

// A lead's stop is interim while it still has work out: a live descendant, or a running or pending background task
// whose id is one of its descendants'. The session-wide task list also holds other crews' tasks; those are ignored.
export function isInterimStop(descendants: readonly Agent[], tasks: readonly { id: string; status: string }[] | undefined): boolean {
  if (descendants.some(isLive)) return true
  const ids = new Set(descendants.map(d => d.id))
  return (tasks ?? []).some(t => (t.status === 'running' || t.status === 'pending') && ids.has(t.id))
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

const EFFORTS = ['low', 'medium', 'high', 'xhigh']

export const EFFORT_REFUSAL = `${MARK} Refused: inside a crew, every Agent call sets \`effort\` to one of "low", "medium", "high" or "xhigh": "low" for lookups and mechanical edits, "medium" for well-specified work, "high" or "xhigh" for hard design, debugging or review. Call Agent again with effort set.`
export const MAX_EFFORT_REFUSAL = `${MARK} Refused: effort "max" is not allowed inside a crew; "xhigh" is the top. Call Agent again with effort set to "low", "medium", "high" or "xhigh".`

// an Agent call from inside a crew must name its effort, and never "max"
export function effortVerdict(callerId: string | undefined, effort: unknown, agents: readonly Agent[]): { deny: string } | undefined {
  if (crewOf(callerId, agents) === undefined) return undefined
  if (effort === 'max') return { deny: MAX_EFFORT_REFUSAL }
  return typeof effort === 'string' && EFFORTS.includes(effort) ? undefined : { deny: EFFORT_REFUSAL }
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

// The tags a lead's message to main, or its report, can start with, and what /foundry shows for each.
export type Tag = { kind: 'waiting on you' | 'blocked' | 'proposal'; text: string }

const TAGS: readonly [string, Tag['kind']][] = [
  [QUESTION, 'waiting on you'],
  [BLOCKED, 'blocked'],
  [PROPOSAL, 'proposal'],
]

// the tag a text starts with and the first line after it, or undefined when it starts with none
export function tagOf(text: string): Tag | undefined {
  const trimmed = text.trimStart()
  for (const [prefix, kind] of TAGS) {
    if (trimmed.startsWith(prefix)) return { kind, text: trimmed.slice(prefix.length).split('\n')[0]?.trim() ?? '' }
  }
  return undefined
}

// A lead's final text that may end its run: a checkpoint, a blocker or a question, or a report with a Proof section.
export function leadStopPasses(text: string): boolean {
  const trimmed = text.trimStart()
  return [CHECKPOINT, BLOCKED, QUESTION].some(p => trimmed.startsWith(p)) || /^##\s+Proof\b/m.test(text)
}

export const LEAD_STOP_REASON = `${MARK} Not done yet: finish with your report, in the sections Summary, Branch, Changes, Proof, Checks run and Open questions (each a "## " heading), or, if you cannot finish, start your final message with CHECKPOINT:, BLOCKED: or QUESTION:.`

export function stallText(label: string, crew: string, minutes: number): string {
  return `${STALLED} ${label} in crew ${crew}, no activity for ${minutes}m. Check /foundry and message the ${crew} lead.`
}

export function limitResetText(resetsAt: string): string {
  return `${LIMIT_RESET} the five-hour usage window reset at ${resetsAt}. Check /foundry and message each lead whose crew isn't done to resume.`
}

// the first line of a judge's report past VERDICT:, or undefined when it has none
export function verdictOf(text: string): string | undefined {
  const first = text.trimStart().split('\n')[0] ?? ''
  return first.startsWith('VERDICT:') ? first.slice('VERDICT:'.length).trim() : undefined
}

// a crew's judge report files: <crew>-judge.md and <crew>-judge-<n>.md
export function isJudgeFile(crew: string, file: string): boolean {
  const prefix = `${safeName(crew)}-judge`
  if (!file.startsWith(prefix) || !file.endsWith('.md')) return false
  const middle = file.slice(prefix.length, -'.md'.length)
  return middle === '' || /^-\d+$/.test(middle)
}

// 95_000 -> 2m ago, 7_200_000 -> 2h ago
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export type CrewStatus = {
  crew: string
  status: string
  live: Record<string, number>
  lastReportMs?: number
  // a lead's open question to the person; `tag` wins when both are set
  question?: string
  tag?: Tag
  // the lead ended its turn (or its run) while its members still work
  waitingOnMembers?: boolean
  // when the lead last did anything, as far as this mod saw
  lastActiveMs?: number
  // the crew's agents flagged as stalled, and for how many whole minutes
  stalled?: { label: string; minutes: number }[]
  judge?: string
  dir?: string
}

export function statusText(crews: readonly CrewStatus[], now: number, messages?: string, root?: string): string {
  const dirLine = root === undefined ? [] : [`Foundry dir: ${root}`]
  if (crews.length === 0) return ['No foundry crews in this session. Start them with /foundry:run.', ...dirLine].join('\n')
  const lines = [`Crews (${crews.length}):`]
  for (const c of crews) {
    const total = Object.values(c.live).reduce((a, b) => a + b, 0)
    const byModel = Object.entries(c.live).sort(([a], [b]) => a.localeCompare(b)).map(([m, n]) => `${m} ${n}`).join(', ')
    const members = total === 0 ? 'no live members' : `${total} live member${total === 1 ? '' : 's'} (${byModel})`
    const tag = c.tag ?? (c.question !== undefined ? { kind: 'waiting on you', text: c.question } : undefined)
    const report =
      tag !== undefined
        ? `${tag.kind}: ${tag.text}`
        : c.waitingOnMembers === true
          ? 'waiting on members'
          : c.lastReportMs === undefined
            ? 'no report yet'
            : `last report ${ago(now - c.lastReportMs)}`
    const active = c.lastActiveMs === undefined ? '' : `, last active ${ago(now - c.lastActiveMs)}`
    lines.push(`- ${c.crew}: ${c.status}, ${members}, ${report}${active}`)
    for (const s of c.stalled ?? []) lines.push(`  ${s.label}: stalled ${s.minutes}m`)
    if (c.judge !== undefined) lines.push(`  judge: ${c.judge}`)
    if (c.dir !== undefined) lines.push(`  reports: ${c.dir}`)
  }
  if (messages !== undefined) lines.push(`Messages between leads: ${messages}`)
  lines.push(...dirLine)
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

// what the mod keeps for the session; a reload or /clear starts it over (the armed limit reset lives in $.state)
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
  // each pending hand-back's message, by agent: what a lead's stop is judged on
  handBacks: Map<string, string>
  // the tag (question, blocker, proposal) each lead shows in /foundry until answered or replaced, by lead id
  waiting: Map<string, Tag>
  // when each agent last made a tool call or a model request, by id
  activity: Map<string, number>
  // agents already reported as stalled; new activity takes them off
  stalled: Set<string>
  // how many stops of each lead's current stop streak were blocked
  streaks: Map<string, number>
  // this session's foundry folder, resolved once from the session's working directory
  root?: string
}

const LIMIT_RESET_REF = { plugin: 'foundry', key: 'limitReset' } as const

// The session's foundry folder: worked out once, from the session's own working directory, so the path a note
// names and the path a report is written to always agree. Not cached while it cannot be found.
async function rootOf($: $, state: State): Promise<string | undefined> {
  if (state.root !== undefined) return state.root
  const root = foundryDir(await gitCommonDir($, await $.session.cwd()), await homeDir($), await $.session.id())
  if (root !== undefined) state.root = root
  return root
}

// the agent list, merged into what was seen before. `listed` is every agent the list returned, whatever its
// status (a completed or killed agent can still be listed); test isLive for an agent that is still at work.
async function agentsOf($: $, state: State): Promise<{ all: Agent[]; listed: Agent[] }> {
  const answer = await $.agent.list()
  const ids = new Set(answer.map(a => a.id))
  for (const a of state.known.values()) if (!ids.has(a.id)) a.live = false
  const listed: Agent[] = []
  for (const a of answer) {
    const before = state.known.get(a.id)
    const seq = before?.seq ?? state.seq++
    const agent: Agent = { id: a.id, type: a.type, status: a.status, description: a.description, name: a.name, parentId: a.parentId, label: state.labels.get(a.id), live: LIVE.has(a.status), seq }
    state.known.set(a.id, agent)
    listed.push(agent)
  }
  return { all: [...state.known.values()], listed }
}

// an agent did something: it is not stalled, whatever it was before
function touch(state: State, id: string, at: number) {
  const before = state.activity.get(id)
  if (before === undefined || at > before) state.activity.set(id, at)
  state.stalled.delete(id)
}

// Records activity without waiting on it: a tool call or a model step never pays for the clock read.
function noteActivity($: $, state: State, id: string) {
  try {
    void $.clock.now().then(
      at => touch(state, id, at),
      () => undefined,
    )
  } catch {
    // a clock that throws records nothing
  }
}

// what the stop gate needs of a stopping agent: whether it is a lead, and its descendants as last listed
async function stopperOf($: $, state: State, id: string, type: string | undefined): Promise<{ lead: boolean; descendants: Agent[] }> {
  const all = (await agentsOf($, state)).all
  const lead = type === LEAD_TYPE || all.find(a => a.id === id)?.type === LEAD_TYPE
  return { lead, descendants: lead ? descendantsOf(id, all) : [] }
}

// `tags` false: an interim stop's text is kept on disk but neither sets nor clears what /foundry shows
async function writeReport($: $, state: State, crew: Crew, id: string, text: string, tags = true) {
  const dir = await rootOf($, state)
  if (dir === undefined) return
  // an agent started before the mod loaded has no spawn name on record: its listed name, else its id
  const known = state.known.get(id)
  await $.fs.write(reportPath(dir, crew.crew, state.labels.get(id) ?? (known === undefined ? id : labelOf(known))), text)
  // a lead's captured text tells whether it stopped on a question, a blocker or a proposal
  if (crew.isLead && tags) {
    const tag = tagOf(text)
    if (tag === undefined) state.waiting.delete(id)
    else state.waiting.set(id, tag)
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

// the verdict on the first line of the crew's latest judge report (highest k in -judge-<k>.md; bare -judge.md is k=1), if it has one
async function judgeOf($: $, dir: string, crew: string): Promise<string | undefined> {
  if (!(await $.fs.exists(dir))) return undefined
  let latest: { name: string; k: number } | undefined
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !isJudgeFile(crew, f.name)) continue
    const k = Number(/-(\d+)\.md$/.exec(f.name)?.[1] ?? 1)
    if (latest === undefined || k > latest.k) latest = { name: f.name, k }
  }
  return latest === undefined ? undefined : verdictOf(String(await $.fs.read(`${dir}/${latest.name}`)))
}

async function statusOf($: $, state: State): Promise<string> {
  const { all, listed } = await agentsOf($, state)
  // a listed lead shows its own status, completed or killed included; one the list dropped shows as ended
  const listedIds = new Set(listed.map(a => a.id))
  const dir = await rootOf($, state)
  const now = await $.clock.now()
  const crews: CrewStatus[] = []
  for (const lead of all.filter(isLead)) {
    const crew = crewName(lead)
    const counts: Record<string, number> = {}
    const stalled: { label: string; minutes: number }[] = []
    for (const a of listed) {
      if (crewOf(a.id, all)?.leadId !== lead.id) continue
      const last = state.activity.get(a.id)
      if (state.stalled.has(a.id) && a.status === 'running' && last !== undefined) stalled.push({ label: labelOf(a), minutes: Math.floor((now - last) / 60_000) })
      if (a.id === lead.id || !LIVE.has(a.status)) continue
      const m = family(state.models.get(a.id))
      counts[m] = (counts[m] ?? 0) + 1
    }
    const reports = dir === undefined ? undefined : reportDir(dir, crew)
    const lastReportMs = reports === undefined ? undefined : await lastModified($, reports)
    const judge = reports === undefined ? undefined : await safely($, 'judge verdict', () => judgeOf($, reports, crew))
    crews.push({
      crew,
      status: listedIds.has(lead.id) ? lead.status : 'ended',
      live: counts,
      lastReportMs,
      tag: state.waiting.get(lead.id),
      waitingOnMembers: !(listedIds.has(lead.id) && lead.status === 'running') && descendantsOf(lead.id, all).some(isLive),
      lastActiveMs: state.activity.get(lead.id),
      stalled,
      judge,
      dir: reports,
    })
  }
  const log = dir === undefined ? undefined : messagesPath(dir)
  return statusText(crews, now, log !== undefined && (await $.fs.exists(log)) ? log : undefined, dir)
}

// One pass of the heartbeat: every running crew agent idle STALL_MS or more is reported once, with a toast and a
// prompt to the main session. An agent with nothing on record counts as active from now.
async function stallCheck($: $, state: State) {
  const now = await $.clock.now()
  const { all, listed } = await agentsOf($, state)
  for (const a of listed) {
    // running only: a listed agent that is idle, waiting or done is never stalled
    if (a.status !== 'running') continue
    const crew = crewOf(a.id, all)
    if (crew === undefined) continue
    const last = state.activity.get(a.id)
    if (last === undefined) {
      state.activity.set(a.id, now)
      continue
    }
    if (state.stalled.has(a.id) || now - last < STALL_MS) continue
    // flagged before any await, so an overlapping check never reports it twice
    state.stalled.add(a.id)
    const label = labelOf(a)
    const minutes = Math.floor((now - last) / 60_000)
    await safely($, 'stall wake', async () => {
      try {
        $.ui.toast(`${STALLED} ${label} (crew ${crew.crew}), no activity for ${minutes}m`)
      } catch {
        // the prompt below still goes out
      }
      await $.prompt.submit({ text: stallText(label, crew.crew, minutes) })
    })
  }
}

// The module's timers. A hot reload cancels them with the old module and starts this record over; a repeated
// session.start in the same module replaces each, so there is never more than one of either.
type Wakes = {
  heartbeat?: Timer
  // a stall check is under way; the next period skips rather than overlap it
  checking: boolean
  // the limit-reset timer and the resetsAt it is for
  reset?: { resetsAt: string; timer: Timer }
  // the resetsAt values this module has woken the foreman for
  fired: Set<string>
  // limit-reset work runs one step at a time, so two triggers for one reset never both arm
  work: Promise<unknown>
}

function startHeartbeat($: $, state: State, wakes: Wakes) {
  wakes.heartbeat?.cancel()
  wakes.heartbeat = $.clock.every(HEARTBEAT_MS, () => {
    if (wakes.checking) return
    wakes.checking = true
    void safely($, 'stall check', () => stallCheck($, state)).finally(() => {
      wakes.checking = false
    })
  })
}

// does $.state say positively that this resetsAt's wake has gone out? An unreadable or stale state says no.
async function firedFor($: $, resetsAt: string): Promise<{ fired: boolean; version?: number; ours: boolean }> {
  try {
    const held = await $.state.get(LIMIT_RESET_REF)
    const ours = held.value?.resetsAt === resetsAt
    return { fired: ours && held.value?.fired === true, version: held.version, ours: ours || held.value === undefined }
  } catch {
    return { fired: false, ours: false }
  }
}

// The timer's resetsAt is the source of truth: the wake goes out once for it unless $.state positively says it
// already went. The module guard stops a second run in this module; the $.state claim stops one after a reload.
async function fireReset($: $, wakes: Wakes, resetsAt: string) {
  if (wakes.reset?.resetsAt === resetsAt) wakes.reset = undefined
  if (wakes.fired.has(resetsAt)) return
  wakes.fired.add(resetsAt)
  const before = await firedFor($, resetsAt)
  if (before.fired) return
  // claimed before the prompt goes out; a state holding another window's reset is left alone
  if (before.ours) {
    const claimed = await $.state
      .set(LIMIT_RESET_REF, { resetsAt, fired: true }, before.version === undefined ? undefined : { ifVersion: before.version })
      .catch(() => undefined)
    // lost the claim: fire anyway unless whoever won says this reset has fired
    if (claimed !== undefined && !claimed.isSet && (await firedFor($, resetsAt)).fired) return
  }
  await $.prompt.submit({ text: limitResetText(resetsAt) })
}

async function scheduleReset($: $, wakes: Wakes, resetsAt: string) {
  const due = Date.parse(resetsAt)
  if (Number.isNaN(due)) return
  const now = await $.clock.now()
  wakes.reset?.timer.cancel()
  const timer = $.clock.after(Math.max(0, due + RESET_GRACE_MS - now), () => {
    void safely($, 'limit reset wake', () => fireReset($, wakes, resetsAt))
  })
  wakes.reset = { resetsAt, timer }
}

// a five-hour window at its limit while a crew is live: wake the foreman once it resets, once per resetsAt
async function armReset($: $, state: State, wakes: Wakes, resetsAt: string) {
  if (Number.isNaN(Date.parse(resetsAt))) return
  // a lead still at work, not one that is listed but completed, failed or killed
  if (!(await agentsOf($, state)).listed.some(a => isLead(a) && isLive(a))) return
  const held = await $.state.get(LIMIT_RESET_REF)
  if (held.value?.resetsAt === resetsAt) {
    // fired already, or a timer is running; one a reload took is armed again by session.start
    if (held.value.fired || wakes.reset?.resetsAt === resetsAt) return
  } else {
    await $.state.set(LIMIT_RESET_REF, { resetsAt, fired: false })
  }
  await scheduleReset($, wakes, resetsAt)
}

// session.start: a reload took the limit-reset timer with the old module, so arm it again from $.state
async function rearmReset($: $, wakes: Wakes) {
  const held = await $.state.get(LIMIT_RESET_REF)
  if (held.value !== undefined && !held.value.fired) await scheduleReset($, wakes, held.value.resetsAt)
}

async function resetFromUsage($: $, state: State, wakes: Wakes) {
  const resetsAt = (await $.session.usage()).rateLimits.find(l => l.kind === 'five_hour' && typeof l.resetsAt === 'string')?.resetsAt
  if (resetsAt !== undefined) await armReset($, state, wakes, resetsAt)
}

function queueLimit($: $, wakes: Wakes, what: string, step: () => Promise<unknown>): Promise<unknown> {
  wakes.work = wakes.work.then(() => safely($, what, step))
  return wakes.work
}

export const register: Register = on => {
  const state: State = {
    known: new Map(),
    seq: 0,
    labels: new Map(),
    models: new Map(),
    handedBack: new Set(),
    handBacks: new Map(),
    waiting: new Map(),
    activity: new Map(),
    stalled: new Set(),
    streaks: new Map(),
  }
  const wakes: Wakes = { checking: false, fired: new Set(), work: Promise.resolve() }
  // appends to the messages log, one at a time
  let appending: Promise<unknown> = Promise.resolve()

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    state.known.clear()
    state.labels.clear()
    state.models.clear()
    state.handedBack.clear()
    state.handBacks.clear()
    state.waiting.clear()
    state.activity.clear()
    state.stalled.clear()
    state.streaks.clear()
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
      // a tagged message to main sets what /foundry shows for the lead; an untagged one replaces it with nothing
      const tag = tagOf(input.message)
      if (tag !== undefined) state.waiting.set(sender, tag)
      else state.waiting.delete(sender)
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
      return { crew: crewOf(e.agentId, all), refused: agentVerdict(e.agentId, e.model, all) ?? effortVerdict(e.agentId, e.effort, all) }
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

  // Every tool call of an agent is activity. A report sent through the hand-back tool is the agent's real report;
  // its last message may be only a sign-off.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const id = e.agentId
    noteActivity($, state, id)
    if ((e.tool as string) !== 'SubagentHandback') return next(e)
    const message = (e as unknown as { message?: unknown }).message
    if (typeof message === 'string' && message.trim() !== '') {
      // marked before any await, so a stop that races this capture never overwrites it
      state.handedBack.add(id)
      state.handBacks.set(id, message)
      await safely($, 'hand-back capture', async () => {
        const all = (await agentsOf($, state)).all
        const crew = crewOf(id, all)
        if (crew === undefined) return
        // a lead's report the stop gate will send back is not its report: the stop that goes through writes it
        if (all.find(a => a.id === id)?.type === LEAD_TYPE && !leadStopPasses(message)) return
        await writeReport($, state, crew, id, message)
      })
    }
    return next(e)
  }).catch(failOpen)

  // every model request of an agent is activity; the stream passes untouched
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) noteActivity($, state, e.agentId)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    // turn.step streams, so its catch is a generator: log as failOpen does, then let the stream go on
    failOpen($, e, next)
    return yield* next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    const id = e.agent_id
    // A lead may stop only on a finished report or a tagged hand-off, at most LEAD_STOP_BLOCKS times a streak. A stop
    // while its members still work is interim: it goes through and leaves the streak and the tag alone.
    const gate = await safely($, 'lead stop gate', async () => {
      const stopper = await stopperOf($, state, id, e.agent_type)
      if (!stopper.lead) return { lead: false, interim: false }
      if (isInterimStop(stopper.descendants, e.background_tasks)) return { lead: true, interim: true }
      const count = e.stop_hook_active ? (state.streaks.get(id) ?? 0) : 0
      const text = state.handBacks.get(id) ?? e.last_assistant_message ?? ''
      if (count >= LEAD_STOP_BLOCKS || leadStopPasses(text)) {
        state.streaks.delete(id)
        return { lead: true, interim: false }
      }
      state.streaks.set(id, count + 1)
      return { lead: true, interim: false, block: LEAD_STOP_REASON }
    })
    const handBack = state.handBacks.get(id)
    state.handBacks.delete(id)
    if (gate?.block !== undefined) {
      // the hand-back belonged to the stop sent back; the next one is judged and captured afresh
      state.handedBack.delete(id)
      return { ...result, block: gate.block }
    }
    const tags = gate?.interim !== true
    // the hand-back already holds this stop's report; the agent's next stop is captured again
    if (state.handedBack.delete(id)) {
      if (gate?.lead === true && handBack !== undefined && !leadStopPasses(handBack)) {
        // a lead's hand-back the gate could have sent back was held; this stop went through, so it is the report
        await safely($, 'report capture', async () => {
          const crew = crewOf(id, (await agentsOf($, state)).all)
          if (crew !== undefined) await writeReport($, state, crew, id, handBack, tags)
        })
      }
      return result
    }
    await safely($, 'report capture', async () => {
      const text = e.last_assistant_message
      if (text === undefined || text.trim() === '') return
      const crew = crewOf(id, (await agentsOf($, state)).all)
      if (crew !== undefined) await writeReport($, state, crew, id, text, tags)
    })
    return result
  }).catch(failOpen)

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    const hit = e.rateLimits.find(l => l.kind === 'five_hour' && l.percentUsed >= 100 && typeof l.resetsAt === 'string')
    const resetsAt = hit?.resetsAt
    if (resetsAt !== undefined) await queueLimit($, wakes, 'limit reset', () => armReset($, state, wakes, resetsAt))
    return result
  }).catch(failOpen)

  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (e.error === 'rate_limit') await queueLimit($, wakes, 'limit reset', () => resetFromUsage($, state, wakes))
    return result
  }).catch(failOpen)

  // the main session learns where this session's foundry files live
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined) return result
    const dir = await safely($, 'dir note', () => rootOf($, state))
    return dir === undefined ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), `${DIR_NOTE} ${dir}`] }
  }).catch(failOpen)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await safely($, 'command register', () =>
      $.command.register({ name: 'foundry', description: 'Show the foundry crews in this session: status, live members by model, last report', argumentHint: '[status]' }),
    )
    await safely($, 'stall timer', async () => startHeartbeat($, state, wakes))
    await queueLimit($, wakes, 'limit reset re-arm', () => rearmReset($, wakes))
    return started
  })

  on('command.run', { command: 'foundry' }, async ($, e) => {
    const text = await safely($, 'status', () => statusOf($, state))
    return { text: text ?? 'foundry could not read the crews; see the debug log.' }
  })
}
