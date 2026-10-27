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
