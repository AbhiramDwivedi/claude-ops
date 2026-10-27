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
