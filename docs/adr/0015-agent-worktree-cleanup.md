# ADR-0015: agent worktrees are swept after real merges, from the project dir, without remote calls

Status: accepted, 2026-10-28
Accepted on the owner's approval of the foundry run-4 plan (`plan.json` `approvedAt` 2026-10-28T15:11:50Z). Written by run 4's wave-0 design crew. It ships in worktrees 0.8.0 and foundry 0.6.0. The owner's decisions at approval (plan.md, "Owner decisions at approval", 1 to 6) override the plan text, and this ADR follows them.

Amends: [ADR-0014](0014-worktrees-declared-read-only-agents.md) (where the main checkout is resolved from, and logging in the isolation path) and [foundry ADR-0004](../../plugins/foundry/docs/adr/0004-scope-repair-and-head-gates.md) (real merges replace rebases; the patch-id carry). ADR-0001, ADR-0006 and ADR-0012 are unchanged; item 13 says why.

## Context

Run 3 left 89 `worktree-agent-*` branches on origin and 100 registered worktrees, though every crew merged. worktrees' self-clean (`selfClean`, `plugins/worktrees/hooks/register.ts:966`) removed almost none of them, for four reasons this ADR fixes:

- it only looks at the worktrees this session's `WorktreeCreate` put in the in-memory `tracked` map (`register.ts:1294`, `1351`), so a resumed or restarted session sweeps nothing;
- it keeps any worktree whose `slots.json` `active` entry is under 24 hours old (`isActive`, `register.ts:356`), and `active` is only cleared from `SubagentStop` (`cleanWorktree`, `register.ts:915`), which did not run for most agents;
- it measures "merged" against the HEAD of `$.session.cwd()` (`register.ts:969`), the foreman's checkout, never the crew worktree where a lead merged its members;
- leads rebased their crew branches (`plugins/foundry/agents/lead.md:157`), so member branches stopped being ancestors of anything, and the three-way merge test (`mergesToSameTree`, `register.ts:933`) conflicts on them.

Separately, since about 13:47Z on 2026-10-28 worktrees' own auto-isolation stopped giving worktrees to agents spawned without the `isolation` parameter, while native `isolation: "worktree"` still worked (design-probe.md, first version, section (a)).

The evidence is the design probe's report, `<git common dir>/foundry/40816bb1-1ec8-4755-8d97-0d12599e1e84/reports/design/design-probe.md`. That file was later overwritten by a follow-up note about section (e); the counts below are from its first version, as the lead and this architect read it.

## Decision

### 1. Run-3 facts, and the `git cherry` fallback

From a temp clone made with `--no-hardlinks` at `main = a7f0788` (probe section (d), script `scratchpad/probe/d.sh`):

| Run-3 branches on origin | Count |
| --- | --- |
| total `origin/worktree-agent-*`, the lead's own `worktree-agent-a06516865f8298252` included | 89 |
| ancestor of main | 26 |
| patch-equivalent to main (`git cherry` prints only `-` lines) | 62 |
| with a `+` line (`origin/worktree-agent-a12bd3ef2bd7168db`) | 1 |
| of the 62, counted merged by `mergesToSameTree` (exit 0, main's own tree) | 7 |
| of the 62, `git merge-tree --write-tree` exit 1 (conflict) | 55 |

The 55 conflict because main later edited the same files (version bumps in `plugin.json`), so a three-way merge of the old branch conflicts even though every patch is in main. The `active` facts (probe sections (c), (f)): `slots.json` has 99 `active` entries and an empty `slots` map; 28 of 28 finished depth-2 agents and 7 of 10 finished depth-1 agents are still `active`.

**Decision.** A branch counts as merged into a ref when the first of these holds:

1. `git merge-base --is-ancestor <branch> <ref>` exits 0;
2. `mergesToSameTree` returns true;
3. **the cherry fallback:** `git cherry <ref> <branch>` exits 0, prints at least one non-empty line, and every non-empty line starts with `- `.

The fallback runs only when 1 fails and 2 returns false or undefined, and only for a candidate the sweep would otherwise remove: registered, on a `worktree-*` branch, not locked, not live, clean. One `+ ` line means not merged. A failed `git cherry` (non-zero exit) means not merged. On run 3's shapes this counts 88 of 89 merged and keeps the one with a `+`.

The branch delete follows the test that proved the merge: `git branch -d <branch>` after test 1, `git branch -D <branch>` after test 2 or 3, because `-d` refuses a branch that is not an ancestor, and both tests already proved its content is in the ref. Today's code always uses `-d` and keeps the branch when it refuses (`register.ts:1014`); that changes.

### 2. The merged-into ref

The refs are local HEADs, never a remote-tracking ref, `FETCH_HEAD` or `origin/<default>`:

- **the merge checkout's HEAD:** the checkout that the `PostToolUse` event's `cwd` lies in, found with `git rev-parse --show-toplevel` run in that `cwd`. When a lead runs `git merge --no-ff <member>` in its crew worktree, this is the crew branch;
- **the main checkout's HEAD:** the main checkout of the repo resolved from the project dir (item 4). After the foreman's `git merge --ff-only <crew branch>`, this is the target.

A branch merged into either ref qualifies. When the event's `cwd` is in no work tree (the foreman working from `.git/foundry/<session>`), only the main checkout's HEAD is used. Every git command for a ref runs with `cwd` set to that ref's checkout, and the ref is passed as `HEAD`.

The two refs make the lead-side sweep optional: after the foreman's fast-forward, every member branch the lead merged with `--no-ff` is an ancestor of main, so the main-checkout sweep removes it even if the lead's own sweep never ran.

### 3. The signal

worktrees keeps its own `classic.PostToolUse` merge detection (`register.ts:1456-1462`): a `Bash` or `PowerShell` command matching `\bmerge\b` schedules a sweep with `$.clock.after(0, ...)`. The `tracked.size === 0` early return goes: an empty map no longer skips the sweep. worktrees reads nothing foundry writes for this, so the plugins still cooperate only through Claude Code and the disk (ADR-0001). `SubagentStop` stays as it is for background work and leftover commits; the sweep no longer needs it (item 6).

### 4. The project dir, not the process cwd

The hook input has no project-dir field. `BaseHookInput` carries `session_id`, `transcript_path`, `cwd`, and optional `agent_id`, `agent_type` (probe section (b), from the bundled `claude-code.d.ts:853`); a grep for `CLAUDE_PROJECT_DIR` and `project_dir` over the plugin-authoring types finds nothing.

**Decision.** The isolation decision (`classic.PreToolUse` on `Agent`, `register.ts:1298`) and the sweep resolve the repo the same way, trying in order:

1. `await $.env.get('CLAUDE_PROJECT_DIR')`, when it returns a non-empty string. Whether Claude Code sets it for mods is not confirmed (TODO: no probe saw it set or unset in the mod process), so it is only the first try;
2. the event's `cwd`;
3. `await $.session.cwd()`.

For each candidate in turn, worktrees runs `git rev-parse --path-format=absolute --git-common-dir` with `cwd` set to the candidate. The first output that ends in `/.git` or `\.git` wins; the main checkout is that path without the `/.git`. A cwd inside the git dir (`.git/foundry/<session>`) resolves too, because `--git-common-dir` answers there while `--is-inside-work-tree` prints `false`.

The resolved repo is cached for the session only when one was found. A failure is never cached: the next call tries again. The `let inRepo` with `inRepo ??=` (`register.ts:1287`, `1301`) goes, and `needsWorktree` is called with `inRepo` true exactly when a repo was found. `declaredByKit` (`register.ts:724`) and `nestedRepos` read from that main checkout instead of running git with no `cwd`.

### 5. Discovery after a restart, and native worktrees

The sweep's candidates are every registered worktree in `git worktree list --porcelain` (run in the main checkout) whose path is `<main checkout>/.claude/worktrees/agent-<id>`, with `<id>` matching `[0-9a-z]+`, plus the keys of `slots.json` `active` (for retiring and pruning entries; item 7 of the seams). The `tracked` map stays only as a hint; the sweep does not depend on it. Worktrees under other names (a session started with `claude --worktree <name>`) stay `/tidy`'s, since their session may still be live and no stop retires it.

**Native worktrees are covered, because they leak too** (owner decision 5). An agent spawned with `isolation: "worktree"` gets its worktree from this plugin's `WorktreeCreate` too (`register.ts:1323-1351`): the probe's native `isolation-probe` agent `aa377ace8ec91d621` got an `active` entry (probe section (f)). It ended clean and kept its worktree and branch; the foreman removed both by hand (`git worktree remove`, `git branch -d`), and its `active` entry is still in `slots.json`. The probe's reading that it "was removed" mistook that hand removal for a cleanup (the foreman's check, relayed by the design lead). So native and auto-isolated agent worktrees have the same layout and the same entries, and the sweep treats them the same.

