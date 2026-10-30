// foundry ADR-0007 section 4: the deterministic scorer. No I/O.
import { judgeRuling } from '../hooks/register.ts'

export type Expected =
  | { keyword: 'VERDICT'; kind: 'PASS' | 'FAIL' }
  | { keyword: 'RECOMMEND'; kind: 'answer' | 'defer' | 'pass' }
export type Kind = Expected['kind']
export type Score = { ok: boolean; got: Kind | undefined }

const RECOMMEND = /^\s*(?:cynic-\d+:?\s+)?RECOMMEND:?\s+(answer|defer|pass)\b/

export function score(report: string, expected: Expected): Score {
  const e = expected as { keyword?: unknown; kind?: unknown } | null
  const valid =
    e !== null &&
    typeof e === 'object' &&
    ((e.keyword === 'VERDICT' && (e.kind === 'PASS' || e.kind === 'FAIL')) ||
      (e.keyword === 'RECOMMEND' && (e.kind === 'answer' || e.kind === 'defer' || e.kind === 'pass')))
  if (!valid) throw new TypeError(`bad expected: ${JSON.stringify(expected)}`)
  let got: Kind | undefined
  if (expected.keyword === 'VERDICT') {
    got = judgeRuling(report).verdict
  } else {
    for (const line of report.replace(/\r/g, '').split('\n')) {
      const m = RECOMMEND.exec(line)
      if (m) {
        got = m[1] as Kind
        break
      }
    }
  }
  return { ok: got === expected.kind, got }
}
