---
name: init
description: Checks that the project has a foundry architecture doc and, when it doesn't, has the foundry:architect agent write one (principles, module map, ADRs for decisions already in the code). Then builds on kit's manifest when the project has one, never setting kit up itself, and proposes the 0.4.0 keys of .claude/foundry.json (roles, deploy, writingSkill, promptOverrides), writing only the ones the owner approves. Use when the person runs /foundry:init, asks to set up foundry or write the project's architecture doc, or when a foundry run finds no architecture doc.
---

# foundry init

You check whether this project has an architecture doc that foundry can use. If it doesn't, you have the architect write one and show the owner what it wrote. Then you read kit's manifest, propose the rest of `.claude/foundry.json`, and write only what the owner approves. You don't write the doc yourself and you don't edit source.

The person who ran `/foundry:init`, or who started the run that called this skill, is the owner.

The design is foundry's ADR-0002 (`<this skill's base dir>/../../docs/adr/0002-kit-manifest-and-config.md`). Read it if a case here isn't clear.

## 1. Check for the architecture doc

1. Find the repo root: `git rev-parse --show-toplevel`, run in the session's working directory. Call it `<repo>`.
2. Read `<repo>/.claude/foundry.json`.
3. The doc is **present** when that file exists and the `architecture` key it holds names a file that exists, read as a path relative to `<repo>`.
4. The doc is **missing** when there is no `<repo>/.claude/foundry.json`, or the file it names doesn't exist.
5. If `foundry.json` exists but isn't valid JSON, or has no `architecture` key, tell the owner what's wrong with it and stop. The owner may have added keys to it by hand (`agentCap`, `maxParallelCrews`, `merge`, `target`, and from 0.4.0 the keys in step 6), so don't have it rewritten.

If the doc is present, tell the owner: "Architecture doc: `<path>`, ADRs in `<adr>`, from `.claude/foundry.json`." Then go to step 5.

## 2. Look for an architecture doc the repo already has

When the doc is missing, look for one the project already keeps, so the architect extends it instead of writing a second one. Search `<repo>` with Glob for files named like `ARCHITECTURE.md`, `architecture.md` or `docs/architecture*`, and for an ADR folder (`docs/adr`, `docs/decisions`, `adr`). Skip `node_modules`, vendored code and build output. If `foundry.json` named a doc that no longer exists, note that too.

## 3. Start the architect in init mode

```
Agent({
  subagent_type: "foundry:architect",
  name: "architect-init",
  model: "opus",
  effort: "medium",
  description: "Write the project's architecture doc",
  prompt: "<the brief below>"
})
```

Run it in the foreground and wait for its hand-back. The architect runs outside every crew, so the plugin doesn't save its report.

The brief's first line is `Mode: init`. After it, the brief gives:

- the repo root, `<repo>`, as an absolute path;
- the existing architecture doc and ADR folder you found in step 2, or "none found";
- when `foundry.json` exists and names a missing doc: that path, and that the file's other keys must stay as they are;
- what to write: the architecture doc (principles, module map, ADRs for the decisions already in the code) and `<repo>/.claude/foundry.json` with the keys `architecture` and `adr` only. An existing doc is extended, not replaced. With none, the doc goes to `docs/architecture.md` and the ADRs to `docs/adr/`.

## 4. Show the owner what the architect wrote

1. Run `git status --porcelain` in `<repo>` to list the files the architect created or changed.
2. Show the owner:
   - the architecture doc's path, and its list of principles and its module map;
   - each ADR's path and title;
   - the contents of `.claude/foundry.json`;
   - anything the architect's hand-back flags as uncertain.
3. If the architect wrote no `.claude/foundry.json`, or it fails step 1's checks, tell the owner, do step 5, and then go to step 8.

## 5. Build on kit's manifest

kit is optional. Decide on the manifest first, and only then look at the skill list.

1. Read `<repo>/.claude/kit/manifest.json`. It is **unreadable** when it isn't JSON, its `version` isn't `1`, or it fails kit's schema, `docs/manifest.schema.json` in the kit plugin's folder. Find it from kit's root: when `kit:init` is listed, its base directory (the Skill tool prints it when it loads; the skill list may show its path) is `<kit root>/skills/init`, so the schema is `<kit root>/docs/manifest.schema.json`. Otherwise check each dir in `CLAUDE_CODE_PLUGIN_DIRS`, then Glob under `~/.claude/plugins`. Validate it with the ajv command in step 7, with that schema and without `--errors=json`. If you can't find kit's schema, check the manifest by hand against the parts you read: `version` is `1`, and `agents` is an array whose entries each have a string `name`, a boolean `readOnly` and a string `declaredBy`.
2. It **declares foundry** when it is readable and its `agents` list has `foundry:judge` and `foundry:cynic` (names compared without case), each with `readOnly: true`.
3. Then do the first of these that fits:
   - **Readable and declares foundry:** use it for step 6. Say nothing about kit, whether or not `kit:init` is listed.
   - **Unreadable:** print `kit manifest unreadable, carrying on without it: <reason>` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest. Don't run `kit:init` over it, listed or not.
   - **Readable without the declarations, and `kit:init` is among the session's skills:** run it through the Skill tool, `Skill({ skill: "kit:init", args: "declare read-only: foundry:judge, foundry:cynic" })`. The project already has kit, so kit only shows the owner the declaration and writes it on approval. When it returns, read the manifest again. If it is now readable, use it for step 6, with or without the declarations; otherwise carry on without one. Don't run `kit:init` a second time.
   - **Missing, and `kit:init` is among the session's skills:** don't run `kit:init`. Setting kit up is a full repo scan with its own proposal (conventions, gate hooks, a checklist), and foundry needs none of it. Print `no kit manifest; foundry init carries on without one (run /kit:init on its own to set kit up)` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest, and don't ask the owner whether to run kit.
   - **`kit:init` isn't listed:** print `kit is not installed; foundry init carries on without a kit manifest (0.3.0 behaviour)` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest.
4. Whenever the manifest doesn't end up declaring `foundry:judge` and `foundry:cynic` read-only, also tell the owner: "worktrees still gives each judge and cynic its own worktree. To stop that, add `foundry:judge,foundry:cynic` to worktrees' `noIsolateAgents` setting."

## 6. Propose the 0.4.0 keys

The keys are declared in `foundry-config.schema.json`, at `<this skill's base dir>/../../docs/foundry-config.schema.json`. Read it. Every key is optional, and leaving one out keeps 0.3.0 behaviour. Propose only values that match its patterns, and only paths the current `foundry.json` doesn't have: never change or remove a key or value already there, at any depth, even one the schema rejects.

