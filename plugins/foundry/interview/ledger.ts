// The owner interview's two files, read as data (ADR-0008 Seams 1-5): the branches the interview skill asks,
// and the requirements ledger it writes. Pure functions over text and a state object; no I/O.
// Erasable TypeScript only, Node standard library only (P19).

// the packs a branch can belong to; `core` is always a candidate
export const PACKS = ['core', 'service', 'frontend', 'data', 'ai', 'infra', 'library'] as const

const VISITS = ['standard', 'large', 'opened']
const WRITES = ['functional', 'nfr', 'constraint', 'non-goal']
const FIELDS = ['Pack', 'Visit', 'Fact', 'Ask', 'Recommend', 'Writes', 'Opens']
const REQUIRED = ['Pack', 'Visit', 'Ask', 'Recommend', 'Writes']
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type Branch = {
  id: string
  pack: string
  visit: string[]
  fact?: string
  ask: string
  recommend: string
  writes: string
  opens: string[]
}

export type Size = 'small' | 'standard' | 'large'

export type InterviewState = {
  goal: string
  size: Size
  packs: string[]
  opened: string[]
  requirements: string[]
  visits: Record<string, { by?: string; note?: string }>
  stopped: boolean
}

export type Requirement = {
  id: string
  n: number
  title: string
  status: string
  kind: string
  added: string
  source: string
  examples: string[]
  measure?: string
}

export type Ledger = { requirements: Requirement[]; nonGoals: string[]; errors: string[] }

const list = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

// ---------- branches ----------

export const parseBranches = (md: string): Branch[] => {
  const text = md.replace(/^﻿/, '').replace(/\r/g, '')
  const sections: { id: string; lines: string[] }[] = []
  for (const line of text.split('\n')) {
    const h = /^## (.*)$/.exec(line)
    if (h) sections.push({ id: h[1].trim(), lines: [] })
    else if (sections.length > 0) sections[sections.length - 1].lines.push(line)
  }
  const out: Branch[] = []
  const seen = new Set<string>()
  for (const s of sections) {
    const { id } = s
    if (!ID_RE.test(id)) throw new Error(`branch ${id}: id must match ${ID_RE.source}`)
    if (seen.has(id)) throw new Error(`branch ${id}: duplicate id`)
    seen.add(id)
    const f: Record<string, string> = {}
    for (const line of s.lines) {
      if (line.trim() === '') continue
      const m = /^([A-Za-z]+):\s?(.*)$/.exec(line)
      if (!m || !FIELDS.includes(m[1])) throw new Error(`branch ${id}: unknown field line: ${line}`)
      if (m[1] in f) throw new Error(`branch ${id}: duplicate field ${m[1]}`)
      f[m[1]] = m[2].trim()
    }
    for (const k of REQUIRED) if (f[k] === undefined || f[k] === '') throw new Error(`branch ${id}: missing ${k}`)
    if (!(PACKS as readonly string[]).includes(f.Pack)) throw new Error(`branch ${id}: bad Pack: ${f.Pack}`)
    const visit = list(f.Visit)
    if (visit.length === 0 || visit.some((v) => !VISITS.includes(v))) throw new Error(`branch ${id}: bad Visit: ${f.Visit}`)
    if (!WRITES.includes(f.Writes)) throw new Error(`branch ${id}: bad Writes: ${f.Writes}`)
    const b: Branch = { id, pack: f.Pack, visit, ask: f.Ask, recommend: f.Recommend, writes: f.Writes, opens: list(f.Opens ?? '') }
    if (f.Fact !== undefined && f.Fact !== '') b.fact = f.Fact
    out.push(b)
  }
  for (const b of out) {
    for (const o of b.opens) if (!seen.has(o)) throw new Error(`branch ${b.id}: Opens names unknown branch ${o}`)
  }
  return out
}

const isCandidate = (b: Branch, state: InterviewState): boolean => {
  if (Object.hasOwn(state.visits, b.id)) return false
  if (state.opened.includes(b.id)) return true
  // ADR-0008 s5: "the size is in its Visit", read literally (a standard-only branch is not asked at large)
  return b.visit.includes(state.size) && (b.pack === 'core' || state.packs.includes(b.pack))
}

// every branch still to ask, in file order, whatever `stopped` says and with no cap
export const remainingBranches = (branches: Branch[], state: InterviewState): Branch[] =>
  branches.filter((b) => isCandidate(b, state))

// the next batch: up to `max` candidates, ending at the first one that has Opens (its answer can change the queue)
export const nextBranches = (branches: Branch[], state: InterviewState, max: number): Branch[] => {
  if (!(max >= 1)) throw new RangeError(`max must be at least 1, got ${max}`)
  if (state.size === 'small' || state.stopped) return []
  const out: Branch[] = []
  for (const b of remainingBranches(branches, state)) {
    out.push(b)
    if (out.length >= max || b.opens.length > 0) break
  }
  return out
}

// ---------- requirements ----------

const KINDS = ['functional', 'nfr', 'constraint']
const REQ_FIELDS = ['Status', 'Kind', 'Added', 'Source', 'Example', 'Measure']
const ADDED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) \| \S.*$/
const REPLACED_RE = /^replaced by R-(\d+)$/

