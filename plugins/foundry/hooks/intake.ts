// Mid-run intake (ADR-0010): the goal a crew belongs to, the goal text /foundry prints, and the pure merge of an
// amend-mode architect's hand-back into plan.json. Imports nothing from register.ts.

export const RUN_GOAL = 'run'

const SLUG = /^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A crew's goal: its `goal` when that is a string, else the run goal. A crew with `goal: "run"` and one with no `goal`
// are the same goal everywhere.
export function goalOf(crew: unknown): string {
  return isRecord(crew) && typeof crew.goal === 'string' ? crew.goal : RUN_GOAL
}

// A goal's text as /foundry prints it: whitespace runs collapsed, cut to 99 characters plus an ellipsis when longer than 100.
export function goalLine(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 100 ? `${one.slice(0, 99)}…` : one
}

// Merge an amend-mode hand-back into an approved plan: add a goal, or replace a still-unapproved one whose crews are all
// planned. Touches nothing else (ADR-0010 s2). `reason` is what the route logs when it writes nothing.
export function amendPlan(existing: unknown, amend: unknown, now: string): { plan: Record<string, unknown>; id: string } | { reason: string } {
  const refuse = (reason: string) => ({ reason })
  if (!isRecord(existing) || !Array.isArray(existing.crews) || typeof existing.approvedAt !== 'string') {
    return refuse(`the plan isn't approved; give the goal to the plan architect instead`)
  }
  const version = existing.version
  if (typeof version !== 'number' || version < 2) {
    const shown = typeof version === 'number' ? String(version) : version === undefined ? 'missing' : JSON.stringify(version)
    return refuse(`the plan is version ${shown}; re-plan it in plan mode before adding a goal`)
  }
  if (!isRecord(amend)) return refuse('the amend block is not an object')
  const goal = amend.goal
  if (!isRecord(goal)) return refuse('the amend has no goal object')
  const id = goal.id
  if (typeof id !== 'string' || !SLUG.test(id)) return refuse('goal.id is not a slug')
  if (id === RUN_GOAL) return refuse('goal.id run is reserved for the run')
  if (typeof goal.goal !== 'string' || goal.goal.trim() === '') return refuse('goal.goal is not a non-empty string')
  const approval = goal.approval
  if (approval !== 'auto' && approval !== 'owner') return refuse('goal.approval is neither auto nor owner')
  const crews = amend.crews
  if (!Array.isArray(crews) || crews.length === 0) return refuse('crews is not a non-empty array')
  const old = existing.crews
  const goals = Array.isArray(existing.goals) ? existing.goals : []
  const mine = (c: unknown) => goalOf(c) === id
  const seen = new Set<string>()
  for (const c of crews) {
    if (!isRecord(c)) return refuse('a crew is not an object')
    if (typeof c.slug !== 'string' || !SLUG.test(c.slug)) return refuse('a crew slug is not a slug')
    if (seen.has(c.slug)) return refuse(`crew slug ${c.slug} repeats`)
    seen.add(c.slug)
    if (old.some(o => isRecord(o) && o.slug === c.slug && !mine(o))) return refuse(`crew slug ${c.slug} is already a crew of another goal`)
  }
  const at = goals.findIndex(g => isRecord(g) && g.id === id)
  const entry = at < 0 ? undefined : (goals[at] as Record<string, unknown>)
  if (entry !== undefined) {
    if (entry.approvedAt !== null && entry.approvedAt !== undefined) return refuse(`goal ${id} is approved`)
    if (old.some(o => mine(o) && isRecord(o) && o.status !== 'planned')) return refuse(`goal ${id} has started crews`)
  }
  const fresh = crews.map(c => ({ ...(c as Record<string, unknown>), goal: id, status: 'planned' }))
  let nextGoals: unknown[]
  let nextCrews: unknown[]
  if (entry === undefined) {
    nextGoals = [...goals, { id, goal: goal.goal, addedAt: now, approval, approvedAt: null }]
    nextCrews = [...old, ...fresh]
  } else {
    // replace: the goal keeps its addedAt and its place in the queue; its new crews go where its first old crew was
    nextGoals = goals.map((g, i) => (i === at ? { ...entry, goal: goal.goal, approval } : g))
    const first = old.findIndex(mine)
    const kept = old.filter(o => !mine(o))
    const index = first < 0 ? kept.length : first
    nextCrews = [...kept.slice(0, index), ...fresh, ...kept.slice(index)]
  }
  return { plan: { ...existing, version: 3, goals: nextGoals, crews: nextCrews }, id }
}