- `roles`: job (`build`, `test`, `review`, `search`, `docs`, `deploy`) to a full agent type. Take it from the manifest's `agents`, for example `build: kit:builder`, `test: kit:test-writer`, `review: kit:reviewer`, `search: kit:scout`. Map `docs` and `deploy` only to an agent that clearly does that job. Without a manifest, use only agent types the session lists that clearly fit. Never map `foundry:judge`, `foundry:cynic`, `foundry:lead` or `foundry:architect`.
- `deploy`: `{target, command, production}`, from what the repo shows (a deploy script, a `vercel.json`, `fly.toml`, a CI deploy job). Propose it only when the file has no `deploy` and the repo makes all three plain, and always as one unit: the owner approves or declines all three fields together. `production` is `true` when the command deploys to production.
- `writingSkill`: a writing skill the session lists, such as `technical-writer`.
- `promptOverrides`: foundry role (`lead`, `judge`, `cynic`, `writer`, `devops`, `architect`) to a file directly under `.claude/foundry/prompts/`. Propose one only for a file that already exists there, such as `.claude/foundry/prompts/judge.md`. The value is the path, never prompt text, and you don't create or edit the prompt files; they are the owner's.
- `repairBudget`: an integer of 0 or more, the number of fresh judges a crew may start after judge FAILs in one run (default 2). The architect copies it into a v2 `plan.json`. Propose it only when the file has no `repairBudget`; offer 2 and say that leaving it out also means 2.

