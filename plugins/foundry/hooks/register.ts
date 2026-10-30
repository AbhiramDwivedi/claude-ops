import type { AgentInfo, ClassicResult, EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'

import { amendPlan, goalLine, goalOf, RUN_GOAL } from './intake.ts'

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
// longest a call or stop waits on one event-log append (ADR-0003 s1, P5); the append itself still lands later
export const EVENT_WAIT_MS = 2000
// most event-log appends queued at once; past it new events are dropped, so a hung fs cannot grow memory without end.
// Events come seconds apart, so 200 queued means the fs has been stuck for a long while.
export const EVENT_BACKLOG_MAX = 200
// idle this long while running = stalled
export const STALL_MS = 15 * 60_000
// the stall check timer period
export const HEARTBEAT_MS = 60_000
// wake this long after a usage window's resetsAt
export const RESET_GRACE_MS = 2 * 60_000
// most blocks per lead per stop streak
export const LEAD_STOP_BLOCKS = 2
export const STALLED = '[foundry] stalled:'
export const IDLE_LEAD = '[foundry] idle lead:'
export const LIMIT_RESET = '[foundry] limit reset:'
// how a lead says it cannot go on without help, proposes a change, or stops part-way
export const BLOCKED = 'BLOCKED:'
export const PROPOSAL = 'PROPOSAL:'
export const CHECKPOINT = 'CHECKPOINT:'
// a hand-back shorter than this, once trimmed, is not a report
export const HANDBACK_MIN = 40
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

// where an interim stop's text goes, beside the report, so the report the foreman is told to read stays the last real one
export function interimPath(dir: string, crew: string, agent: string): string {
  return `${reportDir(dir, crew)}/${safeName(agent)}.interim.md`
}

export function isInterimFile(file: string): boolean {
  return file.endsWith('.interim.md')
}

export function messagesPath(dir: string): string {
  return `${dir}/messages.jsonl`
}

export function rolledPath(dir: string, n: number): string {
  return `${dir}/messages.${n}.jsonl`
}

// the event log (ADR-0003 s1, docs/events.schema.json) and where it rolls to
export function eventsPath(dir: string): string {
  return `${dir}/events.jsonl`
}

export function rolledEventsPath(dir: string, n: number): string {
  return `${dir}/events.${n}.jsonl`
}

// One event-log line past the fields every line carries (v, ts, crew, agent). No field holds message, prompt or
// report text (P8).
export type FoundryEvent =
  | { event: 'spawn'; crew: string; agent: string; agentId: string | null; type: string; model: string | null; effort: string | null; by: string }
  | { event: 'stall'; crew: string; agent: string; kind: 'agent' | 'idle-lead'; minutes: number }
  | { event: 'tag'; crew: string; agent: string; tag: 'QUESTION' | 'BLOCKED' | 'PROPOSAL' }
  | { event: 'report'; crew: string; agent: string; marker: ReportMarker | null }
  | { event: typeof BUDGET_SPENT_EVENT; crew: string; agent: string }
  | FetchEvent

// The fetch gate (ADR-0005 s11): every WebFetch and WebSearch call passes this one pure function. It allows every call
// today; a guardrail added later is a change here and its tests alone.
export type FetchEvent =
  | { event: 'fetch'; crew: string; agent: string; tool: 'WebFetch'; url: string }
  | { event: 'fetch'; crew: string; agent: string; tool: 'WebSearch'; query: string }
export type FetchVerdict = { kind: 'allow'; line: FetchEvent | null } | { kind: 'deny'; line: FetchEvent | null; reason: string }

// the url as logged: userinfo and fragment dropped, each query value emptied (keys kept, in order); "" when it isn't a url
function loggedUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.hash = ''
    const emptied = new URLSearchParams()
    for (const key of new URLSearchParams(url.search).keys()) emptied.append(key, '')
    url.search = emptied.toString()
    return url.toString()
  } catch {
    return ''
  }
}

export function fetchVerdict(tool: 'WebFetch' | 'WebSearch', input: { readonly url?: unknown; readonly query?: unknown }, crew: string, agent: string, hasPlan: boolean): FetchVerdict {
  if (!hasPlan) return { kind: 'allow', line: null }
  if (tool === 'WebFetch') return { kind: 'allow', line: { event: 'fetch', crew, agent, tool, url: loggedUrl(input.url) } }
  return { kind: 'allow', line: { event: 'fetch', crew, agent, tool, query: typeof input.query === 'string' ? input.query.slice(0, 200) : '' } }
}

const MARKERS = ['VERDICT: PASS', 'VERDICT: FAIL', 'REDTEAM', 'CHECKPOINT', 'BLOCKED', 'QUESTION', 'PROPOSAL'] as const
export type ReportMarker = (typeof MARKERS)[number]

