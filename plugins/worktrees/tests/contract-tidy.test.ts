import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { COMMON, MAIN, NOW, SLOTS_JSON, SLOTS_PATH } from './fixtures/run3'
import { hostPath } from './fixtures/paths.ts'

// Contract test for /tidy's merge detection (worktrees 0.8.5): a worktree-* branch whose merge conflicts but whose
// added lines are all in origin/main, a relay leg inside a later leg, legs with equal tips, a non-agent branch with
// work in its reflog, and a bookmark. git is faked by argv; tidy runs for real against it.

const slashed = (p: string) => p.replace(/\\/g, '/')
const sha = (c: string) => c.repeat(40)
const MAIN_TIP = sha('a')
const BASE = sha('b')

type Answer = { stdout?: string; exitCode?: number }

function world(on: On, locals: [string, string][], answer: (args: string, stdin: string) => Answer | undefined) {
  const files = new Map<string, string>([[slashed(SLOTS_PATH), SLOTS_JSON]])
  const ran: string[] = []
  mock.clock(on, { now: NOW })
  on('env.get', async (_, e) => ({ value: { OS: 'Windows_NT' }[(e as { name?: string }).name ?? ''] }))
  on('session.cwd', async () => ({ value: MAIN }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('fs.exists', async (_, e) => ({ value: files.has(slashed(hostPath(e.path))) }))
  on('fs.read', async (_, e) => {
    const text = files.get(slashed(hostPath(e.path)))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_, e) => {
    files.set(slashed(hostPath(e.path)), e.text)
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    const argv = e.argv as string[]
    const args = argv.join(' ')
    const stdin = ((e as { init?: { stdin?: string } }).init?.stdin ?? '') as string
    ran.push(args)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal: error', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const custom = answer(args, stdin)
    if (custom !== undefined) return out(custom.stdout ?? '', custom.exitCode ?? 0)
    if (args.includes('--show-toplevel')) return out(`${MAIN}\n`)
    if (args.includes('--git-common-dir')) return out(`${COMMON}\n`)
    if (args.includes('symbolic-ref')) return out('origin/main\n')
    if (args === 'git branch --show-current') return out('main\n')
    if (args === 'git worktree list --porcelain') return out(`worktree ${MAIN}\nHEAD ${MAIN_TIP}\nbranch refs/heads/main\n`)
    if (args.includes('for-each-ref') && args.endsWith('refs/heads') && !args.includes('--contains')) return out(locals.map(l => l.join(' ')).join('\n') + '\n')
    if (args.includes('for-each-ref') && args.includes('refs/remotes')) return out(`origin/main ${MAIN_TIP}\n`)
    if (args.startsWith('gh ')) return out('', 1)
    if (args === 'git rev-parse origin/main^{tree}') return out('maintree\n')
    if (args.startsWith('git merge-base --is-ancestor')) return out('', 1)
    if (args.startsWith('git rev-list --count')) return out('1\n')
    return out('')
  })
  return { ran }
}

const tidy = async ($: Parameters<Parameters<typeof test>[1]>[0], dryRun = false) =>
  ((await $.command.run({ command: 'tidy', args: dryRun ? 'dry-run' : '' } as never)) as unknown as { text: string }).text.split('\n')

const COVERED = 'worktree-wf_4b32ad75-10f-30'
const PARTLY = 'worktree-wf_161f8dc2-95a-41'
const LINE_A = 'export function covered() { return 1 }'
const LINE_B = '  const alsoCovered = compute(input)'
const patch = (path: string, lines: string[]) =>
  [`diff --git a/${path} b/${path}`, 'index 1..2 100644', `--- a/${path}`, `+++ b/${path}`, `@@ -1,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n') + '\n'
const blob = (text: string) => `${sha('c')} blob ${new TextEncoder().encode(text).length}\n${text}\n`

test('a worktree-* branch whose merge conflicts but whose added lines are all in origin/main is deleted and archived', async ($, on) => {
  const mainVersion = `// main edited this region since\n${LINE_A}\n<<changed>>\n${LINE_B}\n`
  const w = world(on, [['main', MAIN_TIP], [COVERED, sha('d')], [PARTLY, sha('e')]], (args, stdin) => {
    if (args === 'git branch --merged origin/main --format=%(refname:short)') return { stdout: 'main\n' }
    // both conflict with origin/main
    if (args.startsWith('git merge-tree --write-tree origin/main')) return { stdout: 'conflicttree\n', exitCode: 1 }
    if (args.startsWith('git merge-base origin/main')) return { stdout: `${BASE}\n` }
    if (args.includes('--numstat') && args.includes(COVERED)) return { stdout: `2\t0\tsrc/a.ts\0` }
    if (args.includes('--numstat') && args.includes(PARTLY)) return { stdout: `3\t0\tsrc/a.ts\0` }
    if (args.includes('-U0') && args.includes(COVERED)) return { stdout: patch('src/a.ts', [LINE_A, LINE_B, 'x']) }
    if (args.includes('-U0') && args.includes(PARTLY)) return { stdout: patch('src/a.ts', [LINE_A, 'a line main never took', 'and another one main lacks']) }
    if (args === 'git cat-file --batch') {
      expect(stdin).toBe('origin/main:src/a.ts\n')
      return { stdout: blob(mainVersion) }
    }
    // neither is inside another branch
    if (args.includes('--contains')) return { stdout: '' }
    return undefined
  })
  const lines = await tidy($)
  const archive = w.ran.indexOf(`git update-ref refs/tidy-archive/${COVERED} ${sha('d')}`)
  expect(archive).toBeGreaterThan(-1)
  expect(w.ran.indexOf(`git branch -d ${COVERED}`)).toBeGreaterThan(archive)
  expect(lines.filter(l => l.startsWith('removed '))).toEqual([`removed ${COVERED} (content in the default branch (later edited there)): delete branch (tip kept at refs/tidy-archive/${COVERED})`])
  expect(lines).toContain(`skip ${PARTLY}: not merged: 2 of 3 lines it adds are not in the default branch`)
  expect(lines.filter(l => l.startsWith('unmerged'))).toEqual([`unmerged agent work: ${PARTLY} (1 commit; 2 of 3 lines it adds are not in the default branch)`])
  expect(w.ran.filter(r => /^git branch -[dD] /.test(r))).toEqual([`git branch -d ${COVERED}`])
  expect(lines.filter(l => l.includes('git for-each-ref refs/tidy-archive'))).toHaveLength(1)
})

test('a relay leg inside a later leg is deleted; legs with equal tips and the containing leg stay; a reflog-worked branch goes, a bookmark stays', async ($, on) => {
  const LEG = 'worktree-wf_d80af31e-c63-17'
  const LAST = 'worktree-wf_d80af31e-c63-78'
  const TWIN_A = 'worktree-wf_9-1'
  const TWIN_B = 'worktree-wf_9-2'
  const CREW = 'truss-ui-page'
  const BOOKMARK = 'old-main'
  const locals: [string, string][] = [['main', MAIN_TIP], [LEG, sha('1')], [LAST, sha('2')], [TWIN_A, sha('3')], [TWIN_B, sha('3')], [CREW, sha('4')], [BOOKMARK, sha('5')]]
  const w = world(on, locals, args => {
    if (args === 'git branch --merged origin/main --format=%(refname:short)') return { stdout: `main\n${CREW}\n${BOOKMARK}\n` }
    if (args.startsWith('git merge-tree --write-tree origin/main')) return { stdout: 'othertree\n' }
    // the line check cannot run here: the legs stay not merged by content
    if (args.startsWith('git merge-base origin/main')) return { exitCode: 1 }
    if (args.includes('--contains')) {
      const tip = args.split(' ')[3]
      const holders = locals.filter(([b, t]) => t === tip || (tip === sha('1') && b === LAST))
      return { stdout: holders.map(l => l.join(' ')).join('\n') + '\n' }
    }
    // in origin/main, so on a remote
    if (args.startsWith(`git rev-list --count ${CREW} `) || args.startsWith(`git rev-list --count ${BOOKMARK} `)) return { stdout: '0\n' }
    if (args === `git reflog show --format=%gs refs/heads/${CREW} --`) return { stdout: "merge worktree-wf_x-1: Merge made by the 'ort' strategy.\nbranch: Created from HEAD\n" }
    if (args === `git reflog show --format=%gs refs/heads/${BOOKMARK} --`) return { stdout: 'branch: Created from main\n' }
    return undefined
  })
  const dry = await tidy($, true)
  expect(w.ran.filter(r => r.includes('update-ref') || /branch -[dD] /.test(r))).toEqual([])
  expect(dry.filter(l => l.startsWith('would: '))).toEqual([
    `would: ${LEG} (contained in ${LAST}): delete branch (tip kept at refs/tidy-archive/${LEG})`,
    `would: ${CREW} (in the default branch, worked on here): delete branch (tip kept at refs/tidy-archive/${CREW})`,
  ])
  for (const b of [LAST, TWIN_A, TWIN_B]) expect(dry.filter(l => l.startsWith(`skip ${b}: `))).toHaveLength(1)
  expect(dry).toContain(`skip ${BOOKMARK}: no merged PR (gh unavailable); in the default branch, but no commits were made on it here; looks like a bookmark`)
  // the contained leg is not unmerged work; the containing leg and the twins are
  expect(dry.filter(l => l.startsWith('unmerged')).map(l => l.split(' ')[3])).toEqual([LAST, TWIN_A, TWIN_B])

  const real = await tidy($)
  expect(real.filter(l => l.startsWith('removed ')).map(l => l.split(' ')[1])).toEqual([LEG, CREW])
  expect(w.ran).toContain(`git update-ref refs/tidy-archive/${LEG} ${sha('1')}`)
  expect(w.ran).toContain(`git update-ref refs/tidy-archive/${CREW} ${sha('4')}`)
  expect(w.ran.filter(r => /branch -[dD] /.test(r))).toEqual([`git branch -d ${LEG}`, `git branch -d ${CREW}`])
})
