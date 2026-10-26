import { expect } from 'claude-code/testing'
import { test } from './harness'

import {
  type Agent,
  agentVerdict,
  ago,
  crewOf,
  family,
  foundryDir,
  LEAD_TYPE,
  messageVerdict,
  MODEL_REFUSAL,
  questionOf,
  recipientsOf,
  reportPath,
  safeName,
  statusText,
} from '../hooks/register'

const agent = (id: string, type: string, name?: string, parentId?: string): Agent => ({ id, type, name, parentId, status: 'running', description: id })

// two crews, a member two levels down, a plain agent with a child, and a lead that some other agent started
const AGENTS: Agent[] = [
  agent('L1', LEAD_TYPE, 'auth'),
  agent('L2', LEAD_TYPE, 'billing'),
  agent('A1', 'kit:builder', 'auth-builder', 'L1'),
  agent('A2', 'Explore', 'auth-scout', 'A1'),
  agent('B1', 'general-purpose', 'billing-builder', 'L2'),
  agent('X', 'general-purpose', 'helper'),
  agent('Y', 'Explore', 'helper-scout', 'X'),
  agent('N', LEAD_TYPE, 'nested-lead', 'X'),
]

test('resolves an agent to its crew through any depth of parents', async () => {
  expect(crewOf('L1', AGENTS)).toEqual({ crew: 'auth', leadId: 'L1', leadName: 'auth', isLead: true })
  expect(crewOf('A1', AGENTS)).toEqual({ crew: 'auth', leadId: 'L1', leadName: 'auth', isLead: false })
  expect(crewOf('A2', AGENTS)?.crew).toBe('auth')
  expect(crewOf('B1', AGENTS)?.crew).toBe('billing')
})

test('puts no crew on the main thread, plain agents, unknown ids or a lead another agent started', async () => {
  expect(crewOf(undefined, AGENTS)).toBeUndefined()
  expect(crewOf('X', AGENTS)).toBeUndefined()
  expect(crewOf('Y', AGENTS)).toBeUndefined()
  expect(crewOf('N', AGENTS)).toBeUndefined()
  expect(crewOf('gone', AGENTS)).toBeUndefined()
  // a parent loop never hangs the walk
  expect(crewOf('C1', [agent('C1', 'x', 'a', 'C2'), agent('C2', 'x', 'b', 'C1')])).toBeUndefined()
})

test('names a crew by its lead, or by the lead id when it has no name', async () => {
  expect(crewOf('M', [agent('L', LEAD_TYPE), agent('M', 'x', 'm', 'L')])?.crew).toBe('L')
})

test('keeps reports in the git common dir, or under the home folder outside git', async () => {
  expect(foundryDir('C:/r/.git', 'C:\\Users\\me', 's1')).toBe('C:/r/.git/foundry/s1')
  expect(foundryDir(undefined, 'C:\\Users\\me\\', 's1')).toBe('C:/Users/me/.claude/foundry/s1')
  expect(foundryDir('', '/home/me', 's1')).toBe('/home/me/.claude/foundry/s1')
  expect(foundryDir(undefined, undefined, 's1')).toBeUndefined()
  expect(reportPath('C:/r/.git/foundry/s1', 'auth', 'auth-builder')).toBe('C:/r/.git/foundry/s1/reports/auth/auth-builder.md')
})

test('makes every path segment safe', async () => {
  expect(safeName('auth/../builder')).toBe('auth-builder')
  expect(safeName('my crew: one')).toBe('my-crew-one')
  expect(safeName('..')).toBe('agent')
})

test('finds a recipient by id, or by name with a listing ref dropped', async () => {
  expect(recipientsOf('billing', AGENTS).map(a => a.id)).toEqual(['L2'])
  expect(recipientsOf('billing [ref 2]', AGENTS).map(a => a.id)).toEqual(['L2'])
  expect(recipientsOf('B1', AGENTS).map(a => a.id)).toEqual(['B1'])
  expect(recipientsOf('nobody', AGENTS)).toEqual([])
})

test('resolves a name to its live agents first, else to the newest one seen', async () => {
  const ended = (a: Agent, seq: number): Agent => ({ ...a, live: false, seq })
  // a lead restarted under its old name: the live one wins over the older, ended one
  const restarted = [ended(agent('L1', LEAD_TYPE, 'auth'), 1), { ...agent('L9', LEAD_TYPE, 'auth'), live: true, seq: 9 }]
  expect(recipientsOf('auth', restarted).map(a => a.id)).toEqual(['L9'])
  // none live: the newest seen
  const both = [ended(agent('W1', 'x', 'worker', 'L1'), 2), ended(agent('W2', 'x', 'worker', 'L2'), 5)]
  expect(recipientsOf('worker', both).map(a => a.id)).toEqual(['W2'])
})

test('never lets an ended namesake carry a message into another crew', async () => {
  // crew auth's worker has ended; crew billing has a live one of the same name
  const agents = [...AGENTS, { ...agent('W1', 'x', 'worker', 'L1'), live: false, seq: 1 }, { ...agent('W2', 'x', 'worker', 'L2'), live: true, seq: 2 }]
  expect(messageVerdict('A1', 'worker', agents).kind).toBe('deny')
  expect(messageVerdict('B1', 'worker', agents)).toEqual({ kind: 'allow', crossCrew: false })
})

test('refuses a name two live agents in different crews share', async () => {
  const agents = [...AGENTS, agent('W1', 'x', 'worker', 'L1'), agent('W2', 'x', 'worker', 'L2')]
  const verdict = messageVerdict('A1', 'worker', agents)
  expect(verdict.kind === 'deny' && verdict.reason).toContain('more than one live agent is named "worker"')
  // the id still reaches one exactly
  expect(messageVerdict('A1', 'W1', agents)).toEqual({ kind: 'allow', crossCrew: false })
})