// the marker a report's first non-empty line starts with, or null
export function markerOf(text: string): ReportMarker | null {
  const first = text.split('\n').find(l => l.trim() !== '')?.trimStart() ?? ''
  if (/^VERDICT: (PASS|FAIL) \| /.test(first)) return null // the template line, not a verdict
  return MARKERS.find(m => first.startsWith(m)) ?? null
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

// plan.json as the hooks read it (ADR-0001 s8): only the fields the gates and /foundry use, each left unchecked
export type Plan = { approval: unknown; approvedAt: unknown; maxParallelCrews: unknown; crews: unknown[]; version: unknown; repairBudget: unknown; goal: unknown; goals: unknown }
type PlanCrew = Record<string, unknown>

const DEFAULT_CAP = 4

export function planPath(dir: string): string {
  return `${dir}/plan.json`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isWave = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// The plan, or undefined when the text is not one the gates can read: empty, not JSON, not an object, or with no
// crews array. Undefined means no gate and no plan lines, as in 0.2.1. A leading UTF-8 BOM is stripped first.
export function parsePlan(text: string): Plan | undefined {
  let value: unknown
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !Array.isArray(value.crews)) return undefined
  return { approval: value.approval, approvedAt: value.approvedAt, maxParallelCrews: value.maxParallelCrews, crews: value.crews, version: value.version, repairBudget: value.repairBudget, goal: value.goal, goals: value.goals }
}

// The plan entry a lead's name is gated as. A name that is a plan slug is that crew. Otherwise the successor rule: a
// name `<base>-<n>`, n an integer >= 2, whose base is a plan slug, is gated as that base crew, so restarting a crew
// under a fresh name can't slip past its gates. That holds for the name successorCrew suggests; plain nextCrew can
// slip (phase-1 -> phase-2 is another crew's slug), so the idle prompt uses successorCrew. One suffix only is
// stripped, and a name that is itself a slug never is. Undefined: no gate.
export function planCrewFor(plan: Plan, name: string): { slug: string; crew: PlanCrew } | undefined {
  const find = (slug: string) => plan.crews.find((c): c is PlanCrew => isRecord(c) && c.slug === slug)
  const own = find(name)
  if (own !== undefined) return { slug: name, crew: own }
  const m = /^(.+)-([0-9]+)$/.exec(name)
  if (m?.[1] === undefined || m[2] === undefined || Number(m[2]) < 2) return undefined
  const base = find(m[1])
  return base === undefined ? undefined : { slug: m[1], crew: base }
}

// Why the plan refuses starting the lead `name`, and what /foundry says that crew waits for, or undefined when it may
// start. The gates, first match wins (ADR-0010 s3): run approval, a reserved goal id, a crew goal the plan doesn't
// have, goal approval, crew approval, the wave gate within the crew's goal, the parallel cap across goals. The crew
// being started is every entry with the target's slug (the schema allows duplicate slugs; wave and ownerApproval come
// from the first). None of them counts as running, since its own entry may already say running (a restart, or a
// successor gated as its base), and none of them is in the earlier-wave check, so a crew can't hold itself back.
export function gateOf(plan: Plan, name: string): { deny: string; waits: string } | undefined {
  const target = planCrewFor(plan, name)
  if (target === undefined) return undefined
  const stop = (deny: string, waits: string) => ({ deny, waits })
  if (plan.approval === 'owner' && plan.approvedAt === null) return stop(`this run changes the design; get the owner's approval first`, `waits for the owner's approval of the plan`)
  const goals = Array.isArray(plan.goals) ? plan.goals.filter(isRecord) : []
  if (goals.some(g => g.id === RUN_GOAL)) return stop(`goal id run is reserved for the run's first goal; rename it in plan.json`, `waits for a fix: goal id run is reserved`)
  const goal = goalOf(target.crew)
  const entry = goals.find(g => g.id === goal)
  if (goal !== RUN_GOAL && entry === undefined) return stop(`${target.slug} names goal ${goal}, which isn't in the plan`, `waits for a fix: goal ${goal} isn't in the plan`)
  if (entry !== undefined && entry.approval === 'owner' && entry.approvedAt === null) return stop(`goal ${goal} changes the design; get the owner's approval first`, `waits for the owner's approval of goal ${goal}`)
  if (target.crew.ownerApproval === 'pending') return stop(`${target.slug} waits for the owner's approval`, `waits for the owner's approval`)
  const others = plan.crews.filter(isRecord).filter(c => c.slug !== target.slug)
  const wave = target.crew.wave
  if (isWave(wave)) {
    const open = others.filter(c => goalOf(c) === goal && isWave(c.wave) && c.wave < wave && c.status !== 'merged' && c.status !== 'dropped')
    if (open.length > 0) {
      const lowest = Math.min(...open.map(c => c.wave as number))
      const list = open.filter(c => c.wave === lowest).map(c => planField(c.slug)).join(', ')
      return stop(`wave ${lowest} ${goal === RUN_GOAL ? '' : `of goal ${goal} `}isn't merged yet: ${list}`, `waits for wave ${lowest} to merge: ${list}`)
    }
  }
  const max = plan.maxParallelCrews
  const cap = typeof max === 'number' && Number.isInteger(max) && max >= 1 ? max : DEFAULT_CAP
  const running = others.filter(c => c.status === 'running').length
  if (running >= cap) return stop(`${running} crews running, the cap is ${cap}; start ${target.slug} when one merges`, `waits for a free slot: ${running} of ${cap} running`)
  return undefined
}

export function planVerdict(plan: Plan, name: string): { deny: string } | undefined {
  const gate = gateOf(plan, name)
  return gate === undefined ? undefined : { deny: `${MARK} Refused: ${gate.deny}` }
}

// a plan field as /foundry prints it: a string or a number as is, anything else (missing included) as ?
function planField(v: unknown): string {
  return typeof v === 'string' || isWave(v) ? String(v) : '?'
}

// the lines /foundry shows above the 0.2.1 output: one per crew, by wave, ties in the plan's queue order; with goals,
// grouped under a line per goal (ADR-0010 s5)
export function planLines(plan: Plan): string[] {
  const waiting = plan.approval === 'owner' && plan.approvedAt === null ? ', waiting for the owner' : ''
  const goals = Array.isArray(plan.goals) ? plan.goals : []
  const grouped = goals.length > 0
  const counts = grouped ? `${plan.crews.length} crews, ${1 + goals.length} goals` : `${plan.crews.length} crews`
  const lines = [`Plan (${counts}, approval ${planField(plan.approval)}${waiting}):`]
  const order = (c: unknown) => (isRecord(c) && isWave(c.wave) ? c.wave : Number.POSITIVE_INFINITY)
  const sorted = plan.crews.map((c, i) => ({ c, i })).sort((a, b) => order(a.c) - order(b.c) || a.i - b.i)
  const crewLine = (c: unknown) => {
    const crew = isRecord(c) ? c : {}
    const planned = crew.status === 'planned'
    const gate = planned ? gateOf(plan, planField(crew.slug)) : undefined
    const suffix = planned ? `, ${gate === undefined ? 'ready to start' : gate.waits}` : ''
    return `- wave ${planField(crew.wave)}: ${planField(crew.slug)}, ${planField(crew.verdict)}, ${planField(crew.status)}${suffix}`
  }
  if (!grouped) {
    for (const { c } of sorted) lines.push(crewLine(c))
    return lines
  }
  const known: unknown[] = [RUN_GOAL, ...goals.map(g => (isRecord(g) ? g.id : undefined))]
  const ids = [...known]
  for (const c of plan.crews) if (!ids.includes(goalOf(c))) ids.push(goalOf(c))
  for (const id of ids) {
    const mine = sorted.filter(({ c }) => goalOf(c) === id)
    if (known.includes(id)) {
      const entry = id === RUN_GOAL ? plan : goals.find(g => isRecord(g) && g.id === id)
      const e = isRecord(entry) ? entry : {}
      const owner = e.approval === 'owner' && e.approvedAt === null ? ', waiting for the owner' : ''
      const done = mine.every(({ c }) => isRecord(c) && (c.status === 'merged' || c.status === 'dropped')) ? ', done' : ''
      lines.push(`Goal ${planField(id)} (approval ${planField(e.approval)}${owner}${done}): ${typeof e.goal === 'string' ? goalLine(e.goal) : ''}`)
    } else {
      lines.push(`Goal ${planField(id)} (not in the plan):`)
    }
    for (const { c } of mine) lines.push(crewLine(c))
  }
  return lines
}

export function reportNote(who: string, path: string): string {
  return `${MARK} If ${who}'s report does not reach you, read ${path} once it stops.`
}

// The tags a lead's message to main, or its report, can start with, and what /foundry shows for each.
export type Tag = { kind: 'waiting on you' | 'blocked' | 'proposal'; text: string }

const TAGS: readonly [string, Tag['kind']][] = [
  [QUESTION, 'waiting on you'],
  [BLOCKED, 'blocked'],
  [PROPOSAL, 'proposal'],
]

// the tag's name as the event log writes it
export function tagName(tag: Tag): 'QUESTION' | 'BLOCKED' | 'PROPOSAL' {
  return tag.kind === 'waiting on you' ? 'QUESTION' : tag.kind === 'blocked' ? 'BLOCKED' : 'PROPOSAL'
}

// the tag a text starts with and the first line after it, or undefined when it starts with none
export function tagOf(text: string): Tag | undefined {
  const trimmed = text.trimStart()
  for (const [prefix, kind] of TAGS) {
    if (trimmed.startsWith(prefix)) return { kind, text: trimmed.slice(prefix.length).split('\n')[0]?.trim() ?? '' }
  }
  return undefined
}

// A lead's final text that may end its run: a checkpoint, a blocker, a question or a proposal, or a report with a
// Proof section.
export function leadStopPasses(text: string): boolean {
  const trimmed = text.trimStart()
  return [CHECKPOINT, BLOCKED, QUESTION, PROPOSAL].some(p => trimmed.startsWith(p)) || /^##\s+Proof\b/m.test(text)
}

export const LEAD_STOP_REASON = `${MARK} Not done yet: finish with your report, in the sections Summary, Branch, Changes, Proof, Checks run and Open questions (each a "## " heading), or, if you cannot finish, start your final message with CHECKPOINT:, BLOCKED:, QUESTION: or PROPOSAL:.`

// ADR-0004: scope-bounded claims, the bounded repair loop, the patch-bound head guard and the main-session effort
// rule. Every rule asks planAtLeastV2 first; anything else is 0.4.3 behaviour. The literals are written once, in the
// ADR's section 3; the prompts carry the same strings.
export const HEAD_LINE = 'Head: '
export const PATCH_LINE = 'Patch: '
export const EXAMINED = '## Examined'
export const NOT_EXAMINED = '## Not examined'
export const UNSCOPED = '- UNSCOPED: '
export const BUDGET_BLOCKED = 'BLOCKED: repair budget spent'
export const BUDGET_SPENT_EVENT = 'budget-spent'
export const PATCH_COMMAND = 'git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable'

export const BUDGET_REFUSAL = `${MARK} Refused: repair budget spent:`
export const NO_PASS_REASON = `${MARK} Not done yet: the crew's latest judge file this run is not a clean VERDICT: PASS. Send your final report only after a judge's PASS with no UNSCOPED finding, or start your final message with BLOCKED: or CHECKPOINT:.`
export const NO_HEAD_REASON = `${MARK} Not done yet: the crew's latest judge PASS has no "${HEAD_LINE.trim()}" and "${PATCH_LINE.trim()}" lines under ## Proof checked, so no hook can tell which head it ruled on. Start a fresh judge under the next unused name.`
export const HEAD_MOVED = `${MARK} Not done yet: the head moved:`
export const EXAMINED_REASON = `${MARK} Not done yet: on this plan your final report also needs the sections "${EXAMINED}" (what the crew checked, each with its scope) and "${NOT_EXAMINED}" (what nobody checked, or None.), each a heading of its own.`
export const MAIN_MODEL_REFUSAL = `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`model\`: "opus" or "sonnet". Call Agent again with model set.`
export const MAIN_EFFORT_REFUSAL = `${MARK} Refused: on a version 2 or later plan, every foundry:* Agent call from the main session sets \`effort\` to "low", "medium", "high" or "xhigh": "medium" by default, "high" or "xhigh" only on the owner's call. Call Agent again with effort set.`

export type JudgeFile = { name: string; text: string; mtimeMs: number }
export type JudgeRuling = { verdict: 'PASS' | 'FAIL' | undefined; head: string | undefined; patch: string | undefined; unscoped: number }

const SHA40 = /^[0-9a-f]{40}$/

// true when plan.version is an integer >= 2; false for no plan, v1, a missing or a non-integer version
export function planAtLeastV2(plan: Plan | undefined): boolean {
  return plan !== undefined && Number.isInteger(plan.version) && (plan.version as number) >= 2
}

// the plan's integer repair budget >= 0 on a v>=2 plan; else undefined, which means no budget rule
export function repairBudgetOf(plan: Plan | undefined): number | undefined {
  if (plan === undefined || !planAtLeastV2(plan)) return undefined
  const b = plan.repairBudget
  return Number.isInteger(b) && (b as number) >= 0 ? (b as number) : undefined
}

// when this run started: Date.parse(approvedAt) when it is a string that parses; else undefined
export function runStart(plan: Plan | undefined): number | undefined {
  if (plan === undefined || typeof plan.approvedAt !== 'string') return undefined
  const ms = Date.parse(plan.approvedAt)
  return Number.isFinite(ms) ? ms : undefined
}

// a spawn name whose report file is one of the crew's judge files
export function isJudgeName(crew: string, name: unknown): boolean {
  return typeof name === 'string' && name !== '' && isJudgeFile(crew, `${safeName(name)}.md`)
}

// a judge file of the crew this run: judge-named, not interim, modified at or after `since`
function thisRun(crew: string, f: JudgeFile, since: number): boolean {
  return isJudgeFile(crew, f.name) && !isInterimFile(f.name) && f.mtimeMs >= since
}

// how many of the crew's judge files this run rule FAIL, or rule PASS with an UNSCOPED finding
export function judgeFails(crew: string, files: readonly JudgeFile[], since: number): number {
  return files.filter(f => {
    if (!thisRun(crew, f, since)) return false
    const r = judgeRuling(f.text)
    return r.verdict === 'FAIL' || (r.verdict === 'PASS' && r.unscoped > 0)
  }).length
}

// the k of <crew>-judge-<k>.md; the bare <crew>-judge.md is 1
const judgeK = (name: string): number => Number(/-judge-(\d+)\.md$/.exec(name)?.[1] ?? 1)

// the crew's newest judge file this run; ties go to the higher -judge-<k>
export function latestJudge(crew: string, files: readonly JudgeFile[], since: number): JudgeFile | undefined {
  let latest: JudgeFile | undefined
  for (const f of files) {
    if (!thisRun(crew, f, since)) continue
    if (latest === undefined || f.mtimeMs > latest.mtimeMs || (f.mtimeMs === latest.mtimeMs && judgeK(f.name) > judgeK(latest.name))) latest = f
  }
  return latest
}

// the budget is spent when the FAILs are more than it; no budget rule, never spent
export function budgetSpent(plan: Plan | undefined, fails: number): boolean {
  const budget = repairBudgetOf(plan)
  return budget !== undefined && fails > budget
}

export function budgetRefusal(crew: string, fails: number, budget: number): string {
  return `${BUDGET_REFUSAL} ${crew} has ${fails} judge FAILs this run and repairBudget is ${budget}. Start no more judges: send main a message that starts with "${BUDGET_BLOCKED}", with the last judge's findings.`
}

// a judge-named spawn of a crew whose budget is spent is refused
export function judgeBudgetVerdict(plan: Plan | undefined, crew: string, name: unknown, fails: number): { deny: string } | undefined {
  const budget = repairBudgetOf(plan)
  if (budget === undefined || !isJudgeName(crew, name) || !budgetSpent(plan, fails)) return undefined
  return { deny: budgetRefusal(crew, fails, budget) }
}

const trimEnd = (line: string) => line.replace(/[ \t]+$/, '')
const linesOf = (text: string) => text.replace(/^﻿/, '').replace(/\r/g, '').split('\n')

// What a judge report rules: the verdict from its marker; the first full-line head and patch under ## Proof checked;
// the UNSCOPED lines under ## Findings. A section runs to the next line starting "## ".
export function judgeRuling(text: string): JudgeRuling {
  const lines = linesOf(text)
  const marker = markerOf(lines.join('\n'))
  const ruling: JudgeRuling = { verdict: marker === 'VERDICT: PASS' ? 'PASS' : marker === 'VERDICT: FAIL' ? 'FAIL' : undefined, head: undefined, patch: undefined, unscoped: 0 }
  let section: string | undefined
  const sha = (line: string, literal: string) => {
    if (!line.startsWith(literal)) return undefined
    const rest = trimEnd(line.slice(literal.length))
    return SHA40.test(rest) ? rest : undefined
  }
  for (const line of lines) {
    if (line.startsWith('## ')) {
      section = trimEnd(line)
      continue
    }
    if (section === '## Proof checked') {
      ruling.head ??= sha(line, HEAD_LINE)
      ruling.patch ??= sha(line, PATCH_LINE)
    } else if (section === '## Findings' && line.startsWith(UNSCOPED)) {
      ruling.unscoped++
    }
  }
  return ruling
}

// the patch id `git patch-id --stable` printed: the first field of its first line, when it is 40 lowercase hex
export function patchIdOf(stdout: string): string | undefined {
  const first = (stdout.replace(/\r/g, '').split('\n')[0] ?? '').trim().split(/\s+/)[0] ?? ''
  return SHA40.test(first) ? first : undefined
}

// `<branch> at <commit>, based on <base>.`, each optionally in single backticks; neither name may start with "-"
const BRANCH_LINE = /^`?([^\s`-][^\s`]*)`? at `?[0-9a-f]{7,40}`?, based on `?([^\s`-][^\s`]*?)`?\.?$/

// the branch and base on the first non-empty line under ## Branch, or undefined when it doesn't read
export function branchOf(report: string): { branch: string; base: string } | undefined {
  const lines = linesOf(report)
  const at = lines.findIndex(l => trimEnd(l) === '## Branch')
  if (at < 0) return undefined
  const line = lines.slice(at + 1).find(l => l.trim() !== '')
  const m = line === undefined ? null : BRANCH_LINE.exec(line.trim())
  if (m?.[1] === undefined || m[2] === undefined) return undefined
  return { branch: m[1], base: m[2] }
}

const isTagged = (text: string) => [CHECKPOINT, BLOCKED, QUESTION, PROPOSAL].some(p => text.trimStart().startsWith(p))
const hasHeading = (text: string, heading: string) => linesOf(text).some(l => trimEnd(l) === heading)

// on a v>=2 plan, an untagged final report needs both the Examined and the Not examined heading
export function examinedVerdict(plan: Plan | undefined, text: string): { block: string } | undefined {
  if (!planAtLeastV2(plan) || isTagged(text)) return undefined
  return hasHeading(text, EXAMINED) && hasHeading(text, NOT_EXAMINED) ? undefined : { block: EXAMINED_REASON }
}

export function headMovedReason(judged: string, head: string): string {
  return `${HEAD_MOVED} the judge ruled on ${judged}, the branch is at ${head}, and its patch id differs. Start a fresh judge under the next unused name on ${head}, and send your final report on its PASS.`
}

// ADR-0004 section 6's table: a clean PASS with head and patch lines whose head is the branch's, or whose patch is
export function headVerdict(plan: Plan | undefined, judge: JudgeRuling | undefined, head: string | undefined, patch: string | undefined): { block: string } | undefined {
  if (!planAtLeastV2(plan)) return undefined
  if (judge === undefined || judge.verdict !== 'PASS' || judge.unscoped > 0) return { block: NO_PASS_REASON }
  if (judge.head === undefined || judge.patch === undefined) return { block: NO_HEAD_REASON }
  if (head === undefined || head === judge.head || patch === undefined || patch === judge.patch) return undefined
  return { block: headMovedReason(judge.head, head) }
}

// on a v>=2 plan, a main-session foundry:* Agent call sets a model, then an effort other than max
export function mainCallVerdict(plan: Plan | undefined, callerId: string | undefined, type: unknown, model: unknown, effort: unknown): { deny: string } | undefined {
  if (!planAtLeastV2(plan) || callerId !== undefined || typeof type !== 'string' || !type.startsWith('foundry:')) return undefined
  if (typeof model !== 'string' || model === '') return { deny: MAIN_MODEL_REFUSAL }
  return typeof effort === 'string' && EFFORTS.includes(effort) ? undefined : { deny: MAIN_EFFORT_REFUSAL }
}

// ADR-0009 Decision 6. The role table a foundry Workflow script is given (Decision 2): opus or sonnet, low or medium
// effort, no lead, devops or integrator, keys that match ^[a-z]+$. Undefined means the table is allowed.
export function workflowRoleVerdict(roles: unknown): { deny: string } | undefined {
  const refuse = (reason: string) => ({ deny: `${MARK} Refused: ${reason}` })
  if (!isRecord(roles)) return refuse('the Workflow needs a roles table in args.foundry.roles')
  for (const [key, role] of Object.entries(roles)) {
    if (!/^[a-z]+$/.test(key)) return refuse(`Workflow role "${key}" is not a lowercase name`)
    if (key === 'lead' || key === 'devops' || key === 'integrator') return refuse(`a Workflow never runs a ${key} role`)
    if (!isRecord(role)) return refuse(`Workflow role ${key} is not an object`)
    if (role.agentType === 'foundry:lead' || role.agentType === 'foundry:devops' || role.agentType === 'foundry:integrator') return refuse(`Workflow role ${key} never runs as ${role.agentType}`)
    if (role.model !== 'opus' && role.model !== 'sonnet') return refuse(`Workflow role ${key} needs model opus or sonnet`)
    if (role.effort !== 'low' && role.effort !== 'medium') return refuse(`Workflow role ${key} needs effort low or medium`)
  }
  return undefined
}

// ADR-0009 Decision 6. Whether a Workflow call may start while a plan is on. Pure: the handler reads the files.
export function workflowCallVerdict(
  plan: Plan | undefined,
  input: { script?: unknown; scriptPath?: unknown; scriptText?: unknown; args?: unknown; pluginDir: string; pluginScriptTexts: readonly (string | undefined)[] },
): { deny: string } | undefined {
  if (!planAtLeastV2(plan)) return undefined
  const refuse = (reason: string) => ({ deny: `${MARK} Refused: ${reason}` })
  if (input.script !== undefined && input.scriptPath !== undefined) return refuse('a Workflow call gives either script or scriptPath, not both')
  const flat = (v: string) => v.replace(/\\/g, '/')
  const dir = flat(input.pluginDir)
  const path = typeof input.scriptPath === 'string' ? flat(input.scriptPath) : undefined
  const text = typeof input.scriptText === 'string' ? input.scriptText : undefined
  // pluginScriptTexts is positional: index 0 is plan.js's text, index 1 is wave.js's. An undefined entry matches nothing.
  const isPlanJs = (path !== undefined && path === `${dir}/workflows/plan.js`) || (text !== undefined && input.pluginScriptTexts[0] !== undefined && text === input.pluginScriptTexts[0])
  const isWaveJs = (path !== undefined && path === `${dir}/workflows/wave.js`) || (text !== undefined && input.pluginScriptTexts[1] !== undefined && text === input.pluginScriptTexts[1])
  const byPath = path !== undefined && (path === `${dir}/workflows/plan.js` || path === `${dir}/workflows/wave.js`)
  const byText = text !== undefined && input.pluginScriptTexts.some((t) => t !== undefined && t === text)
  if (!byPath && !byText) {
    if (input.scriptPath !== undefined && text === undefined) return refuse(ONLY_FROM_PLUGIN)
    if (text === undefined || text.includes('foundry:')) return refuse(ONLY_FROM_PLUGIN)
    return undefined
  }
  const args = input.args
  const foundry = isRecord(args) ? args.foundry : undefined
  if (!isRecord(foundry)) return refuse('a foundry Workflow needs args.foundry')
  const roles = workflowRoleVerdict(foundry.roles)
  if (roles !== undefined) return roles
  if (isPlanJs && isWaveJs) return refuse('the script matches both plan.js and wave.js')
  const shown = typeof foundry.kind === 'string' ? `"${foundry.kind}"` : JSON.stringify(foundry.kind)
  if (isPlanJs && foundry.kind !== 'plan') return refuse(`plan.js runs only with kind "plan", not ${shown}`)
  if (isWaveJs && foundry.kind !== 'wave') return refuse(`wave.js runs only with kind "wave", not ${shown}`)
  if (foundry.kind === 'plan') return plan.approvedAt ? refuse('the plan is already approved; a plan Workflow would replace it') : undefined
  if (foundry.kind !== 'wave') return refuse('a foundry Workflow runs only with kind "plan" or "wave"')
  const crews = foundry.crews
  if (!Array.isArray(crews)) return refuse('a wave Workflow needs args.foundry.crews as a list')
  for (const entry of crews) {
    const slug = isRecord(entry) ? entry.slug : undefined
    if (typeof slug !== 'string') return refuse('a wave Workflow crew has no slug')
    const target = planCrewFor(plan, slug)
    if (target === undefined || target.crew.status !== 'running') return refuse(`${slug} is not a running crew in the plan`)
    const verdict = planVerdict(plan, slug)
    if (verdict !== undefined) return verdict
  }
  return undefined
}
const ONLY_FROM_PLUGIN = `foundry agents run in a Workflow only from the plugin's plan.js and wave.js`

export function stallText(label: string, crew: string, minutes: number): string {
  return `${STALLED} ${label} in crew ${crew}, no activity for ${minutes}m. Check /foundry and message the ${crew} lead. Read its transcript tail before you stop it; a resumed agent may be compacting.`
}

// the name a successor crew takes: auth -> auth-2, gateway-3 -> gateway-4
export function nextCrew(crew: string): string {
  const m = /^(.*)-(\d+)$/.exec(crew)
  return m?.[1] !== undefined && m[2] !== undefined ? `${m[1]}-${Number(m[2]) + 1}` : `${crew}-2`
}

// The successor name the idle prompt suggests, one the plan gate maps back to the same plan crew: a plan slug C starts
// at C-2 (never an incremented C, which may be another crew), a successor B-<n> of plan slug B starts at B-<n+1>. A
// candidate that is itself a plan slug is another crew, so k counts on past it: plan [auth, auth-2] gives auth-3. n+1
// is BigInt arithmetic on the digit string, so the name is always plain digits, however large n is. No plan, or a crew
// not in it: nextCrew, as in 0.2.1.
export function successorCrew(plan: Plan | undefined, crew: string): string {
  const target = plan === undefined ? undefined : planCrewFor(plan, crew)
  if (plan === undefined || target === undefined) return nextCrew(crew)
  const isSlug = (name: string) => planCrewFor(plan, name)?.slug === name
  let k = target.slug === crew ? 2n : BigInt(crew.slice(target.slug.length + 1)) + 1n
  while (isSlug(`${target.slug}-${k}`)) k += 1n
  return `${target.slug}-${k}`
}

export function idleLeadText(label: string, crew: string, minutes: number, next: string = nextCrew(crew)): string {
  return `${IDLE_LEAD} ${label} in crew ${crew}, no report for ${minutes}m and no member at work. Read its last message and resume it with SendMessage, or start ${next} from its report.`
}

// A lead's captured report that ends its work: one with a Proof section, a checkpoint or a blocker. A question or a
// proposal waits on the foreman instead, and shows as a waiting tag.
export function isFinalReport(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith(CHECKPOINT) || trimmed.startsWith(BLOCKED) || /^##\s+Proof\b/m.test(text)
}

export const HANDBACK_REFUSAL = `${MARK} Refused: that hand-back is too short to be a report. Hand back your real report: what you did, the branch, and proof.`

// the stand-ins agents hand back instead of a report; named as well as caught by length, so a lower HANDBACK_MIN keeps them out
const STAND_INS = new Set(['placeholder', 'todo', 'tbd'])

const HAND_OFFS = [QUESTION, BLOCKED, PROPOSAL, CHECKPOINT]

// A hand-back with nothing in it: a stand-in word, or under HANDBACK_MIN characters once trimmed. A tagged hand-off
// may be short ("QUESTION: keep v1?"), but not empty or a stand-in after its tag.
export function isEmptyHandBack(message: string): boolean {
  const trimmed = message.trim()
  const tag = HAND_OFFS.find(t => trimmed.startsWith(t))
  if (tag !== undefined) {
    const rest = trimmed.slice(tag.length).trim()
    return rest === '' || STAND_INS.has(rest.toLowerCase())
  }
  return trimmed.length < HANDBACK_MIN || STAND_INS.has(trimmed.toLowerCase())
}

// `- HH:MM |` at the start of a decision-log line: the time the foreman typed, or the literal HH:MM placeholder,
// which the clock's replaces (ADR-0003 s2)
const DECISION_TIME = /^- (\d{1,2}:\d{2}|HH:MM) \|/
// the placeholder the run skill tells the foreman to type: it marks no time, so it is always stamped
const UNSTAMPED = 'HH:MM'

// 10:04 for a clock reading, in the machine's local time
export function localTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Every decision line of `text` whose time is on no decision line of `logged` gets `time`. A time `logged` already has
// marks a line that was there before, perhaps reworded or with trailing space, and it keeps that time. A literal
// HH:MM is always stamped, whether or not `logged` holds the same line.
export function stampDecisions(text: string, logged: string, time: string): string {
  const old = new Set(logged.split('\n').flatMap(l => DECISION_TIME.exec(l)?.[1] ?? []))
  return text
    .split('\n')
    .map(line => {
      const typed = DECISION_TIME.exec(line)?.[1]
      if (typed === undefined || (typed !== UNSTAMPED && old.has(typed))) return line
      return line.replace(DECISION_TIME, `- ${time} |`)
    })
    .join('\n')
}

// the decision log of session `sessionId`, wherever its foundry folder is
export function isDecisionLog(path: string, sessionId: string): boolean {
  return slashed(path).endsWith(`/foundry/${safeName(sessionId)}/decisions.md`)
}

export function limitResetText(resetsAt: string): string {
  return `${LIMIT_RESET} the five-hour usage window reset at ${resetsAt}. Check /foundry and message each lead whose crew isn't done to resume.`
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
  // the crew's live members, lead left out: what a waiting lead waits on
  members?: { label: string; status: string; runningMs: number; model: string; lastActiveMs?: number }[]
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
    for (const m of c.members ?? []) {
      const last = m.lastActiveMs === undefined ? 'no activity seen' : `last activity ${ago(now - m.lastActiveMs)}`
      lines.push(`  ${m.label} ${m.status} ${Math.floor(m.runningMs / 60_000)}m (${m.model}), ${last}`)
    }
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
  planArchitects: Map<string, 'plan' | 'amend'>
  planRoute: Promise<unknown>
  pendingPlanCalls: Map<string, 'plan' | 'amend'>
  // each pending hand-back's message, by agent: what a lead's stop is judged on
  handBacks: Map<string, string>
  // leads whose pending hand-back was held back from the report file by the Examined check (ADR-0004 s6); the stop
  // that goes through writes it
  withheld: Set<string>
  // the tag (question, blocker, proposal) each lead shows in /foundry until answered or replaced, by lead id
  waiting: Map<string, Tag>
  // when each agent last made a tool call or a model request, by id
  activity: Map<string, number>
  // agents already reported as stalled; new activity takes them off
  stalled: Set<string>
  // how many stops of each lead's current stop streak were blocked
  streaks: Map<string, number>
  // when each agent was spawned, else when the mod first saw it: how long /foundry says it has been running
  started: Map<string, number>
  // each listed agent's status at the last heartbeat pass; undefined before the first, so no agent counts as resumed
  lastPass?: Map<string, string>
  // when each lead's current idle period began: the first pass that saw it not running with nothing at work
  idleSince: Map<string, number>
  // leads already prompted for in their current idle period
  idlePrompted: Set<string>
  // when each lead's latest final report was captured
  finals: Map<string, number>
  // when each agent's current stint began: the pass that saw it running again after one that didn't. None for an
  // agent first seen running, whose stint began before the mod could tell
  stints: Map<string, number>
  // leads a pass saw go from running to stopped since they last ran: the only leads the idle check prompts for
  stopped: Set<string>
  // when the main session last made a tool call or a model request
  mainActive?: number
  // this session's foundry folder, resolved once from the session's working directory
  root?: string
  // appends to the event log, one at a time, each starting once the one before has settled; /clear leaves it be
  events: Promise<unknown>
  // how many of those appends are queued or running
  eventsPending: number
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

// The plan-file route (ADR-0015 s9): the inner lines of the first block that opens with exactly `open` and ends at the
// next line that is exactly four backticks, joined with a newline. Undefined when there is no such block.
export function fencedBlock(message: string, open: string): string | undefined {
  const lines = message.split('\n').map(l => l.replace(/\r$/, ''))
  const start = lines.indexOf(open)
  if (start < 0) return undefined
  const end = lines.indexOf('````', start + 1)
  return end < 0 ? undefined : lines.slice(start + 1, end).join('\n')
}

// A plan-mode architect's hand-back, written to the two fixed paths under the foundry dir; never over a plan that is
// approved or unreadable. Says why in the debug log when it writes nothing.
// Why the plan on disk must be kept, read fresh: undefined when there is none or it is unapproved.
async function keepReason($: $, dir: string): Promise<string | undefined> {
  if (!(await $.fs.exists(planPath(dir)))) return undefined
  let existing: Plan | undefined
  try {
    existing = parsePlan(String(await $.fs.read(planPath(dir))))
  } catch {
    return 'it could not be read'
  }
  if (existing === undefined) return 'it is not a readable plan'
  return existing.approvedAt === null ? undefined : 'it is approved'
}

// Routes run one at a time, so a second hand-back waits until the first has finished both writes; a failed route
// does not stop the chain.
function writePlanFiles($: $, state: State, message: string): Promise<void> {
  const run = state.planRoute.catch(() => undefined).then(() => routePlanFiles($, state, message))
  state.planRoute = run.catch(() => undefined)
  return run
}

async function routePlanFiles($: $, state: State, message: string): Promise<void> {
  const json = fencedBlock(message, '````json plan.json')
  const md = fencedBlock(message, '````markdown plan.md')
  if (json === undefined || md === undefined) return logRule($, `plan-file route wrote nothing: ${json === undefined ? 'no plan.json block' : 'no plan.md block'}`)
  if (parsePlan(json) === undefined) return logRule($, 'plan-file route wrote nothing: the plan.json block is not a plan')
  const dir = await rootOf($, state)
  if (dir === undefined) return logRule($, 'plan-file route wrote nothing: no foundry dir')
  let carried: unknown
  try {
    carried = JSON.parse(json.startsWith('\uFEFF') ? json.slice(1) : json)
  } catch {
    return logRule($, 'plan-file route wrote nothing: the plan.json block is not JSON')
  }
  if (!isRecord(carried)) return logRule($, 'plan-file route wrote nothing: the plan.json block is not an object')
  // Read inside the serialised route, right before the write, so an approval that lands while this route waits its turn
  // is kept. An approval landing between this read and the write is still overwritten: the foreman's edit shares no
  // lock with the hook.
  const kept = await keepReason($, dir)
  if (kept !== undefined) return logRule($, `plan-file route kept the existing plan: ${kept}`)
  await $.fs.write(planPath(dir), JSON.stringify({ ...carried, approvedAt: null }, null, 2) + '\n')
  try {
    await $.fs.write(`${dir}/plan.md`, md)
  } catch (err) {
    await logRule($, `plan-file route wrote plan.json but not plan.md: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// An amend-mode architect's hand-back (ADR-0010 s2): the goal merged into the approved plan.json, its readable plan
// written to plan-<id>.md. Shares the plan route's chain, so the two never interleave. Says why in the debug log when it
// writes nothing.
function writeAmendFiles($: $, state: State, message: string): Promise<void> {
  const run = state.planRoute.catch(() => undefined).then(() => routeAmendFiles($, state, message))
  state.planRoute = run.catch(() => undefined)
  return run
}

async function routeAmendFiles($: $, state: State, message: string): Promise<void> {
  const nothing = (reason: string) => logRule($, `plan-amend route wrote nothing: ${reason}`)
  const json = fencedBlock(message, '````json plan-amend.json')
  const md = fencedBlock(message, '````markdown plan.md')
  if (json === undefined || md === undefined) return nothing(json === undefined ? 'no plan-amend.json block' : 'no plan.md block')
  const dir = await rootOf($, state)
  if (dir === undefined) return nothing('no foundry dir')
  let amend: unknown
  try {
    amend = JSON.parse(json.startsWith('﻿') ? json.slice(1) : json)
  } catch {
    return nothing('the plan-amend.json block is not JSON')
  }
  // read inside the serialised route, right before the write, so the foreman's approval edits count
  let existing: unknown
  try {
    if (await $.fs.exists(planPath(dir))) {
      const text = String(await $.fs.read(planPath(dir)))
      existing = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
    }
  } catch {
    existing = undefined
  }
  const merged = amendPlan(existing, amend, new Date(await $.clock.now()).toISOString())
  if ('reason' in merged) return nothing(merged.reason)
  await $.fs.write(planPath(dir), JSON.stringify(merged.plan, null, 2) + '\n')
  const crews = Array.isArray(merged.plan.crews) ? merged.plan.crews.filter(c => goalOf(c) === merged.id).length : 0
  await logRule($, `plan-amend route added goal ${merged.id}: ${crews} crews`)
  try {
    await $.fs.write(`${dir}/plan-${merged.id}.md`, md)
  } catch (err) {
    await logRule($, `plan-amend route wrote plan.json but not plan-${merged.id}.md: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// The session's plan, read fresh on every call so the foreman's edits count at once; never written here. Undefined
// when there is no foundry dir or no readable plan.
async function planOf($: $, state: State): Promise<Plan | undefined> {
  const dir = await rootOf($, state)
  if (dir === undefined || !(await $.fs.exists(planPath(dir)))) return undefined
  return parsePlan(String(await $.fs.read(planPath(dir))))
}

// how long the idle prompt waits on the plan read before it names the 0.2.1 successor instead
const PLAN_READ_MS = 2000

// The plugin dir, from this module's own path (<plugin>/hooks/register.ts); undefined when it can't be worked out.
function pluginDirOf(): string | undefined {
  try {
    let p = decodeURIComponent(new URL('..', import.meta.url).pathname)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    p = p.replace(/\/+$/, '')
    return p === '' ? undefined : p
  } catch {
    return undefined
  }
}

// The plan as planOf reads it, or undefined when the read hasn't settled within `ms` on the engine clock, so a hung
// read never holds up the heartbeat pass that awaits it. The timer is cancelled once the read settles; a read that
// settles after the bound is dropped. A read that throws rejects, as planOf does.
function planWithin($: $, state: State, ms: number): Promise<Plan | undefined> {
  return new Promise((resolve, reject) => {
    const timer = $.clock.after(ms, () => resolve(undefined))
    planOf($, state).then(
      plan => {
        timer.cancel()
        resolve(plan)
      },
      (err: unknown) => {
        timer.cancel()
        reject(err)
      },
    )
  })
}

// `step`'s value, or undefined when it hasn't settled within `ms` on the engine clock, as planWithin bounds the plan
// read; a step that rejects rejects. For the ADR-0004 reads, so a hung read lets the call or stop through.
function within<T>($: $, ms: number, step: () => Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = $.clock.after(ms, () => resolve(undefined))
    step().then(
      value => {
        timer.cancel()
        resolve(value)
      },
      (err: unknown) => {
        timer.cancel()
        reject(err)
      },
    )
  })
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

// the main session's tool call or model request, recorded as noteActivity records an agent's
function noteMainActivity($: $, state: State) {
  try {
    void $.clock.now().then(
      at => {
        if (state.mainActive === undefined || at > state.mainActive) state.mainActive = at
      },
      () => undefined,
    )
  } catch {
    // a clock that throws records nothing
  }
}

// what the stop gate needs of a stopping agent: whether it is a lead the main thread started, and its descendants
// as last listed. One not yet listed is taken at its event's type.
async function stopperOf($: $, state: State, id: string, type: string | undefined): Promise<{ lead: boolean; descendants: Agent[] }> {
  const all = (await agentsOf($, state)).all
  const known = all.find(a => a.id === id)
  const lead = known === undefined ? type === LEAD_TYPE : isLead(known)
  return { lead, descendants: lead ? descendantsOf(id, all) : [] }
}

const RULINGS: ReadonlySet<string> = new Set(['VERDICT: PASS', 'VERDICT: FAIL', 'REDTEAM'])

const isRuling = (text: string) => RULINGS.has(markerOf(text) ?? '')

async function heldRuling($: $, path: string): Promise<boolean> {
  return (await safely($, 'report read', async () => (await $.fs.exists(path)) && isRuling(String(await $.fs.read(path))))) === true
}

// `tags` false: an interim stop's text goes to <label>.interim.md, leaving the report alone, and neither sets nor
// clears what /foundry shows
async function writeReport($: $, state: State, crew: Crew, id: string, text: string, tags = true) {
  const dir = await rootOf($, state)
  if (dir === undefined) return
  // an agent started before the mod loaded has no spawn name on record: its listed name, else its id
  const known = state.known.get(id)
  const label = state.labels.get(id) ?? (known === undefined ? id : labelOf(known))
  // a report that holds a ruling is kept: a later stop by the same agent with no ruling of its own (a resumed judge's
  // follow-up) is interim, since the merge gate and /foundry read the ruling from this file. A new ruling replaces it.
  if (tags && !isRuling(text) && (await heldRuling($, reportPath(dir, crew.crew, label)))) tags = false
  await $.fs.write(tags ? reportPath(dir, crew.crew, label) : interimPath(dir, crew.crew, label), text)
  if (tags) await logEvent($, state, { event: 'report', crew: crew.crew, agent: label, marker: markerOf(text) })
  // a judge's FAIL that spends the crew's repair budget is recorded once more, as its own event (ADR-0004 s5)
  if (tags && markerOf(text) === 'VERDICT: FAIL' && isJudgeName(crew.crew.toLowerCase(), label.toLowerCase())) await safely($, 'repair budget record', () => budgetRecord($, state, crew.crew, label))
  if (!crew.isLead || !tags) return
  // a lead's captured text tells whether it stopped on a question, a blocker or a proposal
  const tag = tagOf(text)
  if (tag === undefined) state.waiting.delete(id)
  else state.waiting.set(id, tag)
  // a captured report ends the lead's idle period; a final one excuses it until the lead runs again
  state.idleSince.delete(id)
  state.idlePrompted.delete(id)
  if (isFinalReport(text)) state.finals.set(id, await $.clock.now())
}

// one line onto the message log; past ROLL_BYTES the log moves to the next free messages.<n>.jsonl first
async function appendMessage($: $, state: State, entry: { from: string; to: string; summary: string }) {
  const dir = await rootOf($, state)
  if (dir === undefined) return
  const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...entry })
  await appendLine($, messagesPath(dir), n => rolledPath(dir, n), line)
}

// one line onto the event log, under docs/events.schema.json; rolls as the message log does
async function appendEvent($: $, state: State, event: FoundryEvent) {
  const dir = await rootOf($, state)
  if (dir === undefined) return
  const { event: name, ...fields } = event
  const line = JSON.stringify({ v: 1, ts: new Date(await $.clock.now()).toISOString(), event: name, ...fields })
  await appendLine($, eventsPath(dir), n => rolledEventsPath(dir, n), line)
}

// Resolves once `step` settles or after `ms` on the engine clock, whichever is first, calling `late` in the second
// case; never rejects. The timer is cancelled once the step settles. With no clock it resolves at once.
// Known limitation (red team B3): if another hook refuses $.clock.after without throwing, the timer never fires, so a
// step that never settles holds the caller with it.
function settledWithin($: $, ms: number, step: Promise<unknown>, late: () => void = () => {}): Promise<void> {
  return new Promise(resolve => {
    let timer: Timer
    try {
      timer = $.clock.after(ms, () => {
        late()
        resolve()
      })
    } catch {
      resolve()
      return
    }
    const done = () => {
      timer.cancel()
      resolve()
    }
    step.then(done, done)
  })
}

// Queues one event-log line behind the ones before it and waits for it, at most EVENT_WAIT_MS. Never throws: a failed
// append is logged and changes nothing else (P5). The queue is strictly serial and never released on a timer: an
// append starts only once the one before it has settled, so a slow write that completes late can't clobber a newer
// line. A caller whose wait runs out logs it and goes on; its line still lands later, in order, if the fs answers.
// Past EVENT_BACKLOG_MAX queued appends, a new event is dropped and logged.
function logEvent($: $, state: State, event: FoundryEvent): Promise<void> {
  const failed = (reason: string) => {
    try {
      $.ui.log(`foundry: event log failed, letting the call through: ${reason}`, { to: 'debug' })
    } catch {
      // nothing left to do
    }
  }
  if (state.eventsPending >= EVENT_BACKLOG_MAX) {
    failed(`${EVENT_BACKLOG_MAX} appends already queued`)
    return Promise.resolve()
  }
  state.eventsPending++
  const settled = () => {
    state.eventsPending--
  }
  // safely never rejects, so the chain never breaks on a failed append
  const link = state.events.then(() => safely($, 'event log', () => appendEvent($, state, event))).then(settled, settled)
  state.events = link
  return settledWithin($, EVENT_WAIT_MS, link, () => failed(`no answer in ${EVENT_WAIT_MS}ms`))
}

// `$.fs` has no append: read the log, and past ROLL_BYTES copy it to the first free rolled path and start it over.
// A roll whose copy landed but whose rewrite of the live log failed leaves the newest rolled file equal to the live
// log; the next append finds that and only starts the live log over, so no line is rolled twice.
async function appendLine($: $, path: string, rolled: (n: number) => string, line: string) {
  let before = ''
  if (await $.fs.exists(path)) {
    const text = String(await $.fs.read(path))
    if ((await $.fs.stat(path)).size >= ROLL_BYTES) {
      let n = 1
      while (await $.fs.exists(rolled(n))) n++
      const copied = n > 1 && String(await $.fs.read(rolled(n - 1))) === text
      if (!copied) await $.fs.write(rolled(n), text)
    } else {
      before = text
    }
  }
  const sep = before === '' || before.endsWith('\n') ? '' : '\n'
  await $.fs.write(path, `${before}${sep}${line}\n`)
}

async function lastModified($: $, dir: string): Promise<number | undefined> {
  if (!(await $.fs.exists(dir))) return undefined
  let last: number | undefined
  for (const f of await $.fs.list(dir)) {
    // an interim note is not a report
    if (f.kind !== 'file' || isInterimFile(f.name)) continue
    const { mtimeMs } = await $.fs.stat(`${dir}/${f.name}`)
    if (last === undefined || mtimeMs > last) last = mtimeMs
  }
  return last
}

// One debug line naming the rule that refused or sent back, and whom; never report text (P7, P8). Waited for, so
// the line lands before the call it explains returns, but at most EVENT_WAIT_MS: a hung log never holds a call.
async function logRule($: $, line: string): Promise<void> {
  try {
    await settledWithin($, EVENT_WAIT_MS, Promise.resolve().then(() => $.ui.log(`foundry: ${line}`, { to: 'debug' })))
  } catch {
    // nothing left to do
  }
}

// The crew's judge files modified at or after `since`, from reports/<crew>/. Texts are read only when `withText`.
// No folder means no judge files (ADR-0004 s5: 0 FAILs; s6: no PASS). A list, stat or read that throws rejects, and
// the caller's safely lets the call through.
async function judgeFilesOf($: $, dir: string, crew: string, since: number, withText: boolean): Promise<(JudgeFile & { path: string })[]> {
  const files: (JudgeFile & { path: string })[] = []
  if (!(await $.fs.exists(dir))) return files
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || isInterimFile(f.name) || !isJudgeFile(crew.toLowerCase(), f.name.toLowerCase())) continue
    const { mtimeMs } = await $.fs.stat(`${dir}/${f.name}`)
    if (!(mtimeMs >= since)) continue
    files.push({ name: f.name.toLowerCase(), text: withText ? String(await $.fs.read(`${dir}/${f.name}`)) : '', mtimeMs, path: `${dir}/${f.name}` })
  }
  return files
}

