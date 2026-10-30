// End-to-end proof for repo ADR-0015: a foundry-shaped run (crew lead + two members, real merges, foreman
// fast-forward) leaves no worktree-agent branch, no agent folder and no `active` entry in slots.json.
// Everything git does is real git on a temp repo; the worktrees plugin runs unmodified against an adapter
// built from child_process and fs. Only ui.log, ui.toast and command.register are recorded in memory.
import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { META_FINISHED } from '../../plugins/worktrees/tests/fixtures/run3.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// retro.py lives in the Truss repo (https://github.com/AbhiramDwivedi/truss). Set TRUSS_RETRO to a checkout scripts/retro.py.
const RETRO = process.env.TRUSS_RETRO ?? ''
const RETRO_SKIP = RETRO && fs.existsSync(RETRO) ? false : 'set TRUSS_RETRO to the path of a truss checkout scripts/retro.py to run this test'
const REGISTER = '../../plugins/worktrees/hooks/register.ts'
const fwd = (p: string) => p.replace(/\\/g, '/')

const LEAD = 'a1lead'
const MEMBER_A = 'a2membera'
const MEMBER_B = 'a3memberb'
const SESSION = 'e2esession'

type ProcResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
type Init = { cwd?: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string }

// the environment every process gets: no GIT_* from the real one, an empty global config, no system config
function cleanEnv(sandbox: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v
  env.GIT_CONFIG_GLOBAL = path.join(sandbox, 'empty.gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.HOME = path.join(sandbox, 'home')
  env.USERPROFILE = path.join(sandbox, 'home')
  return { ...env, ...extra }
}

type Handler = ($: unknown, e: any, next: (e: unknown) => Promise<unknown>) => Promise<any>

function build() {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-e2e-')))
  const main = fwd(path.join(sandbox, 'repo'))
  const tdir = fwd(path.join(sandbox, 'transcripts'))
  const home = path.join(sandbox, 'home')
  fs.mkdirSync(main)
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(sandbox, 'empty.gitconfig'), '')

  const env = cleanEnv(sandbox)
  const g = (cwd: string, ...args: string[]): string => {
    assert.ok(fwd(cwd).startsWith(fwd(sandbox)), `refusing to run git outside the sandbox: ${cwd}`)
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true }).replace(/\r/g, '')
  }
  g(main, 'init', '-q', '-b', 'main')
  g(main, 'config', 'user.name', 'E2E')
  g(main, 'config', 'user.email', 'e2e@example.invalid')
  g(main, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(main, 'README.md'), 'root\n')
  fs.writeFileSync(path.join(main, '.gitignore'), '.claude/\n')
  g(main, 'add', '-A')
  g(main, 'commit', '-q', '-m', 'root')
  const common = fwd(g(main, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim())

  // ---- the engine: real process, fs and clock; recorded ui and command ----
  const handlers = new Map<string, { filter?: unknown; handler: Handler }[]>()
  const logs: string[] = []
  const toasts: string[] = []
  const commands: unknown[] = []
  let inflight = 0
  let timers = 0
  const track = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    inflight++
    try {
      return await fn()
    } finally {
      inflight--
    }
  }
  const inSandbox = (p: string) => {
    if (!fwd(path.resolve(p)).toLowerCase().startsWith(fwd(sandbox).toLowerCase())) throw new Error(`adapter: path outside the sandbox: ${p}`)
    return p
  }

  const run = (argv: string[], init: Init = {}): Promise<ProcResult> =>
    track(
      () =>
        new Promise<ProcResult>((resolve, reject) => {
          const cwd = inSandbox(init.cwd ?? main)
          const child = spawn(argv[0] as string, argv.slice(1), { cwd, env: cleanEnv(sandbox, init.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
          let stdout = ''
          let stderr = ''
          child.stdout.setEncoding('utf8').on('data', d => (stdout += d))
          child.stderr.setEncoding('utf8').on('data', d => (stderr += d))
          const timer = init.timeoutMs ? setTimeout(() => child.kill(), init.timeoutMs) : undefined
          child.on('error', e => {
            clearTimeout(timer)
            reject(e)
          })
          child.on('close', code => {
            clearTimeout(timer)
            resolve({ exitCode: code ?? -1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
          })
          child.stdin.on('error', () => undefined)
          child.stdin.end(init.stdin ?? '')
        }),
    )

  const $ = {
    process: { run },
    fs: {
      exists: (p: string) => track(() => fs.existsSync(inSandbox(p))),
      read: (p: string) => track(() => fs.readFileSync(inSandbox(p), 'utf8')),
      write: (p: string, text: string) => track(() => void fs.writeFileSync(inSandbox(p), text)),
      list: (p: string) =>
        track(() => fs.readdirSync(inSandbox(p), { withFileTypes: true }).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', isLink: d.isSymbolicLink() }))),
      stat: (p: string) => track(() => fs.statSync(inSandbox(p))),
    },
    clock: {
      now: () => track(() => Date.now()),
      sleep: (ms: number) => track(() => new Promise<void>(r => setTimeout(r, ms))),
      after: (ms: number, cb: () => unknown) => {
        timers++
        setTimeout(async () => {
          try {
            await cb()
          } finally {
            timers--
          }
        }, ms)
      },
    },
    env: {
      get: (name: string) =>
        track(() => {
          if (name === 'CLAUDE_PROJECT_DIR') return main
          if (name === 'OS') return process.env.OS
          if (name === 'HOME' || name === 'USERPROFILE') return home
          return undefined
        }),
    },
    session: { cwd: () => track(() => main) },
    ui: {
      log: (text: string) => track(() => void logs.push(text)),
      toast: (text: string) => track(() => void toasts.push(text)),
    },
    command: { register: (def: unknown) => void commands.push(def) },
  }

  const on = (event: string, a: unknown, b?: Handler): Promise<void> => {
    const [filter, handler] = b === undefined ? [undefined, a as Handler] : [a, b]
    handlers.set(event, [...(handlers.get(event) ?? []), { filter, handler }])
    return Promise.resolve()
  }
  const fire = async (event: string, input: Record<string, unknown>) => {
    const hs = handlers.get(event)
    assert.ok(hs && hs.length > 0, `no handler registered for ${event}`)
    return track(() => hs[0]!.handler($, input, async () => ({})))
  }
  // resolves once no `$` call and no timer is pending, across several event-loop turns
  const settle = async () => {
    for (let quiet = 0; quiet < 8; ) {
      await new Promise(r => setImmediate(r))
      quiet = inflight === 0 && timers === 0 ? quiet + 1 : 0
    }
  }
  return { sandbox, main, common, tdir, g, on, fire, settle, logs, toasts, commands }
}

type World = ReturnType<typeof build>

// the run, in order. `mergeB: false` is the control: the lead never merges member B. E2E_SKIP_FOREMAN_SWEEP=1
// skips step 7's PostToolUse (the ff-only merge still happens); it exists for scratch proofs that the assertions bite.
async function flow(mergeB: boolean) {
  const w = build()
  const { main, common, tdir, g } = w
  const { register } = (await import(REGISTER)) as { register: (on: unknown, options: Record<string, unknown>) => unknown }
  register(w.on, {})

  const wtPath = (id: string) => `${main}/.claude/worktrees/agent-${id}`
  const branch = (id: string) => `worktree-agent-${id}`
  const lead = wtPath(LEAD)

  // 1. the crew lead's worktree, made by the hook
  const made = await w.fire('classic.WorktreeCreate', { name: `agent-${LEAD}`, cwd: main, session_id: SESSION })
  assert.equal(made?.worktreePath, lead, `WorktreeCreate fell back instead of making ${lead}: ${JSON.stringify(made)}`)
  const listed = g(main, 'worktree', 'list', '--porcelain')
  assert.ok(listed.includes(`branch refs/heads/${branch(LEAD)}`), `git worktree list lacks ${branch(LEAD)}:\n${listed}`)

  // 2. two members, made from inside the crew worktree
  for (const id of [MEMBER_A, MEMBER_B]) {
    const m = await w.fire('classic.WorktreeCreate', { name: `agent-${id}`, cwd: lead, session_id: SESSION })
    assert.equal(m?.worktreePath, wtPath(id), `WorktreeCreate fell back for ${id}: ${JSON.stringify(m)}`)
    assert.ok(g(main, 'worktree', 'list', '--porcelain').includes(`branch refs/heads/${branch(id)}`))
  }

  // 3. the members work and commit (the test plays the agents); run 3's meta files, finished
  const foremanTranscript = `${tdir}/${SESSION}.jsonl`
  const leadTranscript = `${tdir}/${SESSION}/subagents/agent-${LEAD}.jsonl`
  fs.mkdirSync(`${tdir}/${SESSION}/subagents`, { recursive: true })
  const meta = (id: string) => fs.writeFileSync(`${tdir}/${SESSION}/subagents/agent-${id}.meta.json`, META_FINISHED(id))
  for (const id of [MEMBER_A, MEMBER_B]) {
    fs.writeFileSync(`${wtPath(id)}/${id}.txt`, `work of ${id}\n`)
    g(wtPath(id), 'add', '-A')
    g(wtPath(id), 'commit', '-q', '-m', `work of ${id}`)
    meta(id)
  }

  // 4. members stop
  for (const id of [MEMBER_A, MEMBER_B]) {
    await w.fire('classic.SubagentStop', {
      agent_id: id,
      agent_type: 'kit:builder',
      cwd: wtPath(id),
      stop_hook_active: false,
      background_tasks: [],
      transcript_path: leadTranscript,
      agent_transcript_path: `${tdir}/${SESSION}/subagents/agent-${id}.jsonl`,
      session_id: SESSION,
    })
    await w.settle()
  }

  // 5. the lead merges its members into the crew branch, for real
  for (const id of mergeB ? [MEMBER_A, MEMBER_B] : [MEMBER_A]) {
    const command = `git merge --no-ff --no-edit ${branch(id)}`
    g(lead, ...command.split(' ').slice(1))
    await w.fire('classic.PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: '', tool_use_id: `t-${id}`, cwd: lead, transcript_path: leadTranscript, session_id: SESSION })
    await w.settle()
  }

  // 6. the lead stops
  meta(LEAD)
  await w.fire('classic.SubagentStop', {
    agent_id: LEAD,
    agent_type: 'foundry:lead',
    cwd: lead,
    stop_hook_active: false,
    background_tasks: [],
    transcript_path: foremanTranscript,
    agent_transcript_path: leadTranscript,
    session_id: SESSION,
  })
  await w.settle()

  // 7. the foreman fast-forwards main to the crew branch
  const command = `git merge --ff-only ${branch(LEAD)}`
  g(main, ...command.split(' ').slice(1))
  if (process.env.E2E_SKIP_FOREMAN_SWEEP !== '1') {
    await w.fire('classic.PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: '', tool_use_id: 't-foreman', cwd: main, transcript_path: foremanTranscript, session_id: SESSION })
    await w.settle()
  }

  // 8. retro's view
  const foundryDir = `${common}/foundry/${SESSION}`
  fs.mkdirSync(foundryDir, { recursive: true })
  const spawns = [LEAD, MEMBER_A, MEMBER_B].map(agentId => JSON.stringify({ v: 1, ts: '2026-10-28T15:00:00Z', event: 'spawn', agentId }))
  fs.writeFileSync(`${foundryDir}/events.jsonl`, spawns.join('\n') + '\n')
  const retro = await new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const c = spawn('python', [RETRO, foundryDir], { cwd: w.sandbox, env: cleanEnv(w.sandbox), windowsHide: true })
    let out = ''
    let err = ''
    c.stdout.setEncoding('utf8').on('data', d => (out += d))
    c.stderr.setEncoding('utf8').on('data', d => (err += d))
    c.on('close', code => resolve({ code, out, err }))
  })
  assert.equal(retro.code, 0, `retro.py failed: ${retro.err}`)
  const leftovers = JSON.parse(retro.out).leftovers as { branches: string[]; folders: string[]; count: number }

  return { w, wtPath, branch, leftovers }
}

// the three kinds of leftover, each read from real state
function observe(w: World) {
  const { main, common, g } = w
  const branches = g(main, 'for-each-ref', '--format=%(refname)', 'refs/heads/worktree-agent-*').split('\n').filter(Boolean)
  const dir = `${main}/.claude/worktrees`
  const folders = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('agent-')) : []
  const registered = g(main, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ') && l.includes('/.claude/worktrees/agent-'))
  const slotsFile = `${common}/claude-worktrees/slots.json`
  let slots: 'absent' | 'empty active' | string[]
  if (!fs.existsSync(slotsFile)) slots = 'absent'
  else {
    const active = Object.keys((JSON.parse(fs.readFileSync(slotsFile, 'utf8')).active ?? {}) as object)
    slots = active.length === 0 ? 'empty active' : active
  }
  return { branches, folders, registered, slots }
}

const dirs: string[] = []
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('a foundry-shaped run leaves zero leftovers', { skip: RETRO_SKIP }, async t => {
  const f = await flow(true)
  dirs.push(f.w.sandbox)
  const seen = observe(f.w)
  t.diagnostic(`slots.json: ${Array.isArray(seen.slots) ? seen.slots.join(', ') : seen.slots}; retro: ${JSON.stringify(f.leftovers)}`)
  for (const l of f.w.logs.filter(x => /self-clean|failed|refused/.test(x))) t.diagnostic(l)
  assert.deepEqual(seen.branches, [], 'worktree-agent-* branches left')
  assert.deepEqual(seen.folders, [], 'agent-* folders left')
  assert.deepEqual(seen.registered, [], 'agent worktrees still registered')
  assert.ok(seen.slots === 'absent' || seen.slots === 'empty active', `slots.json active entries left: ${JSON.stringify(seen.slots)}`)
  assert.deepEqual(f.leftovers, { branches: [], folders: [], count: 0 })
})

test('control: a member the lead never merged survives, and only that one', { skip: RETRO_SKIP }, async t => {
  const f = await flow(false)
  dirs.push(f.w.sandbox)
  const seen = observe(f.w)
  const b = f.branch(MEMBER_B)
  t.diagnostic(`slots.json: ${Array.isArray(seen.slots) ? seen.slots.join(', ') : seen.slots}; retro: ${JSON.stringify(f.leftovers)}`)
  for (const l of f.w.logs.filter(x => /self-clean|failed|refused/.test(x))) t.diagnostic(l)
  assert.deepEqual(seen.branches, [`refs/heads/${b}`])
  assert.deepEqual(seen.folders, [`agent-${MEMBER_B}`])
  assert.ok(fs.existsSync(`${f.wtPath(MEMBER_B)}/${MEMBER_B}.txt`), 'the unmerged work is still on disk')
  assert.ok(seen.slots === 'absent' || seen.slots === 'empty active', `slots.json active entries left: ${JSON.stringify(seen.slots)}`)
  assert.deepEqual(f.leftovers, { branches: [b], folders: [`.claude/worktrees/agent-${MEMBER_B}`], count: 1 })
})
