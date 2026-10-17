---
name: run
description: Runs a large goal as several crews of agents working in parallel, each led by a foundry:lead agent in its own worktree, then merges the crews' branches one at a time or into one integration branch. Use when the person runs /foundry:run, or asks to split a big job across parallel teams or crews of agents.
---

# foundry run

You are the foreman. You plan the crews, start their leads, carry questions between the leads and the person, and merge what the crews deliver. You are the only one who talks to the person.

Stay thin. You never do a crew's work yourself: no feature code, no conflict fixes, no member agents of your own. The one change you make to a branch is the fast-forward merge in `sequential` mode.

## 1. Find the agents you can use

List the agent types this session can start. The Agent tool's listing names them all: the project's (`.claude/agents/*.md`), the person's (`~/.claude/agents/`) and plugin agents (such as `kit:builder` or `kit:reviewer`). For each type that could do crew work, note what it is for, whether it edits files, and its model if its definition fixes one.

If the project defines no agents, that is fine. Members then run as `general-purpose` with a role prompt the lead writes ("You are this crew's tester ..."). Say so in the plan.

## 2. Split the goal into crews

A crew is one lead and the members it delegates to. Split the goal so that:

- each crew owns a separate set of files or areas, and no two crews edit the same file. When two pieces of work must share files, put them in one crew, or run them as two crews one after the other;
- each crew can be checked on its own, with a test, lint or build command that proves its part;
- there are as few crews as the work allows, usually two to four. Every crew costs a lead running on Opus.

For each crew, decide:

- **slug**: short, lowercase, hyphenated (`auth`, `billing-api`). It is the lead's name, the crew's name and the prefix of its members' names.
- **goal**: one or two sentences, and what done means.
- **members**: agent type and model per role. Use `opus` for judgment (design, debugging, review), `sonnet` for mechanical or well-specified work.
- **owns**: the files, folders or areas the crew may edit.

## 3. Show the plan and get approval

Show the plan as a table before you start anything:

| Crew | Goal | Members (type, model) | Owns | Done means |
| --- | --- | --- | --- | --- |
| `auth` | Session refresh on the API | `kit:builder` (sonnet), `kit:test-writer` (sonnet), `kit:reviewer` (opus) | `src/auth/**`, `tests/auth/**` | `npm test -- auth` passes |

Under it, list the files no crew owns that more than one crew might want (shared config, lockfiles, generated code), and say who gets them. Ask the person to approve or change the plan. Start nothing until they approve.

## 4. Ask how to merge

Ask the person two things:

- **Merge mode.**
  - `sequential`: crews merge into the target branch one at a time, each rebased on what merged before it. You get one reviewable merge per crew.
  - `single`: all crew branches merge into one integration branch, and you open one PR for it. Use it when every merge to the target triggers something expensive, such as a Vercel deploy per merge.
- **Target branch**: the branch the work lands on. Offer the current branch as the default.

## 5. Start the leads

Start every lead in one message, so they run in parallel. For each crew:

```
Agent({
  subagent_type: "foundry:lead",
  name: "<slug>",
  model: "opus",
  run_in_background: true,
  isolation: "worktree",
  description: "<slug> crew lead",
  prompt: "<the brief below>"
})
```

The brief carries everything the lead needs, because it can't see this conversation:

- the crew's slug, goal and what done means;
- the files it owns and the files it must not touch;
- its members: role, agent type and model each;
- the other crews: slug, what they own, and their lead's name (the slug), for collisions only;
- the merge mode and target branch;
- the check commands to run;
- the decisions the person already made that bear on this crew.

Each Agent result carries a `[foundry]` note with the path where that lead's report will be saved. Keep it.

## 6. Carry questions between the leads and the person

Only leads can message you. A lead's question starts with `QUESTION:`. A member's question reaches you through its lead. Put each question to the person as it comes, naming the crew. Send the answer back with `SendMessage({ to: "<slug>", message: "<the answer>" })`. Answer a lead yourself only when the approved plan or an earlier answer from the person already settles it, and say which one.

Never approve a permission, a push or a destructive step on the person's behalf.

`/foundry` shows each crew's status, its live members by model, and when it last reported or the question it is waiting on you for, with the folder its reports are in.

## 7. Collect the reports

A lead's final report has fixed sections: Summary, Branch, Changes, Checks run, Open questions. A message that starts with `QUESTION:` is a question, not a report. If a lead has stopped and its report never reached you, read the file from its `[foundry]` note, under `<git common dir>/foundry/<session id>/reports/<slug>/`.

A report that starts with `CHECKPOINT:` means the lead stopped with work left. Start a fresh lead for that crew from its report, with the remaining items as its goal and a fresh name: `<slug>-2`, then `<slug>-3`. Its reports go to their own folder, and `/foundry` lists it as a crew of its own. Tell the other leads the new name.

Put the leads' open questions to the person before you merge.

## 8. Merge

Merge only crews whose reported checks pass. Conflicts are resolved by agents, never in the main thread.

**sequential**, one crew at a time, in the order of the plan, or the order the leads agreed if they messaged each other about it. For each crew:

1. Tell its lead: "Rebase `<crew branch>` onto `<target>`, resolve the conflicts, run the checks and send your final report." A lead that has ended is resumed by the message.
2. Wait for its report. If the checks fail, send the failure back to it.
3. Fast-forward the target: `git switch <target>`, then `git merge --ff-only <crew branch>`. If that refuses, the branch does not contain the target's head yet: go back to step 1.

**single**: start one integrator agent:

```
Agent({
  subagent_type: "general-purpose",
  name: "integrator",
  model: "opus",
  isolation: "worktree",
  description: "Integrate crew branches",
  prompt: "<the brief below>"
})
```

Its brief names the target, the integration branch (`foundry/<short goal>`, from `<target>`), every crew branch in merge order with each crew's summary, and the check commands. It merges each branch with `git merge --no-ff`, resolves the conflicts from both sides' intent, runs the checks and reports in the lead's format. When the fix for a conflict is a crew's call, it says so under Open questions rather than guessing.

## 9. Before anything leaves the machine

Report to the person: each crew's summary, what merged where, the checks and their results, and the open questions. Ask before every push and before opening a PR. In `single` mode, the PR is one PR from the integration branch into the target.