// The crew's judge FAILs this run, with the plan's budget rule; undefined when the plan sets none (v1, no or a bad
// repairBudget, an approvedAt that doesn't parse, no foundry dir).
// A plan read or judge-folder read that overruns its bound counts as no rule.
async function failsOf($: $, state: State, crew: string): Promise<{ plan: Plan; fails: number } | undefined> {
  const plan = await planWithin($, state, PLAN_READ_MS)
  const since = runStart(plan)
  if (plan === undefined || repairBudgetOf(plan) === undefined || since === undefined) return undefined
  const dir = await rootOf($, state)
  if (dir === undefined) return undefined
  const files = await within($, EVENT_WAIT_MS, () => judgeFilesOf($, reportDir(dir, crew), crew, since, true))
  return files === undefined ? undefined : { plan, fails: judgeFails(crew.toLowerCase(), files, since) }
}

// ADR-0004 s5: a judge-named Agent call from inside a crew whose repair budget is spent is refused
async function budgetGate($: $, state: State, crew: string, name: unknown): Promise<{ deny: string } | undefined> {
  // NTFS names are case-insensitive, so judge names and the crew compare case-folded; the refusal names the crew as given
  const folded = typeof name === 'string' ? name.toLowerCase() : name
  if (!isJudgeName(crew.toLowerCase(), folded)) return undefined
  const counted = await failsOf($, state, crew)
  const verdict = counted === undefined ? undefined : judgeBudgetVerdict(counted.plan, crew.toLowerCase(), folded, counted.fails)
  const budget = counted === undefined ? undefined : repairBudgetOf(counted.plan)
  const refused = verdict === undefined || budget === undefined ? undefined : { deny: budgetRefusal(crew, counted?.fails ?? 0, budget) }
  if (refused !== undefined) await logRule($, `repair budget gate refused a judge spawn in crew ${crew}: ${counted?.fails} judge FAILs this run`)
  return refused
}

