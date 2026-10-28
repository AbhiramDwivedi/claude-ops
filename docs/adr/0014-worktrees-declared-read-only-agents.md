# ADR-0014: worktrees skips the worktree for agent types kit's manifest declares read-only

Status: accepted, 2026-10-27
Proposed on 2026-10-26 by foundry run 2's design crew. It applies [ADR-0012](0012-extension-framework.md) and was accepted with it on 2026-10-27.

## Context

worktrees gives every `Agent` call a worktree unless the call sets `isolation` or the type is in its no-isolate set (`plugins/worktrees/hooks/register.ts`): the `READ_ONLY_AGENTS` constant (line 8: `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `scout`, `reviewer`) plus the user's `noIsolateAgents` and its deprecated alias `readOnlyAgents` (`register`, line 1204). `needsWorktree` (lines 55-60) matches the full type or its bare name.

The interface that can't take the work: neither input lets the plugin that defines an agent type say it is read-only. The constant is worktrees' own source; the setting is the user's. A caller can't opt out on the call either, because the Agent tool's `isolation` takes only `worktree` or `remote` (`index.d.ts:555`). So `foundry:judge` and `foundry:cynic` (`tools: Read, Grep, Glob, Bash`) each get a worktree, a setup-script run and a port slot.

## Decision

- On each `Agent` call that would otherwise get a worktree, worktrees reads `<main checkout>/.claude/kit/manifest.json` (the `mainRoot` that `repoAt` computes, line 677, which is where it already reads `.worktreeinclude`). The file's contract is `plugins/kit/docs/manifest.schema.json` ([ADR-0013](0013-kit-manifest.md)). It is read on every such call, not cached, so a declaration made mid-session takes effect on the next call.
- A type gets no worktree when its full name equals, case-folded as today, the `name` of a manifest agent with `readOnly: true`. A declared name matches only in full: a declared `foundry:judge` covers `foundry:judge`, not `judge` or `other:judge`. Bare-name matching stays for `READ_ONLY_AGENTS` and `noIsolateAgents` only, as they are today (P17).
- Declarations only add to the no-isolate set. A manifest entry with `readOnly: false` never takes a type out of `READ_ONLY_AGENTS` or `noIsolateAgents`.
- An explicit `isolation` on the call still wins, as it does today (the handler's first line).
- The manifest is the only declaration source. worktrees reads no other project file for this (P9). Its trust level is that of `.claude/worktree-setup.*`, which worktrees already runs from the same checkout: anyone who can write the manifest can already write the setup script.
- **Fail open to today's behaviour.** When the file is absent, worktrees behaves as 0.5.0 and logs nothing. Absent means `fs.exists` returns false, or the read throws an error whose message contains `ENOENT` (the file went between the check and the read). The handler checks `fs.exists` first and reads only when it returns true. When it is unreadable (any other read error, such as `EACCES`), isn't JSON, isn't an object, has a `version` other than 1, or has no `agents` array, worktrees declares no types and logs `worktrees: kit manifest unreadable, ignoring it: <error>` to the debug log (P5, P7). An entry whose `name` isn't a string matching the schema's pattern, or whose `readOnly` isn't `true`, adds nothing; the rest still count.
- The decision is an exported pure function over the file's text (P3); the handler does the read. The worktrees crew names it.
- The README's no-isolate section and contract table name the manifest as an input. worktrees goes to 0.6.0 (P16).

## Seams

The contract test is `plugins/worktrees/tests/contract.test.ts`. It drives the `classic.PreToolUse` handler through `$.tool.call`, as `tests/hooks.test.ts` does, with `process.run` mocked so `git rev-parse --git-common-dir` prints `C:/r/.git` and `--is-inside-work-tree` prints `true`, and `fs.exists` and `fs.read` served from a map holding `C:/r/.claude/kit/manifest.json`. It imports nothing that doesn't exist yet.

1. With a manifest declaring `foundry:judge` read-only, a `foundry:judge` call reaches the engine with no `isolation`; so does `Foundry:Judge`.
2. With the same manifest, `judge`, `other:judge` and `kit:builder` (declared `readOnly: false`) each get `isolation: "worktree"`.
3. An explicit `isolation: "worktree"` on a `foundry:judge` call stays `"worktree"`.
4. With the manifest absent, with `{not json`, with `"version": 2`, and with `fs.read` throwing, `foundry:judge` gets `isolation: "worktree"` (today's behaviour) and the call is not denied. In the three broken cases the debug log holds a line starting `worktrees: kit manifest unreadable, ignoring it:`.

## Consequences

- foundry needs no code in worktrees: once foundry init has kit declare its types ([foundry ADR-0002](../../plugins/foundry/docs/adr/0002-kit-manifest-and-config.md)), its judges and cynics run in the session's checkout.
- Without kit there is no manifest and no change. The owner's route is `noIsolateAgents: foundry:judge,foundry:cynic`.
- One extra `fs.read` per isolated `Agent` call. A `git rev-parse --git-common-dir` is added to the handler unless the crew reuses one it already makes.
- A type wrongly declared read-only edits the main checkout. Exact matching and kit's approval step are the guard; worktrees can't check an agent's tools (`agent.offer` exposes none, ADR-0012).

## Amendment, 2026-10-27: worktrees ignores read-only declarations of editing types

Status: accepted. The owner approved foundry run 3's plan at 2026-10-28T00:31:42Z, and this amendment is part of that plan (its wave-0 design crew wrote it). The decision above stands except where this section narrows it.

### Context

The decision above gives no worktree to any type a `readOnly: true` entry names in full. A manifest written by kit 0.2.0, or by hand, can name a type that edits files, and that type then edits the main checkout. At plan time, `declaredReadOnly` (`plugins/worktrees/hooks/register.ts:74-92`) returned all seven types below as read-only. kit 0.3.0 stops writing such entries ([ADR-0013](0013-kit-manifest.md), amendment of 2026-10-27), but it reads existing files tolerantly, so the reader has to refuse them too. The interface that changes is the decision's second bullet: a full-name `readOnly: true` entry no longer always means no worktree.

### The refused list

This line is the list. ADR-0013 carries the same line, byte for byte; worktrees keeps its own copy in code, since plugins share no code (P1).

Refused read-only types: general-purpose, kit:builder, kit:test-writer, foundry:architect, foundry:devops, foundry:lead, foundry:writer

### Decision

- `declaredReadOnly(text)` never puts a refused type in `types`. An entry is refused when its `name` (one the schema pattern allows, with `readOnly: true`), folded with the existing `asciiLower`, equals a list name. The match is full-name only: `Foundry:Lead` and `GENERAL-PURPOSE` are refused, `lead` and `plugin:general-purpose` are not.
- Its return type becomes `{ types: Set<string>; refused: string[]; error?: string }`. `refused` is always present: the `name` of each refused entry as written in the file, in file order, and `[]` when there are none or when `error` is set. The constant is exported as `REFUSED_READ_ONLY_TYPES`, the seven names in the list's order, lower-case.
- An unset or empty `subagent_type` is `general-purpose`, as today (`register.ts:58`), so it gets a worktree even when the manifest declares `general-purpose` read-only. So does `General-Purpose`.
- Other declarations still count: a manifest that declares `foundry:judge` and a refused type gives `foundry:judge` no worktree.
- When `refused` is non-empty, the handler writes one line to the debug log (P7), exactly:

  `worktrees: kit manifest declares editing types read-only, ignoring them: <names>`

  with `<names>` the `refused` names joined by `, `. It writes it on each call that reads the manifest, as the manifest is read on each call. The call itself isn't denied.
- `noIsolateAgents`, its alias `readOnlyAgents` and `READ_ONLY_AGENTS` are untouched: the owner's own setting can still list any type, `general-purpose` included.
- worktrees goes to 0.7.0 (P16): a manifest that 0.6.0 honoured now gets worktrees for some types.

### Seams added

`plugins/worktrees/tests/contract.test.ts` gains these cases, driven through the handler as the decision's seams are. It may import `declaredReadOnly` from `hooks/register.ts`, which already exists. It names every refused type literally.

5. With a manifest declaring all seven refused types and `foundry:judge` at `readOnly: true`, a call of each refused type, of `General-Purpose`, and with no `subagent_type`, reaches the engine with `isolation: "worktree"`; a `foundry:judge` call still gets none. The call is not denied.
6. The same run's debug log holds a line starting `worktrees: kit manifest declares editing types read-only, ignoring them: ` that names each refused entry.
7. `declaredReadOnly` on that manifest's text returns `types` without any refused name and with `foundry:judge`, and `refused` equal to the seven names in file order; a manifest entry `Foundry:Lead` lands in `refused` as `Foundry:Lead`. On a broken manifest (`{not json`), `refused` is `[]` and `error` is set.

## Amendment, 2026-10-28: the main checkout comes from the project dir, and the isolation path logs

Status: accepted. The owner approved foundry run 4's plan at 2026-10-28T15:11:50Z, and this amendment is part of that plan (its wave-0 design crew wrote it, in [ADR-0015](0015-agent-worktree-cleanup.md), items 4 and 13). The decisions above stand except where this section narrows them.

- The main checkout whose `.claude/kit/manifest.json` worktrees reads is the one ADR-0015 item 4 resolves: `CLAUDE_PROJECT_DIR`, else the event's `cwd`, else `$.session.cwd()`, each tried with `git rev-parse --path-format=absolute --git-common-dir`. `declaredByKit` no longer runs git with no `cwd` (`plugins/worktrees/hooks/register.ts:727`, as of worktrees 0.7.0). A repo that was not found is never cached, so a spawn from inside the git dir followed by one from the main checkout both read the manifest.
- The manifest rules (full names only, refused types ignored, absent means silent, unreadable means logged) don't change. A manifest that declares a type now also logs `worktrees: isolation skipped <type>: kit manifest declares it read-only`, one of the isolation path's skip lines in ADR-0015.
- `noIsolateAgents` stays untouched. It is the route for judges and cynics (ADR-0015 item 7); no new declaration source is added.
- The seams above hold. Their mocks answer `--git-common-dir` for any `cwd`, so they still pass.
