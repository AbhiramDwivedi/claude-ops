import type { EngineInterface, Register, ToolCallResult, TurnStepChunk, TurnUsage } from 'claude-code'

// what the mod has seen of one subagent or in-process teammate
export type Budget = {
  // tokens its latest request carried: input plus cache reads and writes
  context: number
  // it has been asked to checkpoint
  isNudged: boolean
  // tool calls it has made since passing the stop limit
  windDownCalls: number
  // its tool calls are being refused
  isRefused: boolean
  // its previous request, to tell a cache that expired from a first request, a model switch or a compaction
  last?: Step
  // a cache drop it has not yet been told about
  pendingDrop?: Drop
  // it has been told about a cache drop, and the person has been shown one: each happens once per agent
  isCacheNoted: boolean
  isDropToasted: boolean
}

// what the mod keeps of one request: its turn, when its response arrived, the model that answered, how many
// messages it carried, and whether the response called tools (so the pause after it was the agent's own wait)
export type Step = { turnId: string; endedAt: number; model: string; messageCount: number; calledTools: boolean }

// the request being made now, as far as the drop rule reads it
export type Request = { turnId: string; startedAt: number; messageCount: number }

// a request that re-wrote most of a large context to the prompt cache after a long pause
export type Drop = { rebuilt: number; pauseMs: number }

export type Limits = { nudge: number; stop: number }

// what an agent's next tool call gets
export type Verdict =
  | { kind: 'run' }
  | { kind: 'nudge' }
  | { kind: 'wind-down'; left: number }
  | { kind: 'refuse' }

// tool calls an agent keeps after passing the stop limit, to commit and write its handoff note
export const WIND_DOWN_CALLS = 8
// marks text this mod wrote
export const MARK = '[subagent-limits]'
// a brief that already carries the contract (a successor's, copied from its predecessor) gets no second copy;
// one that merely quotes a note still gets it
export const CONTRACT_HEAD = `${MARK} Context budget.`

export const CONTRACT = `${CONTRACT_HEAD} Every request you make re-sends your whole context, so keep it small.
- Read files by line range (grep -n first, then read only the lines you need), not whole.
- Keep command and test output short. Send long output to a file and read only the summary lines.
- Stay inside the scope above. If the job is bigger than the brief suggests, say so in your report rather than expanding it.
- Run the narrowest command that proves your change, and don't wait in sleep loops: a long pause between your requests lets the prompt cache expire, and your next request pays to rebuild your whole context.
If you are asked to checkpoint, finish or back out the change in progress, commit if you work in git, and write a handoff note. The note says what is done and verified, what is left as a numbered list naming files and functions, any traps you found, and exactly which files and line ranges the next agent should read first. Put the note where your brief says, or in your final report if the brief names no place. Start your final report with "CHECKPOINT:" so whoever started you knows the work is unfinished.`

// 955492 -> 955K, 1200000 -> 1.2M
export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