// ADR-0004 s5: a saved judge FAIL that leaves the crew's budget spent appends one budget-spent line
async function budgetRecord($: $, state: State, crew: string, agent: string) {
  const counted = await failsOf($, state, crew)
  if (counted === undefined || !budgetSpent(counted.plan, counted.fails)) return
  await logRule($, `repair budget spent in crew ${crew} by judge ${agent}`)
  await logEvent($, state, { event: BUDGET_SPENT_EVENT, crew, agent })
}

const GIT_MS = 15_000

// A ref git resolves against the checkout it runs in (HEAD, @, ORIG_HEAD and the like in any case, as Windows git
// matches them, a per-worktree namespace, or a revision expression): in the session cwd it names the main
// checkout's commit, not the crew's, so the head guard treats it as unknown.
const PER_WORKTREE = /^(?:(?:[a-z_]*_)?head$|refs\/(?:worktree|bisect|rewritten)\/|worktrees\/|main-worktree\/)/i
function checkoutRelativeRef(ref: string): boolean {
  return ref === '@' || PER_WORKTREE.test(ref) || ['@{', '^', '~', ':'].some(c => ref.includes(c))
}

// the commit `branch` names, or undefined when git fails or prints anything but a 40-hex SHA
async function headOf($: $, cwd: string | undefined, branch: string): Promise<string | undefined> {
  if (branch.startsWith('-')) return undefined
  try {
    const r = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { cwd, timeoutMs: GIT_MS })
    const out = r.stdout.replace(/\r/g, '').trim()
    return r.exitCode === 0 && SHA40.test(out) ? out : undefined
  } catch {
    return undefined
  }
}

