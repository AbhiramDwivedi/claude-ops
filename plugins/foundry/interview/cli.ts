// The owner interview's command line (ADR-0008 Seam 5): next, remaining, check and trace over the branches file,
// the interview state file and the requirements ledger. `main` returns the text and exit code; running the file
// prints the text and sets the code. Erasable TypeScript only, Node standard library only (P19).
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTrace, nextBranches, parseBranches, parseRequirements, remainingBranches } from './ledger.ts'
import type { Branch, InterviewState } from './ledger.ts'

// argument counts after the command name
export const COMMANDS = {
  next: { min: 2, max: 3 },
  remaining: { min: 2, max: 2 },
  check: { min: 1, max: 1 },
  trace: { min: 3, max: 3 },
}

export type Result = { code: number; out: string }

// a failure that exits 2: usage, unreadable file, bad state file, branches parse error
class Fatal extends Error {}

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    throw new Fatal(`cannot read ${path} (${(e as { code?: string }).code ?? 'error'})`)
  }
}

const loadState = (path: string): InterviewState => {
  let s: Record<string, unknown>
  try {
    s = JSON.parse(read(path))
  } catch (e) {
    if (e instanceof Fatal) throw e
    throw new Fatal(`bad state file ${path}: not JSON`)
  }
  const bad = (why: string) => new Fatal(`bad state file ${path}: ${why}`)
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw bad('not an object')
  if (typeof s.goal !== 'string') throw bad('goal must be a string')
  if (s.size !== 'small' && s.size !== 'standard' && s.size !== 'large') throw bad('size must be small, standard or large')
  for (const k of ['packs', 'opened', 'requirements']) if (!Array.isArray(s[k])) throw bad(`${k} must be an array`)
  if (s.visits === null || typeof s.visits !== 'object' || Array.isArray(s.visits)) throw bad('visits must be an object')
  if (typeof s.stopped !== 'boolean') throw bad('stopped must be a boolean')
  return s as unknown as InterviewState
}

const loadBranches = (path: string): Branch[] => {
  try {
    return parseBranches(read(path))
  } catch (e) {
    if (e instanceof Fatal) throw e
    throw new Fatal(`bad branches file ${path}: ${(e as Error).message}`)
  }
}

const nextLines = (bs: Branch[]): string[] =>
  bs.length === 0 ? ['NEXT: none'] : bs.map((b) => `NEXT: ${b.id} | ${b.pack} | ${b.ask} | ${b.recommend} | opens: ${b.opens.length ? b.opens.join(', ') : 'none'}`)

const run = (cmd: string, args: string[]): { code: number; lines: string[] } => {
  if (cmd === 'next') {
    const max = args[2] === undefined ? 3 : Number(args[2])
    if (!Number.isInteger(max) || max < 1) throw new Fatal(`max must be a whole number of at least 1: ${args[2]}`)
    const bs = loadBranches(args[0])
    return { code: 0, lines: nextLines(nextBranches(bs, loadState(args[1]), max)) }
  }
  if (cmd === 'remaining') {
    const bs = loadBranches(args[0])
    return { code: 0, lines: nextLines(remainingBranches(bs, loadState(args[1]))) }
  }
  if (cmd === 'check') {
    const r = parseRequirements(read(args[0]))
    if (r.errors.length > 0) return { code: 1, lines: r.errors.map((e) => `ERROR: ${e}`) }
    return { code: 0, lines: [`OK: ${r.requirements.length} requirements, ${r.nonGoals.length} non-goals`] }
  }
  // trace
  const ledger = parseRequirements(read(args[0]))
  const state = loadState(args[1])
  let names: string[]
  try {
    names = readdirSync(args[2]).filter((n) => n.endsWith('.md')).sort()
  } catch (e) {
    throw new Fatal(`cannot read ${args[2]} (${(e as { code?: string }).code ?? 'error'})`)
  }
  const goals = names.map((n) => ({ name: n.slice(0, -3), text: read(join(args[2], n)) }))
  const found = checkTrace(ledger, state.requirements, goals)
  if (found.length > 0) return { code: 1, lines: found }
  return { code: 0, lines: [`OK: ${state.requirements.length} requirements traced to ${goals.length} goal files`] }
}

export const main = (argv: string[]): Result => {
  const [cmd, ...args] = argv
  try {
    if (cmd === undefined || !Object.hasOwn(COMMANDS, cmd)) {
      throw new Fatal(`USAGE: interview/cli.ts <${Object.keys(COMMANDS).join('|')}> <args>`)
    }
    const { min, max } = COMMANDS[cmd as keyof typeof COMMANDS]
    if (args.length < min || args.length > max) throw new Fatal(`USAGE: ${cmd} takes ${min === max ? min : `${min}-${max}`} arguments, got ${args.length}`)
    const r = run(cmd, args)
    return { code: r.code, out: `${r.lines.join('\n')}\n` }
  } catch (e) {
    if (e instanceof Fatal || e instanceof RangeError) return { code: 2, out: `FAIL: ${(e as Error).message}\n` }
    throw e
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2))
  process.stdout.write(r.out)
  process.exitCode = r.code
}
