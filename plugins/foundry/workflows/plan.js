export const meta = {
  name: 'foundry-plan',
  description: 'Runs the foundry architect in plan mode, has a cynic review its verdicts, and runs one reconcile round when the cynic disagrees.',
}

// ADR-0009 Decision 3. Every agent() call goes through spawn(); the roles table comes from args.foundry.roles.
const F = args.foundry
const BAD_TYPES = ['foundry:lead', 'foundry:devops', 'foundry:integrator']

function spawn(role, label, prompt, opts) {
  const r = F.roles && F.roles[role]
  if (!r) throw new Error(`role ${role} is missing from the roles table`)
  if (r.model !== 'opus' && r.model !== 'sonnet') throw new Error(`role ${role}: model must be opus or sonnet`)
  if (r.effort !== 'low' && r.effort !== 'medium') throw new Error(`role ${role}: effort must be low or medium`)
  if (typeof r.agentType !== 'string' || !r.agentType || BAD_TYPES.includes(r.agentType)) throw new Error(`role ${role}: agentType ${r.agentType} is not allowed`)
  const o = { ...(opts || {}), label, agentType: r.agentType, model: r.model, effort: r.effort }
  if (r.isolation === 'worktree') o.isolation = 'worktree'
  return agent(prompt, o)
}

const SCHEMA = {
  type: 'object',
  properties: { report: { type: 'string' }, planJson: { type: 'string' }, planMd: { type: 'string' } },
  required: ['report', 'planJson', 'planMd'],
}
const linesOf = (text, re) => String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => re.test(l))

function architectPrompt(extra) {
  return [
    'Mode: plan',
    '',
    args.brief,
    '',
    'Return the plan blocks in two places: put the plan JSON in `planJson` and the plan markdown in `planMd`, and also fence both in `report`.',
    ...(extra ? ['', extra] : []),
  ].join('\n')
}

function cynicPrompt(a, reconciled) {
  return [
    'Your job: the verdict review of the foreman skill\'s section 4 ("Have a cynic review the verdicts"). Review the architect\'s extend/change verdicts in this plan against the architecture doc and the code.',
    reconciled ? 'A reconcile round has happened: the architect saw your earlier review and revised the plan. Review the revised plan below.' : '',
    '',
    `Architecture doc: ${F.architecture}`,
    '',
    'planJson:',
    a.planJson,
    '',
    'planMd:',
    a.planMd,
    '',
    'For each module give one `REVIEW: agree` or `REVIEW: disagree` line, and the owner triggers that hold as `Owner:` lines (`Owner: none` when no trigger holds).',
  ].join('\n')
}

const fix = F.fix === true
let architectLabel = fix ? 'foundry-architect-3' : 'foundry-architect'
let cynicLabel = fix ? 'foundry-cynic-3' : 'foundry-cynic'

phase('Plan')
let a = await spawn('architect', architectLabel, architectPrompt(), { schema: SCHEMA })
if (!a || typeof a.planJson !== 'string') throw new Error(`${architectLabel} returned no plan`)

const uncovered = linesOf(a.report, /^UNCOVERED:/)
if (uncovered.length) return { uncovered }

phase('Review')
const owner = []
const addOwner = (text) => {
  for (const l of linesOf(text, /^Owner:/)) if (!/^Owner:\s*none\b/i.test(l) && !owner.includes(l)) owner.push(l)
}
let review = await spawn('cynic', cynicLabel, cynicPrompt(a, false))
if (review == null) throw new Error(`${cynicLabel} returned nothing`)
addOwner(review)
let reviews = linesOf(review, /^REVIEW:/)
const disagrees = () => reviews.some((l) => /^REVIEW:\s*disagree\b/i.test(l))

if (!fix && disagrees()) {
  phase('Reconcile')
  architectLabel = 'foundry-architect-2'
  a = await spawn('architect', architectLabel, architectPrompt(`The cynic reviewed your plan and disagrees. Its lines:\n${String(review)}\n\nReconcile: revise the plan, or say why a verdict stands.`), { schema: SCHEMA })
  if (!a || typeof a.planJson !== 'string') throw new Error(`${architectLabel} returned no plan`)
  cynicLabel = 'foundry-cynic-2'
  review = await spawn('cynic', cynicLabel, cynicPrompt(a, true))
  if (review == null) throw new Error(`${cynicLabel} returned nothing`)
  addOwner(review)
  reviews = linesOf(review, /^REVIEW:/)
}

return { architectLabel, reviews, owner, stillDisagree: disagrees() }