**A stale entry is retired.** An `active` entry whose folder no longer exists (`$.fs.exists(path)` is false) and that `git worktree list` doesn't register is dropped in the sweep's `slots.json` write, whatever its age, because no agent can still work in a folder that is gone. That is how a hand removal's leftover entry goes.

**A live agent is never removed.** "Live" means an `active` entry younger than `ACTIVE_FOR_MS` that no finished meta has retired (item 12). An agent in another session has its `active` entry from its own session's `WorktreeCreate`, and this session cannot read its meta (meta is looked up in this session's transcript dir only), so it stays live until its entry is 24 hours old, even when its branch is empty and therefore an ancestor of every ref. An agent still running after 24 hours counts as not live, as `ACTIVE_FOR_MS`'s comment already says (`register.ts:328-329`).

### 6. SubagentStop at depth 2: fires for some

Evidence:

- It fires at least sometimes. Subagent transcript `~/.claude/projects/C--sw-claude-mods/40816bb1-1ec8-4755-8d97-0d12599e1e84/subagents/agent-a81dffe0419ca3ea8.jsonl` (meta: `kit:builder`, name `kit-builder-4`, `spawnDepth` 2) holds a user message starting `Stop hook feedback:\nYou still have background work running: `, which is worktrees' `decideStop` block text (`register.ts:598`, returned at `register.ts:1406`). That is the only such hit across the 151 depth-2 transcripts in that projects dir (the lead's count).
- It does not fire, or does not finish, for most. The probe agent `a5bcc0211c0bba910` (depth 2) stopped with background work and got no such feedback. 28 of 28 finished depth-2 agents still have `active` entries, though `cleanWorktree` always calls `markDone` for a path in `active` (probe section (c)).

**Decision.** The sweep does not depend on `SubagentStop`. `active` is retired by a finished meta (item 12) or pruned at `ACTIVE_FOR_MS`.

### 7. Read-only roles get no worktree through `noIsolateAgents`

No new declaration is added (owner decision 1). Judges and cynics get no worktree through worktrees' existing `noIsolateAgents` option (`noIsolateTypes`, `register.ts:15`; read once in `register`, `register.ts:1284`). Only the owner sets it, in their own settings (`pluginConfigs."worktrees@inline".options.noIsolateAgents`; the owner set it to `foundry:judge,foundry:cynic` in `~/.claude/settings.json` during run 4, probe section (a); the option is read when `register` runs, so it takes effect from the next session, per the foreman's check relayed by the design lead). worktrees reads exemptions from exactly two places, both as today: that option and kit's manifest (ADR-0014). Nothing an agent writes in the repo or the foundry dir exempts anything, so no agent can exempt itself.

