---
name: init
description: Checks that the project has a foundry architecture doc and, when it doesn't, has the foundry:architect agent write one (principles, module map, ADRs for decisions already in the code) and record it in .claude/foundry.json. Use when the person runs /foundry:init, asks to set up foundry or write the project's architecture doc, or when a foundry run finds no architecture doc.
---

# foundry init

You check whether this project has an architecture doc that foundry can use. If it doesn't, you have the architect write one, show the owner what it wrote, and stop. You don't write the doc yourself and you don't edit source.

The person who ran `/foundry:init`, or who started the run that called this skill, is the owner.

## 1. Check for the architecture doc

1. Find the repo root: `git rev-parse --show-toplevel`, run in the session's working directory. Call it `<repo>`.
2. Read `<repo>/.claude/foundry.json`.
3. The doc is **present** when that file exists and the `architecture` key it holds names a file that exists, read as a path relative to `<repo>`.
4. The doc is **missing** when there is no `<repo>/.claude/foundry.json`, or the file it names doesn't exist.
5. If `foundry.json` exists but isn't valid JSON, or has no `architecture` key, tell the owner what's wrong with it and stop. The owner may have added keys to it by hand (`agentCap`, `maxParallelCrews`, `merge`, `target`), so don't have it rewritten.

If the doc is present, tell the owner: "Architecture doc: `<path>`, ADRs in `<adr>`, from `.claude/foundry.json`." Then stop.

## 2. Look for an architecture doc the repo already has

When the doc is missing, look for one the project already keeps, so the architect extends it instead of writing a second one. Search `<repo>` with Glob for files named like `ARCHITECTURE.md`, `architecture.md` or `docs/architecture*`, and for an ADR folder (`docs/adr`, `docs/decisions`, `adr`). Skip `node_modules`, vendored code and build output. If `foundry.json` named a doc that no longer exists, note that too.

## 3. Start the architect in init mode

```
Agent({
  subagent_type: "foundry:architect",
  name: "architect-init",
  model: "opus",
  effort: "high",
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

## 4. Show the owner what the architect wrote, and stop

1. Run `git status --porcelain` in `<repo>` to list the files the architect created or changed.
2. Show the owner:
   - the architecture doc's path, and its list of principles and its module map;
   - each ADR's path and title;
   - the contents of `.claude/foundry.json`;
   - anything the architect's hand-back flags as uncertain.
3. Tell the owner the files are not committed. Crews work in git worktrees, which see only committed files, so a foundry run needs these files committed before its crews start.
4. Stop. Don't commit. When a foundry run called this skill, the run skill says what happens next; otherwise don't start a run.

The owner can then edit the doc, or add the optional keys to `.claude/foundry.json` by hand. Each has a default: `agentCap` 40, `maxParallelCrews` 4, `merge` `sequential`, `target` the current branch.