// PATCH_COMMAND's id for base...branch, or undefined when either half fails, is cut short or prints no id
async function patchOf($: $, cwd: string | undefined, base: string, branch: string): Promise<string | undefined> {
  if (base.startsWith('-') || branch.startsWith('-')) return undefined
  try {
    const diff = await $.process.run(['git', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${branch}`], { cwd, timeoutMs: GIT_MS })
    if (diff.exitCode !== 0 || diff.isStdoutTruncated) return undefined
    const id = await $.process.run(['git', 'patch-id', '--stable'], { cwd, timeoutMs: GIT_MS, stdin: diff.stdout })
    return id.exitCode === 0 && !id.isStdoutTruncated ? patchIdOf(id.stdout) : undefined
  } catch {
    return undefined
  }
}

// ADR-0004 s4 and s6, on a lead's text that would pass by its Proof section: on a v>=2 plan, the Examined headings,
// then, for an untagged report, the head guard. Undefined: the stop goes through.
// A plan read or judge-folder read that overruns its bound lets the stop through.
async function finalReportVerdict($: $, state: State, id: string, text: string): Promise<{ block: string; rule: string } | undefined> {
  const plan = await planWithin($, state, PLAN_READ_MS)
  if (!planAtLeastV2(plan)) return undefined
  const examined = examinedVerdict(plan, text)
  if (examined !== undefined) return { ...examined, rule: 'examined headings missing' }
  const since = runStart(plan)
  const crew = crewOf(id, [...state.known.values()])
  const dir = await rootOf($, state)
  if (isTagged(text) || since === undefined || crew === undefined || dir === undefined) return undefined
  const reports = reportDir(dir, crew.crew)
  const read = await within($, EVENT_WAIT_MS, async () => {
    const latest = latestJudge(crew.crew.toLowerCase(), await judgeFilesOf($, reports, crew.crew, since, false), since)
    return { ruling: latest === undefined ? undefined : judgeRuling(String(await $.fs.read((latest as JudgeFile & { path: string }).path))) }
  })
  if (read === undefined) return undefined
  const { ruling } = read
  // the rows that need no git: no clean PASS, or a PASS without its head lines
  const early = headVerdict(plan, ruling, undefined, undefined)
  if (early !== undefined) return { ...early, rule: early.block === NO_HEAD_REASON ? 'judge PASS has no head lines' : 'no clean judge PASS this run' }
  const where = branchOf(text)
  if (ruling === undefined || where === undefined || checkoutRelativeRef(where.branch) || checkoutRelativeRef(where.base)) return undefined
  const cwd = await $.session.cwd()
  const head = await headOf($, cwd, where.branch)
  if (head === undefined || head === ruling.head) return undefined
  const moved = headVerdict(plan, ruling, head, await patchOf($, cwd, where.base, where.branch))
  return moved === undefined ? undefined : { ...moved, rule: 'head moved and patch id differs' }
}

async function statusOf($: $, state: State): Promise<string> {
  const { all, listed } = await agentsOf($, state)
  // a listed lead shows its own status, completed or killed included; one the list dropped shows as ended
  const listedIds = new Set(listed.map(a => a.id))
  const dir = await rootOf($, state)
  const now = await $.clock.now()
  const crews: CrewStatus[] = []
  const plan = await safely($, 'plan lines', () => planOf($, state))
  const since = runStart(plan) ?? 0
  for (const lead of all.filter(isLead)) {
    const crew = crewName(lead)
    const counts: Record<string, number> = {}
    const stalled: { label: string; minutes: number }[] = []
    const members: NonNullable<CrewStatus['members']> = []
    for (const a of listed) {
      if (crewOf(a.id, all)?.leadId !== lead.id) continue
      const last = state.activity.get(a.id)
      if (state.stalled.has(a.id) && a.status === 'running' && last !== undefined) stalled.push({ label: labelOf(a), minutes: Math.floor((now - last) / 60_000) })
      if (a.id === lead.id || !LIVE.has(a.status)) continue
      const m = family(state.models.get(a.id))
      counts[m] = (counts[m] ?? 0) + 1
      // an agent the mod never saw spawn counts from the first time it was seen
      const since = state.started.get(a.id) ?? now
      state.started.set(a.id, since)
      members.push({ label: labelOf(a), status: a.status, runningMs: now - since, model: m, lastActiveMs: last })
    }
    const reports = dir === undefined ? undefined : reportDir(dir, crew)
    const lastReportMs = reports === undefined ? undefined : await lastModified($, reports)
    const judge = reports === undefined ? undefined : await safely($, 'judge verdict', async () => {
      const latest = latestJudge(crew.toLowerCase(), await judgeFilesOf($, reports, crew, since, false), since)
      return latest === undefined ? undefined : judgeRuling(String(await $.fs.read(latest.path))).verdict
    })
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
      members,
    })
  }
  const log = dir === undefined ? undefined : messagesPath(dir)
  const text = statusText(crews, now, log !== undefined && (await $.fs.exists(log)) ? log : undefined, dir)
  // the plan's crews go above the 0.2.1 lines; with no readable plan the output is exactly 0.2.1's
  return plan === undefined ? text : [...planLines(plan), text].join('\n')
}

// Whether the lead's report on disk, written in its current stint, is final or tagged. It is what a reloaded mod has
// in place of `finals` and `waiting`. A report it cannot read excuses the lead: a missed prompt beats a wrong one,
// and the next pass reads again.
async function excusedOnDisk($: $, state: State, lead: Agent, crew: Crew): Promise<boolean> {
  const excused = await safely($, 'idle lead report', async () => {
    const dir = await rootOf($, state)
    if (dir === undefined) return false
    const path = reportPath(dir, crew.crew, state.labels.get(lead.id) ?? labelOf(lead))
    if (!(await $.fs.exists(path))) return false
    const stint = state.stints.get(lead.id)
    if (stint !== undefined && (await $.fs.stat(path)).mtimeMs < stint) return false
    const text = String(await $.fs.read(path))
    return isFinalReport(text) || tagOf(text) !== undefined
  })
  return excused !== false
}

// A lead a pass saw go from running to stopped, now `idle` (a normal end of turn: never waiting, killed, failed or
// completed), with nothing of its crew at work, no waiting tag and no final report in its current stint, is prompted
// for once per idle period, STALL_MS into it. Activity alone doesn't start a stint, so a sign-off after a final
// hand-back doesn't undo it; a resume does. The heartbeat has no task list, so a member's background work counts
// through the member's own entry in the agent list.
async function idleLeadCheck($: $, state: State, lead: Agent, crew: Crew, all: readonly Agent[], now: number) {
  const final = state.finals.get(lead.id)
  const stint = state.stints.get(lead.id)
  const excused =
    !state.stopped.has(lead.id) ||
    lead.status !== 'idle' ||
    state.waiting.has(lead.id) ||
    (final !== undefined && (stint === undefined || final >= stint)) ||
    isInterimStop(descendantsOf(lead.id, all), undefined) ||
    (await excusedOnDisk($, state, lead, crew))
  if (excused) {
    state.idleSince.delete(lead.id)
    state.idlePrompted.delete(lead.id)
    return
  }
  const since = state.idleSince.get(lead.id) ?? now
  state.idleSince.set(lead.id, since)
  if (state.idlePrompted.has(lead.id) || now - since < STALL_MS) return
  // flagged before any await, so an overlapping check never prompts twice
  state.idlePrompted.add(lead.id)
  let next = nextCrew(crew.crew)
  try {
    next = successorCrew(await planWithin($, state, PLAN_READ_MS), crew.crew)
  } catch {
    // fails open: any error reading the plan gives the 0.2.1 name
  }
  const minutes = Math.floor((now - since) / 60_000)
  const text = idleLeadText(labelOf(lead), crew.crew, minutes, next)
  // queued, not awaited: the wake never waits on the event log
  void logEvent($, state, { event: 'stall', crew: crew.crew, agent: labelOf(lead), kind: 'idle-lead', minutes })
  await safely($, 'idle lead wake', () => $.prompt.submit({ text }))
}

// One pass of the heartbeat: every running crew agent idle STALL_MS or more is reported once, with a toast and a
// prompt to the main session, and every idle lead goes through idleLeadCheck. An agent with nothing on record
// counts as active from now, and so does one that is running again after a pass that saw it stopped or unlisted.
async function stallCheck($: $, state: State) {
  const now = await $.clock.now()
  const { all, listed } = await agentsOf($, state)
  const before = state.lastPass
  state.lastPass = new Map(listed.map(a => [a.id, a.status]))
  for (const a of listed) {
    if (!state.started.has(a.id)) state.started.set(a.id, now)
    const crew = crewOf(a.id, all)
    if (crew === undefined) continue
    // a listed agent that is idle, waiting or done is never stalled; a lead may be idle with its report lost
    if (a.status !== 'running') {
      if (crew.isLead) {
        if (before?.get(a.id) === 'running') state.stopped.add(a.id)
        await idleLeadCheck($, state, a, crew, all, now)
      }
      continue
    }
    // running: any idle period of a lead is over
    state.idleSince.delete(a.id)
    state.idlePrompted.delete(a.id)
    state.stopped.delete(a.id)
    // resumed: a resumed agent may spend minutes compacting before its first tool call, so its clock starts now, and
    // a new stint begins
    if (before !== undefined && before.get(a.id) !== 'running') {
      state.activity.set(a.id, now)
      state.stints.set(a.id, now)
      state.stalled.delete(a.id)
      continue
    }
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
    // queued, not awaited: the wake never waits on the event log
    void logEvent($, state, { event: 'stall', crew: crew.crew, agent: label, kind: 'agent', minutes })
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
async function fireReset($: $, state: State, wakes: Wakes, resetsAt: string) {
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
  // the main session already ran after the reset (Claude Code continues it on its own): the wake would only repeat
  // that. Checked after the claim, so the reset stays marked fired and never wakes later.
  if (state.mainActive !== undefined && state.mainActive > Date.parse(resetsAt)) return
  await $.prompt.submit({ text: limitResetText(resetsAt) })
}

async function scheduleReset($: $, state: State, wakes: Wakes, resetsAt: string) {
  const due = Date.parse(resetsAt)
  if (Number.isNaN(due)) return
  const now = await $.clock.now()
  wakes.reset?.timer.cancel()
  const timer = $.clock.after(Math.max(0, due + RESET_GRACE_MS - now), () => {
    void safely($, 'limit reset wake', () => fireReset($, state, wakes, resetsAt))
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
  await scheduleReset($, state, wakes, resetsAt)
}

// session.start: a reload took the limit-reset timer with the old module, so arm it again from $.state
async function rearmReset($: $, state: State, wakes: Wakes) {
  const held = await $.state.get(LIMIT_RESET_REF)
  if (held.value !== undefined && !held.value.fired) await scheduleReset($, state, wakes, held.value.resetsAt)
}

async function resetFromUsage($: $, state: State, wakes: Wakes) {
  const resetsAt = (await $.session.usage()).rateLimits.find(l => l.kind === 'five_hour' && l.percentUsed >= 100 && typeof l.resetsAt === 'string')?.resetsAt
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
    planArchitects: new Map(),
    planRoute: Promise.resolve(),
    pendingPlanCalls: new Map(),
    handBacks: new Map(),
    withheld: new Set(),
    waiting: new Map(),
    activity: new Map(),
    stalled: new Set(),
    streaks: new Map(),
    started: new Map(),
    idleSince: new Map(),
    idlePrompted: new Set(),
    finals: new Map(),
    stints: new Map(),
    stopped: new Set(),
    events: Promise.resolve(),
    eventsPending: 0,
  }
  const wakes: Wakes = { checking: false, fired: new Set(), work: Promise.resolve() }
  // appends to the messages log, one at a time
  let appending: Promise<unknown> = Promise.resolve()

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    state.known.clear()
    state.labels.clear()
    state.models.clear()
    state.handedBack.clear()
    state.planArchitects.clear()
    state.pendingPlanCalls.clear()
    state.handBacks.clear()
    state.withheld.clear()
    state.waiting.clear()
    state.activity.clear()
    state.stalled.clear()
    state.streaks.clear()
    state.started.clear()
    state.lastPass = undefined
    state.idleSince.clear()
    state.idlePrompted.clear()
    state.finals.clear()
    state.stints.clear()
    state.stopped.clear()
    state.root = undefined
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    // a plan-mode architect's spawn is bound by its Agent call's tool_use_id, never by order (ADR-0015 s9)
    const call = (e as unknown as { tool_use_id?: unknown }).tool_use_id
    const mode = typeof call === 'string' ? state.pendingPlanCalls.get(call) : undefined
    if (id !== undefined && typeof call === 'string' && mode !== undefined) {
      state.pendingPlanCalls.delete(call)
      state.planArchitects.set(id, mode)
    }
    if (id !== undefined) {
      const label = e.name !== undefined && e.name !== '' ? e.name : id
      state.labels.set(id, label)
      state.known.set(id, { id, type: e.subagentType, status: 'running', description: e.description, name: e.name, parentId: e.parentAgentId, label, live: true, seq: state.seq++ })
      state.models.set(id, started.model)
      // a start is activity, and where the running time /foundry shows begins
      await safely($, 'spawn time', async () => {
        const at = await $.clock.now()
        state.started.set(id, at)
        touch(state, id, at)
      })
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
      // only a lead may message main from inside a crew; its crew is as the verdict above just listed it, and a
      // lead goes by its crew's name
      const lead = tag === undefined ? undefined : crewOf(sender, [...state.known.values()])
      if (tag !== undefined && lead?.isLead === true) await logEvent($, state, { event: 'tag', crew: lead.crew, agent: lead.leadName, tag: tagName(tag) })
    }
    if (decided.crossCrew) {
      const entry = { from: decided.fromCrew, to: decided.toCrew, summary: typeof input.summary === 'string' ? input.summary : '' }
      // same shape as logEvent: the chain stays serial and is never released on a timer, so a late write can't clobber
      // a newer line; the call waits at most EVENT_WAIT_MS for it, and the line still lands later if the fs answers
      appending = appending.then(() => safely($, 'message log', () => appendMessage($, state, entry)))
      await settledWithin($, EVENT_WAIT_MS, appending, () => {
        try {
          $.ui.log(`foundry: message log failed, letting the call through: no answer in ${EVENT_WAIT_MS}ms`, { to: 'debug' })
        } catch {
          // nothing left to do
        }
      })
    }
    return result
  }).catch(failOpen)

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // ADR-0004 s7: on a v>=2 plan, the main session's foundry:* calls set a model and an effort, before the plan gates
    const type: unknown = e.subagent_type
    if (e.agentId === undefined && typeof type === 'string' && type.startsWith('foundry:')) {
      const refused = await safely($, 'main-session rule', async () => {
        const verdict = mainCallVerdict(await planWithin($, state, PLAN_READ_MS), e.agentId, type, e.model, e.effort)
        if (verdict !== undefined) await logRule($, `main-session rule refused a ${type} call: ${verdict.deny === MAIN_MODEL_REFUSAL ? 'no model' : 'no allowed effort'}`)
        return verdict
      })
      if (refused !== undefined) return refused
    }
    const caller = await safely($, 'Agent check', async () => {
      if (e.agentId === undefined) return undefined
      const all = (await agentsOf($, state)).all
      const self = all.find(a => a.id === e.agentId)
      return {
        crew: crewOf(e.agentId, all),
        label: self === undefined ? e.agentId : labelOf(self),
        refused: agentVerdict(e.agentId, e.model, all) ?? effortVerdict(e.agentId, e.effort, all),
      }
    })
    if (caller?.refused !== undefined) return caller.refused
    // ADR-0004 s5: a judge-named call from inside a crew whose repair budget is spent
    const callerCrew = caller?.crew?.crew
    if (callerCrew !== undefined && isJudgeName(callerCrew.toLowerCase(), typeof e.name === 'string' ? e.name.toLowerCase() : e.name)) {
      const spent = await safely($, 'repair budget gate', () => budgetGate($, state, callerCrew, e.name))
      if (spent !== undefined) return spent
    }
    const startsLead = e.agentId === undefined && e.subagent_type === LEAD_TYPE
    // the plan gates (ADR-0001 s9): only the main thread starting a named lead; any failure lets the call through
    const gated = !startsLead || typeof e.name !== 'string' || e.name === '' ? undefined : e.name
    if (gated !== undefined) {
      const refused = await safely($, 'plan gate', async () => {
        const plan = await planOf($, state)
        return plan === undefined ? undefined : planVerdict(plan, gated)
      })
      if (refused !== undefined) return refused
    }
    // a plan-mode architect from the main session (ADR-0015 s9): its hand-back is the plan to write. Marked before the
    // call runs, since a foreground agent spawns and hands back inside it; agent.spawn binds the id by this tool_use_id.
    const first = e.agentId === undefined && e.subagent_type === 'foundry:architect' && typeof e.prompt === 'string' ? e.prompt.split('\n')[0].replace(/[\r ]+$/, '') : undefined
    const planCall: 'plan' | 'amend' | undefined = first === 'Mode: plan' ? 'plan' : first === 'Mode: amend' ? 'amend' : undefined
    const callId = (e as unknown as { tool_use_id?: unknown }).tool_use_id
    const pending = planCall !== undefined && typeof callId === 'string' && callId !== '' ? callId : undefined
    if (pending !== undefined && planCall !== undefined) state.pendingPlanCalls.set(pending, planCall)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      if (pending !== undefined) state.pendingPlanCalls.delete(pending)
    }
    if (result.deny !== undefined) return result
    const raw = (result.result as { agentId?: unknown } | undefined)?.agentId
    const id = typeof raw === 'string' ? raw : undefined
    if (planCall !== undefined && id !== undefined) state.planArchitects.set(id, planCall)
    if (caller?.crew === undefined && !startsLead) return result
    // the name agent.spawn recorded, which the report file will carry
    const name = (id === undefined ? undefined : state.labels.get(id)) ?? (typeof e.name === 'string' && e.name !== '' ? e.name : id)
    const note = await safely($, 'report note', async () => {
      const dir = await rootOf($, state)
      if (dir === undefined || id === undefined || name === undefined) return undefined
      return reportNote(name, reportPath(dir, caller?.crew?.crew ?? name, name))
    })
    const agent = name ?? 'unknown'
    await logEvent($, state, {
      event: 'spawn',
      crew: caller?.crew?.crew ?? agent,
      agent,
      agentId: id ?? null,
      type: typeof e.subagent_type === 'string' && e.subagent_type !== '' ? e.subagent_type : 'general-purpose',
      model: typeof e.model === 'string' ? e.model : null,
      effort: typeof e.effort === 'string' ? e.effort : null,
      by: caller?.label ?? MAIN,
    })
    return note === undefined ? result : withNote(result, note)
  }).catch(failOpen)

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    // ADR-0009 s6: on a v>=2 plan, the main session's Workflow calls run foundry agents only from the plugin's scripts
    if (e.agentId === undefined) {
      const refused = await safely($, 'Workflow gate', async () => {
        const plan = await planWithin($, state, PLAN_READ_MS)
        if (!planAtLeastV2(plan)) return undefined
        const readText = async (path: unknown): Promise<string | undefined> => {
          if (typeof path !== 'string') return undefined
          try {
            const text = String(await $.fs.read(path))
            return text === '' ? undefined : text
          } catch {
            return undefined
          }
        }
        const pluginDir = pluginDirOf()
        const texts = pluginDir === undefined ? [undefined, undefined] : await Promise.all([`${pluginDir}/workflows/plan.js`, `${pluginDir}/workflows/wave.js`].map(readText))
        const script: unknown = e.script
        const scriptPath: unknown = e.scriptPath
        const verdict = workflowCallVerdict(plan, {
          script,
          scriptPath,
          scriptText: typeof script === 'string' ? script : await readText(scriptPath),
          args: e.args,
          pluginDir: pluginDir ?? ' ',
          pluginScriptTexts: texts, // positional: [plan.js text, wave.js text]
        })
        if (verdict !== undefined) await logRule($, `Workflow gate refused a call: ${verdict.deny}`)
        return verdict
      })
      if (refused !== undefined) return refused
    }
    return next(e)
  }).catch(failOpen)

  // Every tool call is activity, the main session's included. A report sent through the hand-back tool is the agent's
  // real report; its last message may be only a sign-off. One with nothing in it, from inside a crew, is sent back.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      noteMainActivity($, state)
      return next(e)
    }
    const id = e.agentId
    noteActivity($, state, id)
    if ((e.tool as string) !== 'SubagentHandback') return next(e)
    const raw = (e as unknown as { message?: unknown }).message
    const message = typeof raw === 'string' ? raw : ''
    // outside every crew, or with the agent list down, an empty hand-back goes through
    if (isEmptyHandBack(message)) {
      const inCrew = await safely($, 'hand-back check', async () => crewOf(id, (await agentsOf($, state)).all) !== undefined)
      if (inCrew === true) return { deny: HANDBACK_REFUSAL }
    }
    if (message.trim() !== '') {
      // a real report is marked before any await, so a stop that races this capture never overwrites it
      state.handedBack.add(id)
      state.handBacks.set(id, message)
      state.withheld.delete(id)
      await safely($, 'hand-back capture', async () => {
        const all = (await agentsOf($, state)).all
        const crew = crewOf(id, all)
        if (crew === undefined) return
        // a lead's report the stop gate will send back is not its report: the stop that goes through writes it
        if (crew.isLead && !leadStopPasses(message)) return
        // on a v>=2 plan, one the Examined check will send back is not its report either (ADR-0004 s6); no git here
        if (crew.isLead && !isTagged(message)) {
          const held = await safely($, 'examined check', async () => examinedVerdict(await planWithin($, state, PLAN_READ_MS), message))
          if (held !== undefined) {
            state.withheld.add(id)
            await logRule($, `examined check held back the hand-back of the lead of crew ${crew.crew}: headings missing`)
            return
          }
        }
        await writeReport($, state, crew, id, message)
      })
    }
    const passed = await next(e)
    // the plan-file route runs only for a hand-back that went through, not denied and not an error
    const route = state.planArchitects.get(id)
    if (passed.deny === undefined && !(passed as { isError?: unknown }).isError && route === 'plan') {
      await safely($, 'plan-file route', () => writePlanFiles($, state, message))
    } else if (passed.deny === undefined && !(passed as { isError?: unknown }).isError && route === 'amend') {
      await safely($, 'plan-amend route', () => writeAmendFiles($, state, message))
    }
    return passed
  }).catch(failOpen)

  // every model request is activity, the main session's included; the stream passes untouched
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) noteActivity($, state, e.agentId)
    else noteMainActivity($, state)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    // turn.step streams, so its catch is a generator: log as failOpen does, then let the stream go on
    failOpen($, e, next)
    return yield* next(e)
  })

  // The decision log's times come from the clock: a `- HH:MM |` the foreman typed on a new line is replaced with the
  // real local time before the write lands. Lines the log already holds keep theirs, unless still a literal HH:MM.
  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const stamped = await safely($, 'decision time', async () => {
      if (!isDecisionLog(e.file_path, await $.session.id())) return undefined
      const text = e.tool === 'Write' ? e.content : e.new_string
      // what the call replaces: an Edit's old_string, a Write's file on disk
      const logged = e.tool === 'Edit' ? e.old_string : (await $.fs.exists(e.file_path)) ? String(await $.fs.read(e.file_path)) : ''
      const out = stampDecisions(text, logged, localTime(await $.clock.now()))
      return out === text ? undefined : out
    })
    if (stamped === undefined) return next(e)
    return e.tool === 'Write' ? next({ ...e, content: stamped }) : next({ ...e, new_string: stamped })
  }).catch(failOpen)

  // The fetch gate (ADR-0005 s11): allows every call and logs one line when the session has a plan. The caller and the
  // plan check each wait at most EVENT_WAIT_MS and count as "main" and "no plan" when they fail or overrun.
  on('tool.call', { tool: ['WebFetch', 'WebSearch'] }, async ($, e, next) => {
    const input = e as unknown as { url?: unknown; query?: unknown }
    const caller = await safely($, 'fetch caller', () =>
      within($, EVENT_WAIT_MS, async () => {
        if (e.agentId === undefined) return { crew: 'main', agent: 'main' }
        const all = (await agentsOf($, state)).all
        const self = all.find(a => a.id === e.agentId)
        return { crew: crewOf(e.agentId, all)?.crew ?? 'main', agent: self === undefined ? e.agentId : labelOf(self) }
      }),
    )
    const hasPlan =
      (await safely($, 'fetch plan check', () =>
        within($, EVENT_WAIT_MS, async () => {
          const dir = await rootOf($, state)
          return dir !== undefined && (await $.fs.exists(planPath(dir)))
        }),
      )) === true
    const verdict = fetchVerdict(e.tool as 'WebFetch' | 'WebSearch', input, caller?.crew ?? 'main', caller?.agent ?? e.agentId ?? 'main', hasPlan)
    if (verdict.line !== null) await logEvent($, state, verdict.line)
    if (verdict.kind === 'deny') return { deny: verdict.reason }
    return next(e)
  }).catch(failOpen)

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
      if (count >= LEAD_STOP_BLOCKS) {
        state.streaks.delete(id)
        return { lead: true, interim: false }
      }
      if (leadStopPasses(text)) {
        // ADR-0004 s4 and s6 on a v>=2 plan; these send-backs share the streak, and an unanswered tag doesn't excuse them
        const sent = await safely($, 'final report gate', () => finalReportVerdict($, state, id, text))
        if (sent === undefined) {
          state.streaks.delete(id)
          return { lead: true, interim: false }
        }
        state.streaks.set(id, count + 1)
        await logRule($, `lead stop gate sent back the lead of crew ${crewOf(id, [...state.known.values()])?.crew ?? id}: ${sent.rule}`)
        return { lead: true, interim: false, block: sent.block }
      }
      // a lead whose tagged message to main is unanswered has asked through that one channel: its stop goes through
      // as interim, so it neither needs a tagged hand-back too nor loses the tag /foundry shows
      if (state.waiting.has(id)) {
        state.streaks.delete(id)
        return { lead: true, interim: true }
      }
      state.streaks.set(id, count + 1)
      return { lead: true, interim: false, block: LEAD_STOP_REASON }
    })
    const handBack = state.handBacks.get(id)
    state.handBacks.delete(id)
    const withheld = state.withheld.delete(id)
    if (gate?.block !== undefined) {
      // the hand-back belonged to the stop sent back; the next one is judged and captured afresh
      state.handedBack.delete(id)
      return { ...result, block: gate.block }
    }
    const tags = gate?.interim !== true
    // the hand-back already holds this stop's report; the agent's next stop is captured again
    if (state.handedBack.delete(id)) {
      // a lead's hand-back the gate could have sent back was held; this stop went through, so it is the report. One
      // the Examined check held is written even when the gate step failed (P5), by the agents last seen if the list fails
      if (handBack !== undefined && (withheld || (gate?.lead === true && !leadStopPasses(handBack)))) {
        await safely($, 'report capture', async () => {
          const all = (await safely($, 'agent list', async () => (await agentsOf($, state)).all)) ?? [...state.known.values()]
          const crew = crewOf(id, all)
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
    await queueLimit($, wakes, 'limit reset re-arm', () => rearmReset($, state, wakes))
    return started
  })

  on('command.run', { command: 'foundry' }, async ($, e) => {
    const text = await safely($, 'status', () => statusOf($, state))
    return { text: text ?? 'foundry could not read the crews; see the debug log.' }
  })
}