Red teams are `foundry:judge` started with an explicit `isolation: "worktree"` (`plugins/foundry/agents/lead.md:59`), and an explicit `isolation` wins over every list (the handler's first line, `register.ts:1300`). So red teams keep their worktree, which they need to check out the head they attack.

Refused types are still refused where they are refused today: `declaredReadOnly` drops them from kit's manifest (`REFUSED_READ_ONLY_TYPES`, `register.ts:76`). `noIsolateAgents` is the owner's own override and stays untouched, as ADR-0014's amendment says. This needs no amendment of ADR-0014. foundry init's existing advice to set `noIsolateAgents` (`plugins/foundry/skills/init/SKILL.md:72`) stays.

### 8. The refused list does not change in this run

`REFUSED_READ_ONLY_TYPES` stays `general-purpose`, `kit:builder`, `kit:test-writer`, `foundry:architect`, `foundry:devops`, `foundry:lead`, `foundry:writer` (`register.ts:76`). kit keeps its own copy (`plugins/kit/scripts/kit_manifest.py`, error `READ_ONLY_EDITING_TYPE`) and no run-4 crew owns kit, so changing the list here would split the two copies. A later change needs an owner for kit's copy.

### 9. The plan-mode architect hands its plan back; foundry's hook writes it

`foundry:architect` is refused, so it keeps its worktree in every mode and runs its done-check proofs there. It no longer writes `<foundry dir>/plan.json` or `plan.md` itself. It hands them back, and foundry's hook writes them, as it already writes `reports/` from a crew agent's hand-back (`writeReport`, `plugins/foundry/hooks/register.ts:934`; the capture at `register.ts:1640-1660`).

The interface, all observable:

- **Who.** The hook records an agent as a plan architect when the `Agent` call comes from the main session (`tool.call` with `e.agentId === undefined`), its `subagent_type` is exactly `foundry:architect`, and the first line of its `prompt`, with a trailing `\r` and spaces trimmed, is exactly `Mode: plan` (the run skill's brief already opens that way, `plugins/foundry/skills/run/SKILL.md:104`). The id is the one the call's result carries (`result.result.agentId`, as at `register.ts:1600`). An architect started by a lead or any other agent, or in `init` or `design` mode, is never recorded, so its hand-back writes no plan.
- **What it carries.** The architect's `SubagentHandback` `message` holds two fenced blocks. One opens with a line that is exactly ` ````json plan.json ` (four backticks, `json`, a space, `plan.json`), the other with exactly ` ````markdown plan.md `; each ends at the next line that is exactly four backticks. The first block of each kind counts. The rest of the message is the report, unchanged, and the hand-back reaches the foreman as today.
- **Validated first.** The hook writes nothing unless both blocks are present and `parsePlan(<plan.json block>)` (`register.ts:265`) returns a plan. Otherwise it writes neither file and logs `foundry: plan-file route wrote nothing: <reason>` through `logRule`.
- **Never over an approved plan.** When `<foundry dir>/plan.json` exists, the hook reads it; unless `parsePlan` of it returns a plan whose `approvedAt` is `null`, it writes neither file and logs `foundry: plan-file route kept the existing plan: <reason>`. An unreadable existing file is kept too.
- **Written unapproved.** The hook writes `<foundry dir>/plan.json` as `JSON.stringify({ ...carried, approvedAt: null }, null, 2) + '\n'`, then `<foundry dir>/plan.md` as the block text (its inner lines joined with `
`, without the fences and with no trailing newline), through `$.fs.write`. `<foundry dir>` is `rootOf` (`register.ts:818`). Only the foreman sets `approvedAt`, when it logs the plan. An `auto` plan on disk therefore fails `plan.schema.json`'s `allOf` (which wants a string) until the foreman logs it; the schema describes the logged plan, and the gates read `approvedAt: null` as unapproved only for `approval: "owner"` (`planVerdict`, `register.ts:300`).

foundry-protocol's crew changes `agents/architect.md` and the run skill to match: the architect validates its draft against the schema from a file in its own worktree's untracked scratch, never commits it, and hands both files back in the blocks above; the foreman reads `plan.json` and `plan.md` from the foundry dir after the hand-back.

### 10. Foundry-dir writes: Claude Code's guard, which no plugin can widen

The guard that refused worktree agents' writes in run 3 is Claude Code's own worktree confinement, not a plugin, user hook or setting (probe section (e)): its text, `This agent is isolated in the worktree <path>, but this command names git in a form too complex to verify ...`, appears in no file under `plugins/`, `~/.claude/hooks` or `~/.claude/settings.json`, and worktrees registers no `PreToolUse` handler except the one on `Agent`. The Write-tool refusal for `.git/foundry` is recorded only as a paraphrase in `reports/foundry-init/foundry-init-acceptance.md:70`; its exact wording is not recorded (the probe's follow-up note). No plugin can widen the guard. The fix is item 7 (judges and cynics run in the main checkout, outside the guard; they write no foundry-dir files anyway, since the hook writes their reports) and item 9 (the architect's plan reaches the foundry dir through the hook).

### 11. The merge contract

Leads consolidate with real merges only: `git merge --no-ff <member>` into the crew branch, and, when the foreman asks the lead to make its branch ready, `git merge <target>` into the crew branch. Never a rebase or a cherry-pick. The foreman still fast-forwards: `git merge --ff-only <crew branch>`. The `<base>` on the lead's Branch line becomes "the target head last merged in": the brief's base commit until the lead first merges the target, then the target head of its latest `git merge <target>`. Because the merged branch contains every member branch as an ancestor, item 1's test 1 removes their worktrees after both the lead's merge and the foreman's fast-forward. foundry ADR-0004 is amended to match.

### 12. No remote calls; meta from the transcript path; fail open

- The sweep never runs `git fetch`, `git pull`, `git push`, `git update-ref`, `git merge` of any kind, `git branch -D` except after item 1's test 2 or 3, or `git push --delete`, and never deletes a remote branch. Remote branches stay `/tidy`'s, on demand (`tidy`, `register.ts:1181`).
- **Meta path.** For a candidate `agent-<id>`, the meta file is found from the event's `transcript_path`, never from a fixed `~/.claude`: when the transcript's parent directory is named `subagents`, the session dir is its grandparent; otherwise the session dir is `transcript_path` without its trailing `.jsonl`. The meta is `<session dir>/subagents/agent-<id>.meta.json` (layout in probe section (b)).
- **Finished retires `active`.** A meta that parses as a JSON object with `finished === true` retires the candidate's `active` entry (`markDone`), so the agent no longer counts as live. Real metas carry `"finished": true` once the agent ends; a running agent's meta has no `finished` key (checked on `agent-a0094b81f5471341a.meta.json` and this architect's own running meta).
- **Fail open.** A missing meta, one that is not JSON, not an object, or has `finished` set to anything other than a boolean leaves `active` as it is: the candidate is live while its entry is under `ACTIVE_FOR_MS`, as today.
- **Prune.** Every sweep drops `active` entries whose `at` is `ACTIVE_FOR_MS` or more before now. Retiring and pruning happen in one `withState` write of `<git common dir>/claude-worktrees/slots.json`.
- **Report, never destroy.** A candidate that is not live but dirty (`git status --porcelain` printed something, or failed) or locked is kept. The sweep logs `worktrees: self-clean kept <path>: uncommitted changes` or `worktrees: self-clean kept <path>: locked (<reason>)` to the debug log, and the sweep's toast names each kept path. `git worktree remove` never gets `--force`.

### Isolation: the root cause is not settled, so the fix covers each candidate

The probe could not find why worktrees' auto-isolation stopped (probe section (a)). No debug log exists (`~/.claude/debug` is empty), so no `worktrees:` line could be read. It ruled out: the mod not loading and a `withState` lock failure (`slots.json` got `active` entries from `WorktreeCreate` after the failure began, at 15:05:17Z and 15:13:20Z); kit's manifest (`.claude/kit/manifest.json` does not exist); nested repos (only `/c/sw/claude-mods/.git` found, no nested-repo toast in the transcript); and `noIsolateAgents` (it lists only `foundry:judge,foundry:cynic`, and the owner set it during run 4, so it applies from the next session: it explains neither the architect rows nor the cynic rows that lacked a worktree after the failure began; those are the same unexplained failure, per the foreman's check relayed by the design lead, which corrects the probe's reading of the cynic rows). `WorktreeCreate` itself works: `slots.json` was written at 11:29:13 EDT on 2026-10-28 with `active` entries for agents spawned with explicit `isolation: "worktree"` (same source). Only auto-isolation of calls without the parameter is broken. Three candidates remain, and the evidence cannot tell them apart: `inRepo` cached `false`, `updatedInput` ignored by Claude Code, and a throw swallowed by `.catch(passThrough)` (`passThrough` is `($, e, next) => next(e)`, `register.ts:1281`, which logs nothing).

**Decision.** The fix covers all three:

- no cached `false` (item 4);
- every early return in the handler logs one debug line `worktrees: isolation skipped <type>: <reason>`, with the reasons `explicit isolation`, `no repo found`, `no-isolate type`, `nested repos`, `kit manifest declares it read-only` and `another hook answered`; a call that gets a worktree logs `worktrees: isolating <type>`. A debug log then shows which branch ran, and an `isolating` line with no `WorktreeCreate` after it points at `updatedInput` being ignored;
- the handler catches its own throw: it logs `worktrees: isolation failed for <type>: <String(error)>` to the debug log, toasts once per session `worktrees: could not give <type> a worktree; it runs in the current checkout. See the debug log.`, and lets the call through unchanged (calling `next(e)` if it has not yet). `.catch(passThrough)` stays as the last net. `<type>` is `subagent_type`, or `general-purpose` when unset.

**Where the lines go.** `~/.claude/debug/` is empty in this setup, so `$.ui.log(..., { to: 'debug' })` lines are not on disk; they probably appear only with Claude Code's debug logging on (TODO: unverified). So the contract pins the `$.ui.log` calls themselves, with their exact text, not a file. The one signal that must reach the owner without debug mode is the throw, and it does, through the toast above. worktrees 0.8.0's README says the skipped and isolating lines need debug logging on.

Native inheritance, observed: an agent spawned without the parameter by a lead in a worktree, when the plugin does not isolate it, runs in the lead's worktree. Its meta carries `inheritedWorktreePath` and no `worktreePath` (the probe's own meta, `agent-a5bcc0211c0bba910.meta.json`). So a failed isolation means a member edits its lead's checkout. foundry's prompts already set `isolation: "worktree"` on editing members (`plugins/foundry/agents/lead.md:80`), which native isolation honours.

### 13. Amends

- **ADR-0014**, amended: the main checkout whose `.claude/kit/manifest.json` worktrees reads is resolved from the project dir (item 4), not from a git call with no `cwd`; and the isolation path logs every early return and every throw. The manifest rules themselves don't change.
- **foundry ADR-0004**, amended: real merges replace rebases in its three passages and its head-guard table, and the patch-id carry survives with `<base>` read as the target head last merged in.
- **ADR-0006**, unchanged: no new file goes under the git common dir. `slots.json` is already there, and `plan.json` and `plan.md` are already listed under the foundry dir; only their writer changes.
- **ADR-0012**, unchanged: no extension point is added or changed.
- **ADR-0001**, unchanged: the channel list doesn't change. `meta.json` is a file Claude Code writes, not one plugin's file read by another, and the merge signal is worktrees' own.

## Amendment, 2026-10-28: the sweep after run 4's incident

Approved by the owner as foundry run 4's `worktrees-repair` design slice. It ships in worktrees 0.8.1. With real git, 0.8.0's sweep removed a live lead and orphaned member branches (the run's goal file `goals/worktrees-repair.md`, items 1 and 2; proof `tests/e2e/cleanup.e2e.ts` at df997bf). The e2e lead ran `git merge --no-ff <writer>`, then ended its turn to wait, so its meta said `finished: true`. A sweep set off by the writer's commit message (`/\bmerge\b/`, `register.ts:1728`) used the writer's checkout as a ref. The lead's merge commit had the writer's tree, so `mergedBy` gave `'tree'` and `decideSelfClean` (`register.ts:596`) chose `git worktree remove` plus `git branch -D`. Separately, a member removed from a crew-worktree sweep lost its branch to `git branch -d` refusing in the main checkout (`register.ts:1191`), and no later sweep could find it.

These four points replace what they contradict in items 1, 2, 3, 5 and 12. Nothing else changes. The sweep still runs no `fetch`, `pull`, `push`, `update-ref`, `--ff-only` or `git worktree remove --force`, and `REFUSED_READ_ONLY_TYPES` (item 8) is unchanged.

**(a) A lead with members still running is live, whatever its own meta says.** A background lead's turn ends every time it waits, so its own `finished: true` doesn't prove it is done. The signal is the other metas in the same session dir. Claude Code writes every subagent's meta to `<session dir>/subagents/agent-<id>.meta.json` (item 12), and a depth-2 agent's meta carries `parentAgentId`, the bare id of the agent that spawned it. Of this session's metas, 195 of 195 at depth 2 carry it and 40 of 40 sampled at depth 1 don't. A running agent's meta has no `finished` key: this architect's own running meta has `"parentAgentId":"a1b0d695439dfd16b"` and no `finished`. `slots.json` can't serve, because its `active` entries hold only `{ path, at }`, with no parent.

The candidate `agent-<id>` has a running member when some other meta in that dir parses as a JSON object with `parentAgentId === <id>` and `finished !== true`. A candidate with a running member is live and is kept. **When the signal can't be read, the sweep keeps every candidate.** The signal can't be read when the event has no `transcript_path`, when `$.fs.list` of the subagents dir throws, or when any `*.meta.json` there can't be read or doesn't parse as a JSON object. Only direct members count. A lead in another session can't be seen this way and keeps item 5's 24-hour rule.

**(b) Merge evidence from the candidate's own crew never earns a force delete.** The sweep can't reliably tell which agent worktree belongs to the candidate's crew. A member forked from a lead with no commits of its own shares the lead's merge base with main. So **no agent worktree's HEAD is ever a merged-into ref**, for any test. The one ref is the main checkout's HEAD (item 2's second bullet). A branch is deleted with:

- `-d` when `git merge-base --is-ancestor <branch> HEAD` exits 0 in the main checkout;
- `-D` only when that fails and `mergesToSameTree` or the cherry fallback (item 1, tests 2 and 3) proves the branch against the main checkout's HEAD, and the main checkout's own branch is not a `worktree-*` branch. When it is one, the tree and cherry tests count as not merged.

No other ref earns `-D`.

**(c) The sweep fires only on a real `git merge` command.** The `PostToolUse` trigger (`Bash` or `PowerShell`) schedules a sweep exactly when `isGitMerge(command)` is true. The rule:

1. *Heredoc bodies are dropped.* After a `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"` on a line, the following lines up to one equal to `WORD` are removed (leading tabs are stripped first for `<<-`). PowerShell here-strings go too: everything from a line ending in `@'` or `@"` up to a line starting with `'@` or `"@`. An unterminated body removes the rest of the command.
2. *Tokenise.* Words are split on unquoted whitespace. `'...'` groups literally, and `"..."` groups with `\` escapes. A backslash outside quotes escapes the next character. Quotes are removed from the word. If a quote is left unbalanced, the answer is false.
3. *Command boundaries.* Outside quotes, a boundary is the start of the text, a newline, `;`, `&&`, `||`, `|`, `&`, `(`, `)`, `$(` or a backtick. Inside double quotes only `$(` and a backtick start a command, and inside single quotes nothing does. Any other quoted text is never a boundary or a command, so `git commit -m "merge x; git merge y"` is one `commit` command.
4. *A command is a git merge* when its first word, after any leading `NAME=value` words, is `git` or `git.exe`, or ends in `/git`, `\git`, `/git.exe` or `\git.exe`. Global options are then skipped. Every word starting with `-` is skipped, and `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix` and `--config-env`, written without `=`, also skip the next word. The first word left is the subcommand, and it must equal `merge` exactly. So `git -C x merge y`, `git -c a=b merge y` and `git --no-pager merge y` fire; `git merge-base`, `git merge-tree`, `git mergetool`, `echo git merge` and `git log --grep merge` don't.

A command that doesn't fire leaves its leftovers to the next real merge's sweep.

**(d) A member branch is deleted only once the main checkout's HEAD contains it.** It follows from (b): the sweep removes an agent worktree only when its branch is merged, by (b)'s tests, into the main checkout's HEAD. A branch merged only into a crew branch is kept with its worktree and logged as `worktrees: self-clean kept <path>: <branch> is not in the main checkout's HEAD yet`. After the foreman's `git merge --ff-only <crew branch>`, the next sweep, run from the main checkout, finds the worktree again and removes it, then its branch. This covers every agent worktree, lead or member, since the sweep treats them alike (item 5). A delete that still refuses after the removal is never silent: its debug line names the branch, and so does the sweep's toast. The lead-side sweep still retires and prunes `active` entries, but removes nothing that main doesn't hold.

**(e) While the main checkout is on no branch, the sweep keeps every candidate.** When `git branch --show-current` prints nothing (a detached HEAD, mid-rebase, mid-bisect, or after `git checkout <sha>`) or fails, nothing counts as in the main checkout's HEAD, whatever (b)'s tests say. Every agent worktree and its branch stay, logged as `worktrees: self-clean kept <path>: the main checkout is on no branch (detached or unreadable)`, until the main checkout is on a branch again and a later sweep runs. A detached HEAD is not a ref, so commits anchored only there are lost once it moves, and deleting the branch that held them would orphan them.

**Open question, RT5-1 (not decided here).** While `slots.json` is unreadable, `WorktreeCreate` still makes worktrees but can't write their `active` entries. Deleting the file, as the toast says, also drops the entries recorded before it broke. A running agent with no entry and no finished meta then counts as not live. It is open whether `WorktreeCreate` should refuse or defer while the file is unreadable, or whether a missing entry should count as live.

## Seams to pin

worktrees' cases go in `plugins/worktrees/tests/contract-cleanup.test.ts`, run by `claude plugin test`, with the engine mocked as in `tests/contract.test.ts`: `process.run` answered by argv and `cwd`, `fs.exists`/`fs.read`/`fs.write` from a map, `ui.log` and `ui.toast` recorded, `env.get` and `session.cwd` answered. The sweep runs in `$.clock.after(0, ...)`, so each case drives the clock or awaits the scheduled callback before asserting. The tests import only `register` from `../hooks/register.ts` and the fixtures, nothing that doesn't exist on main, so on main they load and fail on behaviour. Paths below use the fixture constants.

`plugins/worktrees/tests/fixtures/run3.ts` exports, and wave 1's unit tests and the e2e test import them and build no second set:

- `MAIN` = `'C:/r'`, `COMMON` = `'C:/r/.git'`, `SLOTS_PATH` = `'C:/r/.git/claude-worktrees/slots.json'`, `FOUNDRY_CWD` = `'C:/r/.git/foundry/S1'`;
- `NOW` (a fixed epoch ms) and `HOUR` = `3_600_000`;
- `TRANSCRIPT` = `'C:/h/.claude/projects/C--r/S1.jsonl'`, `SUBAGENT_TRANSCRIPT` = `'C:/h/.claude/projects/C--r/S1/subagents/agent-a1lead.jsonl'`, `ODD_TRANSCRIPT` = `'D:/elsewhere/S1.jsonl'`, and `metaPath(transcript, id)` is not exported (the producer owns it); instead `META_DIR` = `'C:/h/.claude/projects/C--r/S1/subagents'`;
- agent ids and paths: `LEAD` (crew worktree `agent-a1lead`, branch `worktree-agent-a1lead`), `MEMBER` (`agent-a2member`), `NATIVE` (`agent-a3native`, created by a native `isolation: "worktree"` spawn), `LIVE_OTHER` (`agent-a4other`, another session, empty branch), `DIRTY` (`agent-a5dirty`), `LOCKED` (`agent-a6locked`), `STALE` (`agent-a7stale`), `PATCH_EQUIV` (`agent-a8cherry`), `PLUS` (`agent-a9plus`); each as `{ id, path, branch }` with `path` = `` `${MAIN}/.claude/worktrees/agent-<id>` ``;
- `WORKTREE_LIST_PORCELAIN`: `git worktree list --porcelain` output for `MAIN` on `main` and every agent worktree above, `LOCKED` with a `locked <reason>` line;
- `SLOTS_JSON`: `{"slots":{},"active":{...}}` text in run 3's shape (lower-cased keys, `{ path, at }` values), with `LEAD`, `MEMBER`, `NATIVE`, `DIRTY`, `LOCKED` at `NOW - HOUR`, `LIVE_OTHER` at `NOW - HOUR`, `STALE` at `NOW - 25 * HOUR`;
- `META_FINISHED(id)` and `META_RUNNING(id)`: meta texts with the real keys (`agentType`, `isBuiltIn`, `worktreePath`, `spawnedWithWorktree`, `description`, `name`, `toolUseId`, `parentAgentId`, `spawnDepth`, `requestShape`, `requestNonInteractive`, `model`, `effort`), with `"finished": true` and without `finished`; `META_INHERITED(id)` with `inheritedWorktreePath` instead of `worktreePath`; `META_RESHAPED` = `'{"finished":"yes"}'`; `META_NOT_JSON` = `'{not json'`;
- `CHERRY_ALL_MINUS` = `'- 1111111111111111111111111111111111111111\n- 2222222222222222222222222222222222222222\n'` and `CHERRY_ONE_PLUS` = `'- 1111111111111111111111111111111111111111\n+ 3333333333333333333333333333333333333333\n'`;
- `MERGE_TREE_CONFLICT`: `{ exitCode: 1, stdout: <a tree id and conflict lines> }`.

A "sweep" below is: a `classic.PostToolUse` event with `tool_name: 'Bash'`, `tool_input.command` containing `git merge`, the given `cwd` and `transcript_path`, then the scheduled callback run.

1. **Member merged into the crew branch, crew HEAD as ref.** Sweep with `cwd` = `LEAD.path`; `git rev-parse --show-toplevel` in `LEAD.path` prints `LEAD.path`; `git merge-base --is-ancestor worktree-agent-a2member HEAD` with `cwd` `LEAD.path` exits 0, and with `cwd` `MAIN` exits 1; `META_FINISHED(MEMBER.id)` at `META_DIR/agent-a2member.meta.json`. Expected: `process.run` saw `git worktree remove MEMBER.path` (with `-c core.longpaths=true` when `env.get('OS')` is `Windows_NT`) and `git branch -d worktree-agent-a2member`.
2. **Crew branch merged into an unpushed local target, origin behind.** Sweep with `cwd` = `MAIN`; `--is-ancestor worktree-agent-a1lead HEAD` in `MAIN` exits 0; `git rev-parse origin/main` (if asked) answers an older SHA. Expected: `LEAD.path` removed and its branch deleted with `-d`.
3. **No remote or ref-moving calls.** Over every sweep in this file, no `process.run` argv contains `fetch`, `pull`, `push`, `update-ref` or `--ff-only`, no argv is a `git merge` (merge-tree and merge-base are fine), and no `git worktree remove` argv contains `--force`.
4. **A finished meta retires `active`.** `MEMBER` merged, `META_FINISHED`. Expected: the last `fs.write` to `SLOTS_PATH` has no `active` key for `MEMBER.path` (lower-cased), and the worktree is removed.
5. **A missing or reshaped meta fails open.** `MEMBER` merged and `active` at `NOW - HOUR`, with no meta file, then with `META_RESHAPED`, then `META_NOT_JSON`. Expected each time: no `git worktree remove MEMBER.path`, no throw, `active` for `MEMBER.path` unchanged in any write to `SLOTS_PATH`.
6. **Entries past `ACTIVE_FOR_MS` are pruned.** `SLOTS_JSON` with `STALE` at `NOW - 25 * HOUR`. Expected: the sweep's write to `SLOTS_PATH` has no `STALE` key; `STALE`, if merged and clean, is removed.
7. **Dirty kept and reported.** `DIRTY` merged, not live (finished meta), `git status --porcelain` in `DIRTY.path` prints ` M a.txt`. Expected: no `git worktree remove DIRTY.path`; a `ui.log` line exactly `worktrees: self-clean kept C:/r/.claude/worktrees/agent-a5dirty: uncommitted changes`; a `ui.toast` whose text contains `DIRTY.path`.
8. **Locked kept and reported.** `LOCKED` merged, not live. Expected: no remove; a `ui.log` line starting `worktrees: self-clean kept C:/r/.claude/worktrees/agent-a6locked: locked (`; a `ui.toast` containing `LOCKED.path`.
9. **Meta found from the transcript path.** Sweep with `transcript_path` = `ODD_TRANSCRIPT`. Expected: `fs.exists` or `fs.read` was called with `D:/elsewhere/S1/subagents/agent-a2member.meta.json`, and with no path under `C:/h/.claude` or any `env.get('USERPROFILE')`/`env.get('HOME')` value. With `transcript_path` = `SUBAGENT_TRANSCRIPT`, the meta read is `META_DIR/agent-a2member.meta.json`.
10. **Isolation from inside the git common dir, and no cached `false`.** `classic.PreToolUse` `Agent` call, `subagent_type: 'kit:builder'`, no `isolation`, `cwd` = `FOUNDRY_CWD`; `git rev-parse --is-inside-work-tree` in `FOUNDRY_CWD` prints `false`, `--git-common-dir` there prints `COMMON`. Expected: the call reaches the engine with `isolation: 'worktree'`. A second call with `cwd` = `MAIN` also gets `isolation: 'worktree'`. A third case: the first call's `--git-common-dir` fails for every candidate (exit 128), so it reaches the engine without `isolation` and logs `worktrees: isolation skipped kit:builder: no repo found`; the next call, with git answering, gets `isolation: 'worktree'`.
11. **A throw in the isolation path is logged.** `env.get` throws `new Error('boom')` for every key. A `kit:builder` call with no `isolation`. Expected: no deny; the engine receives the input without `isolation`; one `ui.log` line exactly `worktrees: isolation failed for kit:builder: Error: boom`; one `ui.toast` containing `could not give kit:builder a worktree`.
12. **A merge from a cwd outside any work tree still sweeps.** Sweep with `cwd` = `FOUNDRY_CWD`, where `git rev-parse --show-toplevel` exits 128, `--git-common-dir` prints `COMMON`; `--is-ancestor worktree-agent-a1lead HEAD` in `MAIN` exits 0. Expected: `LEAD.path` removed, with git run in `MAIN`.
13. **Empty `tracked` map, fresh session.** A freshly registered plugin with no `WorktreeCreate` seen; `WORKTREE_LIST_PORCELAIN` and `SLOTS_JSON` on disk; `MEMBER` merged into `MAIN`'s HEAD with `META_FINISHED`. Expected: `MEMBER.path` removed.
14. **A live agent in another session with an empty branch survives.** `LIVE_OTHER`'s `active` at `NOW - HOUR`, no meta in `META_DIR`, `--is-ancestor` exits 0 for its branch. Expected: no `git worktree remove LIVE_OTHER.path` and no `git branch` delete for it; its `active` entry is still in every write.
15. **Native worktree swept.** `NATIVE` (`META_FINISHED` with `spawnedWithWorktree: true`) merged into `MAIN`. Expected: removed, and its `active` entry gone from the write.
16. **The cherry fallback.** `PATCH_EQUIV` clean, not live, `--is-ancestor` exits 1, `git merge-tree --write-tree HEAD worktree-agent-a8cherry` answers `MERGE_TREE_CONFLICT`, `git cherry HEAD worktree-agent-a8cherry` prints `CHERRY_ALL_MINUS`. Expected: removed, then `git branch -D worktree-agent-a8cherry`. `PLUS` with the same answers but `CHERRY_ONE_PLUS`: kept, no remove.
17. **A stale entry whose folder is gone is retired.** `SLOTS_JSON` with `NATIVE` at `NOW - HOUR`, `fs.exists(NATIVE.path)` false, and `WORKTREE_LIST_PORCELAIN` without `NATIVE` (the hand-removed case). Expected: the sweep's write to `SLOTS_PATH` has no key for `NATIVE.path`; no `git worktree remove` or `git branch` delete for it.

foundry's cases go in `plugins/foundry/tests/contract-roles.test.ts`, run by `claude plugin test plugins/foundry`, driving `tool.call` with the engine mocked; `git rev-parse --path-format=absolute --git-common-dir` answers `C:/r/.git`, `session.id` answers `S1`, so the foundry dir is `C:/r/.git/foundry/S1`. A "plan hand-back" is a `tool.call` with `tool: 'SubagentHandback'`, `agentId` = the architect's id, and a `message` holding a report line plus the two four-backtick blocks of item 9 with a valid plan (`parsePlan` reads it: an object with a `crews` array) whose `approvedAt` is `"2026-10-28T15:00:00Z"`.

18. **Only the foreman's plan-mode architect.** An `Agent` call with no `agentId`, `subagent_type: 'foundry:architect'`, `prompt` starting `Mode: plan\n`, result `agentId: 'arch1'`, then a plan hand-back from `arch1`. Expected: `fs.write` of `C:/r/.git/foundry/S1/plan.json` and `C:/r/.git/foundry/S1/plan.md`. No write of either when the call came from inside a crew (`agentId` set to a lead's id), when the prompt starts `Mode: design` or `Mode: init`, or when `subagent_type` is `foundry:lead` or `general-purpose`.
19. **An approved plan is never overwritten.** As case 18, with `C:/r/.git/foundry/S1/plan.json` already holding a plan whose `approvedAt` is `"2026-10-28T15:11:50Z"`. Expected: no `fs.write` to `plan.json` or `plan.md`; a `ui.log` line starting `foundry: plan-file route kept the existing plan:`. With the existing plan's `approvedAt` `null`, both files are written.
20. **Written unapproved.** As case 18. Expected: `JSON.parse` of the text written to `plan.json` has `approvedAt === null` and otherwise deep-equals the carried plan; `plan.md` is the carried block's text.
21. **Validated before writing.** As case 18, with the `plan.json` block `{"crews": 3}`, then `{not json`, then with no `plan.md` block. Expected: no `fs.write` to either file; a `ui.log` line starting `foundry: plan-file route wrote nothing:`.

retro's `leftovers` key is pinned by design's Python test-writer in `plugins/foundry/tests/test_contract_leftovers.py`; this ADR doesn't define a second shape.

### Added by the 2026-10-28 amendment

These cases go in `plugins/worktrees/tests/contract-repair.test.ts`. The pure functions are imported from `../hooks/register.ts`, and the sweep cases use the mocked engine and fixtures above. Every sweep now lists `META_DIR` (`$.fs.list`), so the mocks answer it with the metas they put there. Where (a)-(d) change what a case in `contract-cleanup.test.ts` asserts, the case is edited with a comment citing the point. That is case 1, where the member is now kept, plus every case whose mock doesn't answer `$.fs.list`.

22. **`isGitMerge(command: string): boolean`** (c). True for `git merge x`, `git merge --no-ff --no-edit worktree-agent-a2member`, `git merge --ff-only worktree-agent-a1lead`, `git -C C:/r merge x`, `git -c core.longpaths=true merge x`, `git --no-pager merge x`, `cd C:/r && git merge x`, `GIT_EDITOR=true git merge x`, `C:/Git/bin/git.exe merge x`, and `echo "$(git merge x)"`. False for `git merge-base --is-ancestor a b`, `git merge-tree --write-tree a b`, `git mergetool`, `git commit -m "merge the writer"`, `git commit -m "x; git merge y"`, `echo git merge`, `git log --grep merge`, a `cat <<'EOF'` heredoc whose body has the line `git merge x`, a PowerShell `@'` here-string holding it, and `git commit -m "unbalanced`.
23. **The trigger uses it** (c). A `classic.PostToolUse` `Bash` event whose command is `git commit -m "merge"` schedules no `$.clock.after` callback, and neither does `git merge-base a b`. `git -C C:/r merge x` schedules one.
24. **`membersRunning(id: string, metas: readonly { name: string; text: string | undefined }[] | undefined): boolean`** (a). `metas` holds the `*.meta.json` entries of the session's subagents dir with their text, and is `undefined` when the event had no `transcript_path` or the list threw. It is true when `metas` is `undefined`. It is true when some entry other than `agent-<id>.meta.json` has `text` `undefined` or text that doesn't parse as a JSON object. It is true when some other entry parses with `parentAgentId === id` and `finished !== true`. Otherwise it is false. The pinned inputs are `META_RUNNING(MEMBER.id)` with `parentAgentId: 'a1lead'` (true for `'a1lead'`), the same `META_FINISHED` (false), `META_NOT_JSON` under another name (true), `[]` (false), `undefined` (true), and the candidate's own `META_RUNNING('a1lead')` alone (false).
25. **`decideSelfClean(f: SelfCleanFacts)` with the new facts** (a, b, d). `merged` and `mergedBy` are replaced by `inMain?: 'ancestor' | 'tree' | 'cherry'`, which is the main checkout's HEAD per (b), and two facts are added: `membersRunning: boolean` and `mainBranch?: string`, the main checkout's branch. The cases:
    - `membersRunning: true` gives `skip`, whatever else holds.
    - `inMain` undefined gives `skip` with the reason `<branch> is not in the main checkout's HEAD yet`.
    - `inMain: 'ancestor'` gives `remove` with `-d`.
    - `inMain: 'tree'` or `'cherry'` with `mainBranch: 'main'` gives `remove` with `-D`.
    - The same with `mainBranch: 'worktree-agent-a1lead'` gives `skip`.
26. **The e2e lead, as a mock world** (a, b). Sweep with `cwd` = `MEMBER.path` and `transcript_path` = `SUBAGENT_TRANSCRIPT`. `META_DIR` holds `META_FINISHED(LEAD.id)` and `META_RUNNING(MEMBER.id)`, whose parent is `a1lead`. In `MEMBER.path`, `git merge-tree --write-tree HEAD worktree-agent-a1lead` prints `MEMBER`'s own tree; `--is-ancestor worktree-agent-a1lead HEAD` exits 1 in both checkouts. Expected: no `git worktree remove LEAD.path`, no `git branch` delete of `worktree-agent-a1lead`, and no `merge-base`, `merge-tree` or `cherry` argv run with `cwd` `MEMBER.path`. With `MEMBER`'s meta finished as well, still no remove, because `MEMBER.path` is no ref.
27. **Unreadable signal keeps** (a). As case 13, with `$.fs.list(META_DIR)` throwing, then with no `transcript_path`. Expected: no `git worktree remove` at all.
28. **Merged into the crew branch only, then main fast-forwarded** (d). First sweep: `cwd` = `LEAD.path`, `--is-ancestor worktree-agent-a2member HEAD` exits 0 in `LEAD.path` and 1 in `MAIN`, `META_FINISHED(MEMBER.id)`. Expected: no remove, no `git branch` delete, and the `ui.log` line `worktrees: self-clean kept C:/r/.claude/worktrees/agent-a2member: worktree-agent-a2member is not in the main checkout's HEAD yet`. Second sweep: `cwd` = `MAIN`, `--is-ancestor` now exits 0 in `MAIN`. Expected: `git worktree remove MEMBER.path`, then `git branch -d worktree-agent-a2member`.
29. **A refused delete is reported** (d). As the second sweep of case 28, with `git branch -d` exiting 1. Expected: a `ui.toast` whose text contains `worktree-agent-a2member`.

## Consequences

- One merge by the lead and one fast-forward by the foreman clean up every agent worktree of a crew that ended clean, native or auto-isolated, even after a restart, with no remote call. Run 4's e2e test (`tests/e2e/cleanup.e2e.ts`) and retro's `leftovers` count check it.
- A live agent of another session survives a sweep only while its `active` entry is under 24 hours old. An agent running longer than that with an empty branch can be swept; that is today's `ACTIVE_FOR_MS` rule, now applied to every agent worktree, not just this session's.
- worktrees now reads a file Claude Code writes (`subagents/agent-<id>.meta.json`) whose shape no contract pins. A change to it fails open to the 24-hour rule.
- A branch merged by patch, not ancestry, is deleted with `-D`. The proof is `git cherry` on a local ref; a wrong answer there would delete a branch whose commits are only patch-equal to the ref's.
- Debug lines in the isolation path make the next failure diagnosable, once the debug log's location is known.
- A plan-mode architect's plan files come from the hook, so an architect started by anyone but the foreman, or a hand-back that doesn't parse, writes no plan. The foreman's step of reading the hand-back stays.
- Leads stop rebasing. The crew branch's history keeps merge commits from the target; `--ff-only` still keeps the target linear in the sense that it only moves forward.