test('lets members message their lead and siblings, and leads message main and their members', async () => {
  expect(messageVerdict('A2', 'auth', AGENTS)).toEqual({ kind: 'allow', crossCrew: false })
  expect(messageVerdict('A1', 'auth-scout', AGENTS)).toEqual({ kind: 'allow', crossCrew: false })
  expect(messageVerdict('L1', 'A2', AGENTS)).toEqual({ kind: 'allow', crossCrew: false })
  expect(messageVerdict('L1', 'main', AGENTS)).toEqual({ kind: 'allow', crossCrew: false })
  expect(messageVerdict('L2', 'main [ref]', AGENTS)).toEqual({ kind: 'allow', crossCrew: false })
})

test('refuses a member messaging main, and any crew agent messaging an address nobody has', async () => {
  const toMain = messageVerdict('A2', 'main', AGENTS)
  expect(toMain.kind === 'deny' && toMain.reason).toContain('your lead, auth')
  expect(messageVerdict('A1', 'main [ref]', AGENTS).kind).toBe('deny')
  // no crew-prefix guess: an unknown name is refused, even one that looks like the crew's
  expect(messageVerdict('L1', 'auth-tester', AGENTS).kind).toBe('deny')
  expect(messageVerdict('A1', 'auth-tester', AGENTS).kind).toBe('deny')
})

test('lets one lead message another, as a cross-crew message', async () => {
  expect(messageVerdict('L1', 'billing', AGENTS)).toEqual({ kind: 'allow', crossCrew: true, fromCrew: 'auth', toCrew: 'billing' })
})

test('refuses a member messaging another crew, and a lead messaging another crew\'s member', async () => {
  const member = messageVerdict('A1', 'billing', AGENTS)
  expect(member.kind).toBe('deny')
  expect(member.kind === 'deny' && member.reason).toContain('tell your lead, auth')
  expect(messageVerdict('A2', 'billing-builder', AGENTS).kind).toBe('deny')
  const lead = messageVerdict('L1', 'billing-builder', AGENTS)
  expect(lead.kind === 'deny' && lead.reason).toContain("that crew's lead, billing")
  // outside every crew, or not an agent name at all
  expect(messageVerdict('A1', 'helper', AGENTS).kind).toBe('deny')
  expect(messageVerdict('L1', 'stranger', AGENTS).kind).toBe('deny')
  expect(messageVerdict('A1', { sessionId: 'other' }, AGENTS).kind).toBe('deny')
})

test('leaves the main thread and agents outside every crew alone', async () => {
  expect(messageVerdict(undefined, 'billing-builder', AGENTS)).toEqual({ kind: 'pass' })
  expect(messageVerdict('X', 'auth-builder', AGENTS)).toEqual({ kind: 'pass' })
  expect(messageVerdict('N', 'billing', AGENTS)).toEqual({ kind: 'pass' })
})

test('refuses an Agent call without a model only inside a crew', async () => {
  expect(agentVerdict('L1', undefined, AGENTS)).toEqual({ deny: MODEL_REFUSAL })
  expect(agentVerdict('A2', '', AGENTS)).toEqual({ deny: MODEL_REFUSAL })
  expect(agentVerdict('L1', 'sonnet', AGENTS)).toBeUndefined()
  expect(agentVerdict(undefined, undefined, AGENTS)).toBeUndefined()
  expect(agentVerdict('X', undefined, AGENTS)).toBeUndefined()
})

test('shows each crew with its live members by model and its last report', async () => {
  const now = 10 * 3_600_000
  const text = statusText(
    [
      { crew: 'auth', status: 'running', live: { sonnet: 2, opus: 1 }, lastReportMs: now - 5 * 60_000, dir: 'C:/r/.git/foundry/s1/reports/auth' },
      { crew: 'billing', status: 'ended', live: {}, dir: 'C:/r/.git/foundry/s1/reports/billing' },
    ],
    now,
    'C:/r/.git/foundry/s1/messages.jsonl',
  )
  expect(text).toContain('- auth: running, 3 live members (opus 1, sonnet 2), last report 5m ago')
  expect(text).toContain('  reports: C:/r/.git/foundry/s1/reports/auth')
  expect(text).toContain('- billing: ended, no live members, no report yet')
  expect(text).toContain('Messages between leads: C:/r/.git/foundry/s1/messages.jsonl')
  expect(statusText([], now)).toContain('/foundry:run')
  const asking = statusText([{ crew: 'auth', status: 'idle', live: {}, lastReportMs: now, question: 'Keep the v1 endpoint?' }], now)
  expect(asking).toContain('- auth: idle, no live members, waiting on you: Keep the v1 endpoint?')
})

test('reads a lead question only when the text starts with QUESTION:', async () => {
  expect(questionOf('QUESTION: Keep the v1 endpoint?\nOptions: a or b')).toBe('Keep the v1 endpoint?')
  expect(questionOf('  QUESTION: why')).toBe('why')
  expect(questionOf('## Summary\nQUESTION: no')).toBeUndefined()
})

test('counts models by family and formats ages', async () => {
  expect(family('claude-sonnet-4-6')).toBe('sonnet')
  expect(family('claude-opus-5-5')).toBe('opus')
  expect(family(undefined)).toBe('unknown')
  expect(ago(95_000)).toBe('2m ago')
  expect(ago(3 * 3_600_000)).toBe('3h ago')
})
