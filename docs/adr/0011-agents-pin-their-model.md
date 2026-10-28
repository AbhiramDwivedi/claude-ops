# ADR-0011: agent types pin their model, so picking the agent picks the model

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

The failure these plugins were built for is agents drifting onto the main thread's model after compactions drop "Opus for the hard parts" from the instructions (root `README.md`, "Why these exist").

## Decision

- Every agent definition the plugins ship sets `model` in its frontmatter, by family alias: kit's `builder` (sonnet), `reviewer` (opus), `test-writer` (sonnet), `scout` (haiku); foundry's `lead` (opus, effort medium), `judge`, `cynic` and `architect` (opus, effort high), `writer` (opus), `devops` (sonnet). Read-only agents also restrict `tools` (`scout`: Read, Grep, Glob).
- foundry's hooks refuse any `Agent` call inside a crew that sets no `model` or `effort`, or sets effort `max`.
- session-models shows each live agent's model and effort, so drift is visible.

## Consequences

- An agent type's name stands for its role, model and tool access together. Other plugins use that: worktrees and kit's stop gate treat `scout` and `reviewer` as read-only by name (ADR-0001).
- The aliases follow Claude Code's current model for each family, not a dated model ID. That is deliberate: Claude Code resolves the alias, and a dated ID would need a release for each new model.
- A project agent that kit's `/kit:revise` proposes pins its model the same way (`plugins/kit/skills/revise/SKILL.md`, section 3).

## Amendment, 2026-10-27: the effort ladder

Status: accepted. The owner approved foundry run 3's plan at 2026-10-28T00:31:42Z, and this amendment is part of that plan (its wave-0 design crew wrote it). The decision above stands; this section adds the effort each role runs at.

### Context

The decision above pinned `judge`, `cynic` and `architect` at effort `high` in frontmatter, and foundry's lead and run skill set the judge one level above the strongest builder, at least `high`, and the red team at `high`. `high` was meant as an escalation route, not a default. PR #18 (commit `9ab68c0`, merged at `80d4ccd`, foundry 0.4.3) moved these to `medium`: the `judge`, `cynic` and `architect` frontmatter, the lead's judge and red-team defaults (`plugins/foundry/agents/lead.md:101` and its red-team bullet), and the run and init skills' `effort` values (`plugins/foundry/skills/run/SKILL.md`, `plugins/foundry/skills/init/SKILL.md`). This amendment records that change and fixes the rest of the ladder.

The interface that couldn't take it: the decision above names each role's model and, for foundry's Opus agents, one effort; it has no rule for when effort may rise. So PR #18 left a way up that needs no owner: the lead may raise a judge "when an Opus-high builder needs judging" (`lead.md:101`, `run/SKILL.md:141`).

### Decision

- **Default.** Judges, red teams, reviewers and writers run at Opus `medium` (a writer may also run on Sonnet, see below). `high` and `xhigh` are escalation routes, never defaults, and for these four roles they are taken only on the owner's explicit call: the owner says so in their own message, and the goal file or the foreman's brief cites it. A lead never raises one of these roles on its own judgment, including to judge an Opus-high builder; the `lead.md:101` and `run/SKILL.md:141` clause that allows that goes.
- **Judge.** The floor is Opus `medium`. A re-judge after a FAIL is a fresh `foundry:judge`, also at `medium`.
- **Spent repair budget.** When a crew's repair budget (foundry ADR-0004) is spent, the crew goes `BLOCKED`. Nothing moves up an effort level to buy another round: no higher judge, no higher builder.
- **Builders.** The builder ladder in `lead.md` section 7 (Sonnet, then Opus `medium`, `high`, `xhigh`, on two failed fixes of the same check) is unchanged. It applies to builders fixing a failing check, not to judges, red teams, reviewers or writers.
- **Writer.** `foundry:writer` runs on Sonnet, or on Opus at effort `low` or `medium`.
- **kit:reviewer.** Its frontmatter gains `effort: medium` (kit 0.3.0). A crew never starts it beside a foundry judge on the same head: the judge is that head's review.
- **Red team.** Only for a crew with a high-impact path: hooks, stored schemas and data shapes, auth or money code. It runs at Opus `medium`. This rule replaces the "high-impact paths" list in `run/SKILL.md:142` (auth, money, migrations, CI or lockfiles) as the red-team trigger, and having a red team no longer raises anyone's effort.
- **The hook half** is foundry ADR-0004 (`plugins/foundry/docs/adr/`, written by the same design crew): the gate that refuses the main session's `foundry:*` Agent calls with no `model` or `effort` on plans with `version >= 2`, and the rule that a PASS survives a rebase only when the patch is unchanged (`git patch-id --stable`) and the checks pass again. This amendment doesn't restate either.
- **Retro's target.** In `/foundry:retro`'s `spawns.byModelEffort`, the target share for `opus/high` plus `opus/xhigh` is zero, unless the owner escalated or a builder climbed the ladder above. foundry ADR-0004 fixes how retro reports it.

### Consequences

- A run costs less by default: no role starts above `medium` without a builder's failed fixes or the owner's word.
- A crew whose judge can't settle a head at `medium` within its repair budget stops and asks, instead of spending more tokens on the same head. The owner decides whether to escalate.
- Wave 1 of run 3 carries this into the prompts: the lead's and run skill's raise-the-judge clause, the red-team trigger, the writer's effort, and kit:reviewer's frontmatter.
