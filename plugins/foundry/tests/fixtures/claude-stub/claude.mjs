// Stand-in for the claude binary, for tests/evals-run-model.check.ts. Plain Node ESM, node: built-ins only.
// Spawn it as `node claude.mjs <claude args>`: run-model does that when CLAUDE ends in .js, .mjs or .cjs.
// Reads stdin, prints a canned reply (or CLAUDE_STUB_REPLY), and when CLAUDE_STUB_LOG names a directory writes
// <n>.json there for each call, holding { argv, stdin, cwd }. Exits 0.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let stdin = ''
try {
  stdin = readFileSync(0, 'utf8')
} catch {
  stdin = ''
}

const logDir = process.env.CLAUDE_STUB_LOG
if (logDir) {
  const n = readdirSync(logDir).filter((f) => /^\d+\.json$/.test(f)).length + 1
  writeFileSync(join(logDir, `${n}.json`), JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }))
}

const reply = process.env.CLAUDE_STUB_REPLY ?? 'VERDICT: PASS\n\n## Proof checked\nstub\n'
process.stdout.write(reply)
process.exit(0)