type Draft = { req: Requirement; f: Record<string, string> }

export const parseRequirements = (md: string): Ledger => {
  const lines = md.replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  const errors: string[] = []
  const drafts: Draft[] = []
  const nonGoals: string[] = []
  const ids = new Set<number>()
  let top = 0
  let sawNonGoals = false
  let mode: 'pre' | 'req' | 'goals' | 'skip' = 'pre'
  let cur: Draft | undefined
  lines.forEach((line, i) => {
    const at = i + 1
    const unexpected = () => errors.push(`line ${at}: unexpected: ${line}`)
    const h = /^## (.*)$/.exec(line)
    if (h) {
      const r = /^R-(\d+): (.+)$/.exec(h[1])
      if (r) {
        const n = Number(r[1])
        const id = `R-${n}`
        if (ids.has(n)) errors.push(`${id}: duplicate id`)
        else if (n < top) errors.push(`${id}: id out of order`)
        ids.add(n)
        top = Math.max(top, n)
        cur = { req: { id, n, title: r[2].trim(), status: '', kind: '', added: '', source: '', examples: [] }, f: {} }
        drafts.push(cur)
        mode = 'req'
      } else if (h[1] === 'Non-goals') {
        sawNonGoals = true
        cur = undefined
        mode = 'goals'
      } else {
        unexpected()
        cur = undefined
        mode = 'skip'
      }
      return
    }
    if (line.trim() === '' || mode === 'pre' || mode === 'skip') return
    if (mode === 'goals') {
      if (line.startsWith('- ') && line.slice(2).trim() !== '') nonGoals.push(line.slice(2).trim())
      else unexpected()
      return
    }
    const m = /^([A-Za-z]+): ?(.*)$/.exec(line)
    if (!cur || !m || !REQ_FIELDS.includes(m[1])) return unexpected()
    const [, key, value] = m
    if (key === 'Example') cur.req.examples.push(value.trim())
    else if (key in cur.f) unexpected()
    else cur.f[key] = value.trim()
  })

  for (const { req, f } of drafts) {
    const e = (msg: string) => errors.push(`${req.id}: ${msg}`)
    for (const k of ['Status', 'Kind', 'Added', 'Source']) if (f[k] === undefined) e(`missing ${k}`)
    req.status = f.Status ?? ''
    req.kind = f.Kind ?? ''
    req.added = f.Added ?? ''
    req.source = f.Source ?? ''
    if (f.Measure !== undefined) req.measure = f.Measure
    if (f.Status !== undefined) {
      const rep = REPLACED_RE.exec(f.Status)
      if (rep) {
        const k = Number(rep[1])
        if (!(k > req.n && ids.has(k))) e(`replaced by unknown R-${k}`)
      } else if (!['open', 'met', 'dropped'].includes(f.Status)) e(`bad Status: ${f.Status}`)
    }
    if (f.Kind !== undefined && !KINDS.includes(f.Kind)) e(`bad Kind: ${f.Kind}`)
    if (f.Added !== undefined && !ADDED_RE.test(f.Added)) e(`bad Added: ${f.Added}`)
    if (f.Source !== undefined && !/^(?:owner|default|goal|repo:\S.*)$/.test(f.Source)) e(`bad Source: ${f.Source}`)
    if (f.Kind === 'functional' && req.examples.length === 0) e('functional needs an Example')
    if (f.Kind === 'nfr' && !/\d/.test(f.Measure ?? '')) e('nfr needs a Measure with a number')
  }
  if (!sawNonGoals) errors.push('missing ## Non-goals')
  return { requirements: drafts.map((d) => d.req), nonGoals, errors }
}

// the `- R-<n>: <title>` lines of a goal file's ## Requirements section, in file order
export const goalRequirementLines = (text: string): { id: string; title: string }[] => {
  const out: { id: string; title: string }[] = []
  let inside = false
  for (const line of text.replace(/^﻿/, '').replace(/\r/g, '').split('\n')) {
    if (line.startsWith('## ')) {
      inside = line.trim() === '## Requirements'
      continue
    }
    if (!inside) continue
    const m = /^- (R-\d+): (.*)$/.exec(line)
    if (m) out.push({ id: m[1], title: m[2] })
  }
  return out
}

// TRACE lines for the goal files against the ledger and this run's ids; [] when all is well
export const checkTrace = (ledger: Ledger, runIds: string[], goals: { name: string; text: string }[]): string[] => {
  const byId = new Map(ledger.requirements.map((r) => [r.id, r]))
  const out: string[] = []
  const covered = new Set<string>()
  for (const g of [...goals].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    for (const { id, title } of goalRequirementLines(g.text)) {
      covered.add(id)
      const r = byId.get(id)
      if (!r) out.push(`TRACE: unknown ${id} in ${g.name}`)
      else if (r.title !== title) out.push(`TRACE: text differs ${id} in ${g.name}`)
      else if (r.status !== 'open') out.push(`TRACE: not open ${id} in ${g.name}`)
    }
  }
  for (const id of runIds) {
    if (!byId.has(id)) out.push(`TRACE: run id not in ledger ${id}`)
    else if (!covered.has(id)) out.push(`TRACE: uncovered ${id}`)
  }
  return out
}