Show the owner each proposed key with its value and where it came from, and ask which to write. Write only the approved ones. If there is nothing to propose, or the owner approves nothing, say so and go to step 8.

## 7. Validate, then write

1. Find the foundry dir from the `[foundry] dir: <path>` note the plugin adds at session start, or the `Foundry dir:` line `/foundry` prints. Don't derive it. If neither is there, tell the owner the foundry plugin isn't loaded, write nothing, and go to step 8.
2. Build the candidate: the current `.claude/foundry.json` with every key and value kept, plus the approved values. Keep the file's key order, put new keys at the end, and indent by two spaces. Write it to `<foundry dir>/scratch/foundry.candidate.json`. Write it with the Write tool. If the write is refused, whether by worktree isolation or by a declined approval, write nothing: say the write was refused, name the path, say init must run in the main session with that write allowed, and go to step 8. Never route around a refusal with another tool.
3. Validate it:

   ```
   npx -y -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats --all-errors --errors=json -s <foundry-config.schema.json> -d <foundry dir>/scratch/foundry.candidate.json
   ```

   If the validator can't run, tell the owner, write nothing, and go to step 8.
4. Give each error a path: its `instancePath`, plus `/<params.additionalProperty>` for an `additionalProperties` error or `/<params.missingProperty>` for a `required` one. A hand-written `roles.judge` is `/roles/judge`; a `deploy` without `production` is `/deploy/production`.
5. The paths you write are the leaf paths you add in this run, such as `/roles/build` or `/writingSkill`. An approved `deploy` adds all three of `/deploy/target`, `/deploy/command` and `/deploy/production`. Each error falls under one of three rules:
   - **At a path you write:** write nothing. `.claude/foundry.json` stays exactly as it was. Report the error with its path, and go to step 8.
   - **At a proper ancestor of a path you write** (the owner's value there can't hold your key, such as `roles: "x"` when you'd add `/roles/build`): drop every path you planned under it, keep the owner's value, and report both, as in `/roles: must be object; skipped /roles/build, /roles/test`. Build the candidate again without them and validate again from step 2. The root is an ancestor of every path, so a file that isn't a JSON object gets nothing written.
   - **Anywhere else:** it's the owner's (an unrelated key, or a sibling of yours such as a hand-written `/roles/judge` next to your `/roles/build`). Report it once by path, for example `/merge: must be equal to one of the allowed values` or `/roles/judge: undeclared, ignored`, keep it unchanged, and carry on. Never delete, rewrite or "fix" what the owner wrote.
6. When no errors are left but the owner's, and you still have paths to write, copy the candidate over the file in one step: `cp <foundry dir>/scratch/foundry.candidate.json <repo>/.claude/foundry.json`. If the copy is refused, apply the same rule: write nothing more, say it was refused, name `<repo>/.claude/foundry.json`, say init must run in the main session with that write allowed, and go to step 8. Otherwise tell the owner each path you wrote.

## 8. Tell the owner where things stand, and stop

1. Run `git status --porcelain` in `<repo>` again and list what this run created or changed: the architect's files, what `kit:init` wrote, and `.claude/foundry.json`.
2. Tell the owner the files are not committed. Crews work in git worktrees, which see only committed files, so a foundry run needs these files committed before its crews start.
3. Stop. Don't commit. When a foundry run called this skill, the run skill says what happens next; otherwise don't start a run.

The owner can then edit the doc, or add the optional keys to `.claude/foundry.json` by hand. Each has a default: `agentCap` 40, `maxParallelCrews` 4, `merge` `sequential`, `target` the current branch. A 0.4.0 key left out keeps 0.3.0 behaviour.
