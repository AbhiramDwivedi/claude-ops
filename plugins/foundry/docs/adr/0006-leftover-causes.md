# ADR-0006: why each leftover stayed, a red team that leaves nothing, and retro's root-cause step

Status: proposed, 2026-10-29. Written by the design crew `leftover-design` (wave 0), for foundry 0.9.0. It becomes accepted when the foreman merges the wave-0 crew under the owner-approved plan; no owner trigger applies (no principle breaks, no external service, retro's JSON is not stored, P15).

## Context

Retro's `leftovers` key (repo ADR-0015, pinned by `tests/test_contract_leftovers.py`) says which of a session's agents still have a `worktree-agent-<id>` branch or a `.claude/worktrees/agent-<id>` folder. It never says why. Run 1 left `.claude/worktrees/agent-acf43a8e536ebcdce`, a red team's worktree, registered `detached` at `7cdaa0b`. Its branch pointed at the same commit, which was in main, so self-clean would have removed it had the worktree stayed on its branch. The sweep drops any worktree not on a `worktree-*` branch before it decides anything, with no log line (`plugins/worktrees/hooks/register.ts:1324`, `if (live || !wt.branch?.startsWith('worktree-')) continue`). The red team was detached because `agents/judge.md:78` tells it to run `git checkout --detach <sha>`.

Three fixes follow, and this ADR decides all three:

1. retro reports, per leftover, the facts self-clean looks at and the reason it would give (section 1);
2. the red team resets its own branch instead of detaching, and leaves its worktree clean (section 2);
3. the retro skill gets a root-cause step behind its description's "why crews stalled or got rejected" (section 3).

**The interface that can't take the work.** `leftovers` is `{"branches": [...], "folders": [...], "count": n}`, and every test compares that whole dict: `tests/test_contract_leftovers.py`, `tests/test_retro_leftovers.py` and the root e2e test `tests/e2e/cleanup.e2e.ts`. A field nested inside it breaks all three. The top-level key set is pinned by set equality (`TOP_KEYS` in `tests/test_contract_retro.py:23` and `tests/test_contract_retro_050.py:69`). So the new facts go in one new top-level key, and `leftovers` and every other old key stay exactly as they are.

## Decision

### 1. retro's `leftoverDetails` key

`scripts/retro.py` prints one more top-level key, `leftoverDetails`. `TOP_KEYS` grows by exactly `"leftoverDetails"`. No other key changes, and `retro` stays 1.

**Shape.** `leftoverDetails` is `"not recorded"` or a JSON array of entry objects sorted by `id` ascending (Python `sorted` on the id string). Every entry has exactly these seven keys, never more, never fewer; an absent value is JSON `null`, never an omitted key:

| Key | JSON type | Value |
| --- | --- | --- |
| `id` | string | the agent id, as in the `spawn` event's `agentId` |
| `branch` | string or null | `"worktree-agent-<id>"` when `refs/heads/worktree-agent-<id>` exists, else `null` |
| `folder` | string or null | `".claude/worktrees/agent-<id>"` (forward slashes, relative to the main checkout) when that path is a directory, else `null` |
| `head` | string or null | for a registered worktree: its branch's short name (`refs/heads/` stripped, as `parseWorktrees` does at `register.ts:580`), or `"detached <sha>"` with the full 40-hex sha of its `HEAD` line when it has no `branch` line; `null` when not registered |
| `dirty` | boolean or null | for a registered worktree: `true` when `git status --porcelain --untracked-files=all` in its folder prints anything or fails, else `false`; `null` when not registered |
| `inMain` | string or null | `"ancestor"`, `"tree"` or `"cherry"`, the first check that holds; `null` when none holds or there is no ref to check |
| `skip` | string | the reason from the table below |

The JSON values in the table are literal: `"detached "` is the word, one space, then the sha. `head` is the worktree's own checked-out branch, so it may differ from `branch` (a worktree switched to another branch).

**Which ids get an entry.** Exactly the ids `leftovers` counts: a spawned id of this dir's event log whose branch or folder is present. So when `leftovers` is a dict, `len(leftoverDetails) == leftovers["count"]`, and `[e["branch"] for e in leftoverDetails if e["branch"]]` sorted equals `leftovers["branches"]` (the same for folders). An id with neither branch nor folder has no entry, even when a stale registration for it remains.

**Registered.** An entry is registered when `git worktree list --porcelain`, run in the main checkout, lists a `worktree <path>` whose path is the same file-system path as `<main checkout>/.claude/worktrees/agent-<id>` (`same_path`: realpath and normcase, as `leftovers` already compares paths). A registration whose folder is gone still counts: git lists it as `prunable`, with its `HEAD` and `branch` lines. Two cases the contract test pins:

- **A branch with no worktree** (`branch` set, no registration): `head` `null`, `dirty` `null`, `inMain` computed for `branch`, `skip` `"no longer a registered worktree"`. A plain folder that git doesn't list gets the same `head`, `dirty` and `skip`.
- **A registered worktree whose folder is gone** (`folder` `null`, `branch` set): `head` is its branch, and `dirty` is `true`, because `git status` can't run in a missing folder and a failure counts as dirty, as the sweep counts it (`register.ts:1329`, `dirty = !status.ok || status.out !== ''`). Its `skip` is `"uncommitted changes"`, unless an earlier check in the table below gives another reason.

**`dirty`.** The command is `git status --porcelain --untracked-files=all`, run with the folder as cwd through `git_out`, so `GIT_OPTIONAL_LOCKS=0` keeps it from refreshing the index. Untracked files count, as they do at `register.ts:1014`. The sweep itself runs `git status --porcelain` without the flag (`register.ts:1328`); both print something for the same worktrees, so the boolean is the same. retro computes `dirty` for a locked worktree too; the sweep doesn't (it leaves `dirty` false when locked), but `locked` is checked first, so `skip` is the same.

**`inMain`.** The ref is `head` when `head` is a branch name, else `branch`, else there is none and `inMain` is `null`. With a ref, retro runs these in the main checkout, in this order, and stops at the first that holds; this is `inMainBy` at `register.ts:1261-1272`:

1. `"ancestor"`: `git merge-base --is-ancestor <ref> HEAD` exits 0.
2. `"tree"`: `git merge-tree --write-tree HEAD <ref>` exits 0 and its first output line equals `git rev-parse HEAD^{tree}` (`mergesToSameTree`, `register.ts:1206-1211`). Exit 1, any other exit, or no `HEAD^{tree}` means this check doesn't hold.
3. `"cherry"`, only when the entry is not locked and `dirty` is not `true` (the sweep's `wt.locked === undefined && !dirty`, `register.ts:1333`): `git cherry HEAD <ref>` exits 0 and prints at least one line, every line starting `- ` (`cherryMerged`, `register.ts:533-537`).

The ref is passed by its short name, as register.ts passes it.

`git merge-tree --write-tree` writes the merged tree's objects into the object store. retro stays read-only, so it runs that one command with `GIT_OBJECT_DIRECTORY` set to a fresh `tempfile.mkdtemp()` dir and `GIT_ALTERNATE_OBJECT_DIRECTORIES` set to the absolute path of `<git common dir>/objects` (git's quarantine pair), and removes the temp dir before it returns. The repo's refs, worktree list and loose-object count are the same before and after a run; the contract test checks all three (`git for-each-ref`, `git worktree list --porcelain`, `git count-objects -v`).

**The main checkout's branch.** `git branch --show-current` in the main checkout, read once per run. Empty output or a failure means it is on no branch.

**`skip`.** retro applies `decideSelfClean`'s checks (`register.ts:734-750`) in its order, skipping the ones it can't reproduce, and the first that applies gives `skip`. `<head>` is the entry's `head`; `<reason>` is the text after `locked ` on the porcelain `locked` line, or `locked` when the line is bare (`parseWorktrees`, `register.ts:581`).

| Order | Check (register.ts line) | Applies when | `skip` string |
| --- | --- | --- | --- |
| 1 | `isSession` (736) | can't reproduce; skipped | |
| 2 | `!registered` (737) | not registered | `no longer a registered worktree` |
| 3 | not a worktree-* branch (738) | `head` starts `detached ` | `not on a worktree-* branch (detached)` |
| 3 | | `head` is a branch not starting `worktree-` | `not on a worktree-* branch (<head>)` |
| 4 | `active` (739) | can't reproduce; skipped | |
| 5 | `locked` (740) | the porcelain entry has a `locked` line | `locked (<reason>)` |
| 6 | `dirty` (741) | `dirty` is `true` | `uncommitted changes` |
| 7 | `membersRunning` (742) | can't reproduce; skipped | |
| 8 | `inMain === undefined` (743) | `inMain` is `null` | `<head> is not in the main checkout's HEAD yet` |
| 9 | `mainBranch === undefined` (745) | the main checkout is on no branch | `the main checkout is on no branch (detached or unreadable)` |
| 10 | ancestor (746) | `inMain` is `"ancestor"` | `passes every check retro can see` |
| 11 | crew branch in main (748) | the main checkout's branch starts `worktree-` | `<head> is not in the main checkout's HEAD yet` |
| 12 | (749) | otherwise | `passes every check retro can see` |

`passes every check retro can see` is the one fixed string for an entry that clears every check retro can see. It means the next sweep would remove it, unless one of the checks retro can't see holds.

**What retro can't see.** Four facts the sweep uses come from places retro doesn't read, so `skip` never says them:

- `isSession` (`register.ts:736`): the session's own checkout. The sweep itself always passes `false` (`register.ts:1344`), since an `agent-<id>` folder is never the session's checkout.
- "its agent has not stopped yet" (`register.ts:739`): from the agent's transcript meta and the `active` entries of `slots.json` (`register.ts:1314-1323`).
- "a member of it is still running" (`register.ts:742`): from the other agents' transcript metas (`membersRunning`, `register.ts:391`, called at 1332).
- the checkout the merge ran in (`isRef`, `register.ts:1258`, used at 1311): the sweep never removes it, and retro doesn't know where the last merge ran.

The leftovers contract forbids reading `slots.json`, and retro never reads transcripts (P24).

**A detached leftover.** Its `skip` is `not on a worktree-* branch (detached)`: what `decideSelfClean` would say. The sweep never asks it: it drops a worktree not on a `worktree-*` branch at `register.ts:1324`, before `decideSelfClean` runs, and logs nothing. retro's string is the reason the sweep's silence stands for.

**`"not recorded"`.** The whole key is `"not recorded"` whenever `leftovers` is, by the same rules (no event file, a dir not shaped `<git common dir>/foundry/<session>`, or `git for-each-ref` failing), and also when `git worktree list --porcelain` fails. When `leftovers` is a dict with `count` 0, `leftoverDetails` is `[]`. Inside an entry a git failure is never `"not recorded"`: a failed `status` makes `dirty` `true`, a failed `merge-base`, `merge-tree` or `cherry` means that `inMain` check doesn't hold, and a failed `branch --show-current` means no branch.

**The git commands retro may run for this key**, all with `GIT_OPTIONAL_LOCKS=0` through `git_out`: `worktree list --porcelain`, `status --porcelain --untracked-files=all`, `merge-base --is-ancestor`, `rev-parse HEAD^{tree}`, `merge-tree --write-tree` (quarantined as above), `cherry`, `branch --show-current`. None changes a ref, the index, a worktree or config. retro.py's docstring, which says "rev-parse and for-each-ref only", is updated by the wave-1 crew to name these.

**The source, and the drift risk.** The rules above copy `decideSelfClean` (`plugins/worktrees/hooks/register.ts:734-752`, worktrees 0.8.0, commit `588d77d`), the sweep's fact gathering (`register.ts:1244-1349`) and `parseWorktrees` (`register.ts:571-586`). retro never imports, calls or reads the worktrees plugin (repo ADR-0001, P1). When worktrees changes a reason string, its order or a check, retro's `skip` drifts from it silently. No cross-plugin test may catch that: a foundry test that reads `plugins/worktrees/` breaks P1. The guard is this section: a worktrees change to `decideSelfClean` is a reason to amend this ADR and retro in the same release, and the worktrees reviewer is the one who sees it.

### 2. The red team's start and end state

`agents/judge.md` red-team mode (now line 78) changes. The wave-1 crew `redteam-reset` writes the prompt; these are its literals.

- **Start.** The first step is `git reset --hard <sha>` in its own worktree, in place of `git checkout --detach <sha>`. The worktree stays on its `worktree-agent-<id>` branch, which then points at the crew head, so once the crew merges the branch is an ancestor of main and the sweep removes it with `-d`. If the reset fails, or `git status --porcelain --untracked-files=all` prints anything afterwards, it stops with the first line `REDTEAM: not run` and the reason. The literal `git checkout --detach` is gone from `judge.md`.
- **End.** Before it reports, the red team runs `git reset --hard <sha>` again and `git clean -fd` in its own worktree, then confirms `git status --porcelain --untracked-files=all` prints nothing.
- **Never commit.** It never commits, even when the worktrees hook tells it to commit. It discards the changes instead. The worktrees stop hook asks a dirty agent to commit (`register.ts:812`) and then commits the leftovers for it (`commitLeftovers`, `register.ts:1021`, called at 1853); for a red team that WIP commit would leave a branch that is never in main, which the sweep keeps forever as `... is not in the main checkout's HEAD yet`.
- **Probes.** It prefers temp dirs outside the worktree for probe files. A file in a gitignored path doesn't count as dirty either.

`agents/lead.md:64`'s red-team bullet no longer says the red team "checks out" the SHA: it says the red team first resets its own worktree to that SHA (`git reset --hard <sha>`).

The literals the wave-0 check `tests/redteam-reset.check.ts` pins, each a substring of `judge.md`'s red-team section (from the line starting `When your brief opens with the line \`Red team:\`` to the next `##` heading or the `REDTEAM: <n> findings` paragraph):

| Literal | Present or absent |
| --- | --- |
| `git reset --hard <sha>` | present, at least twice (start and end) |
| `git clean -fd` | present |
| `git status --porcelain --untracked-files=all` | present |
| `even when the worktrees hook tells you to commit` | present |
| `discard` | present |
| `temp dir` | present |
| `git checkout --detach` | absent from the whole file |

In `lead.md`, the bullet starting `- **Red team, when the brief says yes.**` doesn't contain `checks out` and does contain `git reset --hard <sha>`.

### 3. The retro skill's root-cause step

`skills/retro/SKILL.md` gets a new section between "Report the counts" and "Propose changes", headed exactly `## 3. Find the causes`; "Propose changes" becomes `## 4.` and "Write only what the owner approves" `## 5.`. The description keeps "why crews stalled or got rejected"; this section is the body step behind it. The wave-1 crew `retro-causes` writes it; these are its rules and literals.

- **Anomalies.** Five kinds, by these exact names: `leftover`, `judge fail`, `stall`, `overrule`, `spent budget`. One line per anomaly: each `leftoverDetails` entry; each judge file whose first line starts `VERDICT: FAIL`; and, per run, a non-zero `stalls` count (`agent` or `idleLead`), a non-zero `decisions.overruled` and a non-zero `budgetsSpent`.
- **Not an anomaly.** Spawns over `estAgents` never get a line. Sentence: `Spawns over estAgents are not an anomaly; give them no CAUSE line.`
- **Form.** Each line is exactly `CAUSE: <anomaly> | <evidence> | <fix location>`. `<anomaly>` starts with one of the five names (for example `leftover a0123456789abcdef`, `judge fail auth-judge-2`). `<evidence>` is a fact from an allowed source, such as the entry's `skip` string or a judge finding line. `<fix location>` is a file and a key, line or section. When the allowed sources don't show a cause, the line is `CAUSE: <anomaly> | not found | none`.
- **Sources.** Sentence: `Its only sources are git, the disk, decisions.md, the judge files' VERDICT: and finding lines, and the plugin's own files.` A finding line is a line under a judge file's `## Findings` heading that starts `- `.
- **P24.** Sentence: `It never reads message, prompt or report bodies (P24).` The judge files' `VERDICT:` and finding lines are the only report text it reads.
- **Bound.** One `CAUSE:` line per anomaly, and `at most 3 reads per anomaly` (a git command, a file read or a grep each count as one).
- **Plugin-level causes.** A cause whose fix location is a file of the foundry plugin, not of the project, has `<fix location>` starting `plugin: `. Sentence: `Plugin-level causes go to the owner as plugin findings and are never written (ADR-0005 section 1).` Only project files (`.claude/foundry.json`, prompt-override files) can become section 4 proposals.

The wave-0 check `tests/retro-cause.check.ts` pins in `SKILL.md`: the heading `## 3. Find the causes`, before `## 4. Propose changes`; the literal `CAUSE: <anomaly> | <evidence> | <fix location>`; each of the five kind names in backticks in that section; the not-an-anomaly sentence; `CAUSE: <anomaly> | not found | none`; the sources sentence; the P24 sentence; `at most 3 reads per anomaly`; `plugin: `; the plugin-level sentence; and that the frontmatter description still contains `why crews stalled or got rejected`.

## Seams

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| retro's `leftoverDetails` | `scripts/retro.py` | the `foundry:retro` skill's root-cause step | section 1 | `tests/test_contract_leftover_details.py` |
| retro's top-level key set | `scripts/retro.py` | the `foundry:retro` skill | `TOP_KEYS` plus `leftoverDetails` | `tests/test_contract_retro.py:23`, `tests/test_contract_retro_050.py:69` |
| The red team's start and end state | `agents/judge.md`, `agents/lead.md` | the red-team judge; worktrees' sweep (it removes the clean branch) | section 2 | `tests/redteam-reset.check.ts` |
| The root-cause step | `skills/retro/SKILL.md` | the model running `/foundry:retro` | section 3 | `tests/retro-cause.check.ts` |

## Consequences

- A leftover now comes with the reason it stayed, read from git, the disk and the main checkout only. retro still never reads `slots.json`, transcripts or the worktrees plugin.
- retro writes one temp dir (the merge-tree quarantine) and removes it. The repo and the foundry dir are unchanged. If the quarantine pair ever lets an object through, the contract test's `git count-objects -v` check fails.
- retro's `skip` can drift from worktrees' `decideSelfClean` without any test failing (section 1, "The source, and the drift risk").
- A red team's worktree is removed by the sweep at the first merge after it stops, once its branch is in main. A rejected crew never merges, so its red team's worktree stays, with `skip` `worktree-agent-<id> is not in the main checkout's HEAD yet`; that is correct, not a leak.
- The `passes every check retro can see` string can stand for an entry the sweep still keeps, because of a check retro can't see; the root-cause step says so in its evidence rather than guessing.
- Not done here, out of scope: a sweep log line for a detached worktree at `register.ts:1324`, and the dead `forget` field of `SelfCleanPlan` (set at `register.ts:736-737`, read nowhere). Both are worktrees changes.
