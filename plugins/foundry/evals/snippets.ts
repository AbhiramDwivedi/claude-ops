// foundry ADR-0007 section 5: pull the listed shell snippets out of the shipped prompts and run them in a temp git repo.
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

export type Where = 'root' | 'subdir' | 'worktree'
export type SnippetLine = { file: string; opening: string; form: 'fenced' | 'inline'; fills: Record<string, string> }
export type RunResult = { ok: boolean; code: number | null; stdout: string; stderr: string }

const LINE = /^- (plugins\/foundry\/\S+\.md): `([^`]+)` \((fenced|inline); placeholders: (.+)\)$/
const PAIR = /^(<[a-z][a-z0-9-]*>)=(\S+)$/

export function parseSnippets(adrText: string): SnippetLine[] {
  const out: SnippetLine[] = []
  let inSection = false
  for (const line of adrText.replace(/\r/g, '').split('\n')) {
    if (!inSection) {
      if (/^## Snippets\s*$/.test(line)) inSection = true
      continue
    }
    if (line.startsWith('## ')) break
    if (!line.startsWith('- ')) continue
    const m = LINE.exec(line)
    if (!m) throw new Error(`bad snippet line: ${line}`)
    const fills: Record<string, string> = {}
    if (m[4] !== 'none') {
      for (const pair of m[4].split(', ')) {
        const p = PAIR.exec(pair)
        if (!p) throw new Error(`bad placeholder pair "${pair}" in snippet line: ${line}`)
        fills[p[1]] = p[2]
      }
    }
    out.push({ file: m[1], opening: m[2], form: m[3] as 'fenced' | 'inline', fills })
  }
  return out
}

export function extractSnippet(promptPath: string, line: SnippetLine): string | undefined {
  let text: string
  try {
    text = fs.readFileSync(promptPath, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  const isFence = (l: string) => l.trimStart().startsWith('```')
  if (line.form === 'fenced') {
    for (let i = 0; i < lines.length; i++) {
      if (!isFence(lines[i])) continue
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !isFence(lines[j])) body.push(lines[j++])
      if (body.length > 0 && body[0].trimStart().startsWith(line.opening)) return body.join('\n')
      i = j
    }
    return undefined
  }
  let fenced = false
  for (const l of lines) {
    if (isFence(l)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const m of l.matchAll(/`[^`\n]+`/g)) {
      const span = m[0].slice(1, -1)
      if (span.startsWith(line.opening)) return span
    }
  }
  return undefined
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v
  return env
}

export function runSnippet(script: string, fills: Readonly<Record<string, string>>, where: Where = 'root'): RunResult {
  let filled = script
  for (const [k, v] of Object.entries(fills)) filled = filled.split(k).join(v)
  const left = /<[a-z][a-z0-9-]*>/.exec(filled)
  if (left) return { ok: false, code: null, stdout: '', stderr: `unfilled placeholder ${left[0]}\n` }

  const env = cleanEnv()
  const tmp = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'foundry-snippet-')))
  try {
    const repo = join(tmp, 'repo')
    fs.mkdirSync(join(repo, 'sub'), { recursive: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe', windowsHide: true })
    git('init', '-q')
    git('config', 'user.name', 'eval')
    git('config', 'user.email', 'eval@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.autocrlf', 'false')
    fs.writeFileSync(join(repo, 'a.txt'), 'one\n')
    fs.writeFileSync(join(repo, 'sub', 'b.txt'), 'b\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'one')
    fs.writeFileSync(join(repo, 'a.txt'), 'two\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'two')
    let cwd = repo
    if (where === 'subdir') cwd = join(repo, 'sub')
    else if (where === 'worktree') {
      const wt = join(tmp, 'wt')
      git('worktree', 'add', '-q', wt, '-b', 'eval-wt')
      cwd = wt
    }
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${filled}`], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    })
    return {
      ok: r.status === 0,
      code: r.status,
      stdout: (r.stdout ?? '').replace(/\r/g, ''),
      stderr: (r.stderr ?? '').replace(/\r/g, ''),
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 })
  }
}