// a configured number, or the default when unset or not a number, held within bounds
export function setting(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

// the stop limit always leaves room above the nudge to finish an item and checkpoint
export function limitsFrom(options: { nudgeAtK?: unknown; stopAtK?: unknown }): Limits {
  const nudge = setting(options.nudgeAtK, 300, 50, 10_000) * 1000
  const stop = Math.max(setting(options.stopAtK, 450, 50, 10_000) * 1000, nudge + 50_000)
  return { nudge, stop }
}

export function fresh(): Budget {
  return { context: 0, isNudged: false, windDownCalls: 0, isRefused: false, isCacheNoted: false, isDropToasted: false }
}

// A cache drop worth mentioning. A subagent's prompt cache lives 5 minutes unless the person set it longer, so a
// pause under 4 minutes (measured from the previous response, a little after the cache was last used) cannot have
// expired it; a rebuild under 100K costs too little to talk about; and a request that wrote less than half its
// context had most of it served from the cache.
export const DROP = { minContext: 100_000, minShare: 0.5, minPauseMs: 4 * 60_000 }

// The drop this request shows, if any. Only a pause the agent spent waiting on its own tool call, in the same run,
// counts: an agent resumed after it finished did not choose its pause. Not an agent's first request, not one
// after a model switch (a new model has no cache), and not one after a compaction (fewer messages, a new prefix).
export function cacheDrop(last: Step | undefined, request: Request, usage: TurnUsage): Drop | undefined {
  if (last === undefined || !last.calledTools || last.turnId !== request.turnId) return undefined
  if (usage.model !== last.model || request.messageCount < last.messageCount) return undefined
  const context = contextOf(usage)
  const rebuilt = usage.cache_creation_input_tokens
  const pauseMs = request.startedAt - last.endedAt
  if (context < DROP.minContext || rebuilt < context * DROP.minShare || pauseMs <= DROP.minPauseMs) return undefined
  return { rebuilt, pauseMs }
}

// tokens a request carried: input plus cache reads and writes
export function contextOf(usage: TurnUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

export function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}

export function cacheNote(drop: Drop): string {
  return `${MARK} Your last request rebuilt ${tokens(drop.rebuilt)} tokens of context because the prompt cache expired during a ${minutes(drop.pauseMs)}-minute pause. If you need to wait on a long job again, check on it before it runs that long, or run something shorter.`
}

export function dropToast(name: string, drop: Drop): string {
  return `${name} rebuilt ${tokens(drop.rebuilt)} of context: its prompt cache expired during a ${minutes(drop.pauseMs)}-minute pause`
}

// past the stop limit an agent keeps a few calls to checkpoint, then everything is refused;
// below it, the first call past the nudge limit carries the request to checkpoint
export function verdict(budget: Budget, limits: Limits): Verdict {
  if (budget.context >= limits.stop) {
    const left = WIND_DOWN_CALLS - budget.windDownCalls
    return left > 0 ? { kind: 'wind-down', left: left - 1 } : { kind: 'refuse' }
  }
  if (budget.context >= limits.nudge && !budget.isNudged) return { kind: 'nudge' }
  return { kind: 'run' }
}

export function nudgeNote(context: number, limits: Limits): string {
  return `${MARK} Your context has reached ${tokens(context)} tokens. Finish the item you are on, or back it out if it is far from done, then checkpoint: commit, write your handoff note, and end with a final report that starts with "CHECKPOINT:". A fresh agent will continue from your note. At ${tokens(limits.stop)} your tools start being refused.`
}

export function windDownNote(context: number, left: number, limits: Limits): string {
  const budget =
    left > 0 ? `You have ${left} tool calls left before every tool is refused.` : 'That was your last tool call.'
  return `${MARK} Your context is ${tokens(context)} tokens, past the ${tokens(limits.stop)} limit. ${budget} Use what is left only to commit and write your handoff note, then end with a final report that starts with "CHECKPOINT:".`
}

export function refusal(context: number, limits: Limits): string {
  return `${MARK} Refused: your context (${tokens(context)} tokens) is past the ${tokens(limits.stop)} limit. End now with a final report that starts with "CHECKPOINT:" and says what is done and what is left. Resuming this agent will not help; a fresh agent should continue from your report.`
}

// the main agent decides the split; this tells it what the mod enforces and how to work with it
export function planningRules(limits: Limits): string {
  return `# Sizing delegated work
The subagent-limits plugin is installed. You decide how work is split; the plugin only measures each subagent's context and enforces two limits. When you hand work to subagents:
- Give each agent one phase it can finish well under ${tokens(limits.nudge)} tokens of context. At ${tokens(limits.nudge)} the plugin asks the agent to checkpoint, and at ${tokens(limits.stop)} it starts refusing the agent's tools.
- Run agents in parallel only when they edit different files. When they would share files, run a relay instead: one fresh agent per phase, each starting from the previous one's handoff note.
- Fresh agents often read 100K tokens or more before their first edit. Cut that with a brief that names the exact files, functions and line ranges to read, the test command, and what done means.
- Set \`model\` on every Agent call.
- A final report that starts with "CHECKPOINT:" means the agent stopped on purpose with work left. Start a fresh agent from its handoff note rather than resuming the old one.
For brief and handoff templates, load the subagent-limits:split-work skill.`
}

export function withContract(prompt: string): string {
  return prompt.includes(CONTRACT_HEAD) ? prompt : `${prompt}\n\n${CONTRACT}`
}

export function agentLabel(id: string, description: string | undefined): string {
  return description !== undefined && description !== '' ? description : `Agent ${id.slice(0, 8)}`
}

// the call's result with a note the model reads after it; a refusal stays as it is
function withNote(result: ToolCallResult, note: string): ToolCallResult {
  if (result.deny !== undefined) return result
  return { ...result, context: [...(result.context ?? []), note] }
}

async function label($: EngineInterface, id: string): Promise<string> {
  const agent = (await $.agent.list()).find(a => a.id === id)
  return agentLabel(id, agent?.description)
}

export const register: Register = (on, options) => {
  const limits = limitsFrom(options)
  // off: an agent whose cache expired is not told; the person still gets the toast
  const cacheNotes = options.cacheNotes !== false
  // module state: a reload starts these over, so a nudge may repeat once after one
  const budgets = new Map<string, Budget>()
  // forks inherit the parent's context and its prompt cache: never limited
  const forks = new Set<string>()

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    budgets.clear()
    forks.clear()
    return next(e)
  })

  // only a model that can start agents needs the planning rules
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent') || e.traits.includes('bare')) return composed
    const rules = { id: 'subagent-limits:planning', text: planningRules(limits), scope: 'session' } as const
    return { sections: [...composed.sections, rules] }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.fork) {
      const started = await next(e)
      if (started.agentId !== undefined) forks.add(started.agentId)
      return started
    }
    return next({ ...e, prompt: withContract(e.prompt) })
  })

  // every model request of a subagent or an in-process teammate; the main thread is never limited
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined || forks.has(id)) return yield* next(e)
    const startedAt = await $.clock.now()
    const budget = budgets.get(id) ?? fresh()
    budgets.set(id, budget)
    // The engine starts a tool as soon as its call has streamed, before the response ends, and the request's
    // size arrives only with the response's stop. So the response's chunks from its first tool call on are held
    // until the stop has set the budget: otherwise every call of a request is judged by the request before it,
    // and an agent whose context jumps past both limits in one request, then finishes, is never nudged.
    const stream = next(e)
    let held: TurnStepChunk[] = []
    for await (const chunk of stream) {
      if (chunk.kind === 'stop') {
        if (chunk.usage !== null) budget.context = contextOf(chunk.usage)
        yield* held
        held = []
        yield chunk
      } else if (held.length > 0 || chunk.kind === 'tool') {
        held.push(chunk)
      } else {
        yield chunk
      }
    }
    // a stream that ended without a stop still hands on what it held
    yield* held
    const result = await stream.result
    if (result.usage === null) return result
    const usage = result.usage
    const drop = cacheDrop(budget.last, { turnId: e.turnId, startedAt, messageCount: e.messageCount }, usage)
    budget.context = contextOf(usage)
    budget.last = {
      turnId: e.turnId,
      endedAt: await $.clock.now(),
      model: usage.model,
      messageCount: e.messageCount,
      calledTools: result.toolUses.length > 0,
    }
    if (drop !== undefined) {
      if (cacheNotes && !budget.isCacheNoted) budget.pendingDrop = drop
      if (!budget.isDropToasted) {
        budget.isDropToasted = true
        $.ui.toast(dropToast(await label($, id), drop))
      }
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    const budget = id === undefined ? undefined : budgets.get(id)
    if (id === undefined || budget === undefined) return next(e)
    // taken before any await, so of calls made in parallel only the first carries it
    const drop = budget.pendingDrop
    if (drop !== undefined) {
      budget.pendingDrop = undefined
      budget.isCacheNoted = true
    }
    // the tool's result, with the cache note when one is due
    const ran = async () => {
      const result = await next(e)
      return drop === undefined ? result : withNote(result, cacheNote(drop))
    }
    const decided = verdict(budget, limits)
    switch (decided.kind) {
      case 'run':
        return ran()
      case 'nudge': {
        budget.isNudged = true
        $.ui.toast(`Asked ${await label($, id)} to checkpoint at ${tokens(budget.context)} of context`)
        return withNote(await ran(), nudgeNote(budget.context, limits))
      }
      case 'wind-down': {
        // counted before any await, so calls made in parallel each see the ones before them
        budget.windDownCalls += 1
        if (budget.windDownCalls === 1) {
          $.ui.toast(`${await label($, id)} passed ${tokens(limits.stop)}: ${WIND_DOWN_CALLS} tool calls left to checkpoint`)
        }
        return withNote(await ran(), windDownNote(budget.context, decided.left, limits))
      }
      case 'refuse': {
        if (!budget.isRefused) {
          budget.isRefused = true
          $.ui.toast(`Refusing tools for ${await label($, id)} at ${tokens(budget.context)} of context`)
        }
        return { deny: refusal(budget.context, limits) }
      }
    }
  })
}
