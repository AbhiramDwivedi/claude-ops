# ADR-0008: hooks enforce what prompts can't be trusted to keep, and gating hooks fail open

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

The plugins' behaviour lives in two places: prompts (skills and agent definitions) and hooks. Long sessions wear instructions down (root `README.md`, "Why these exist"), so a rule that only a prompt states will sometimes be broken. A hook that blocks calls is also a risk: a bug in it can stop the user's session from working.

## Decision

- A rule that must hold every time is a hook; judgment stays in the prompt. foundry: the prompts decide what agents should do, and "the hooks refuse the calls that break the chain of command" (`plugins/foundry/docs/architecture.md`). Examples: foundry refuses crew `Agent` calls without `model` or `effort` and enforces its plan gates; subagent-limits refuses a subagent's tools past `stopAtK`; worktrees refuses an agent's stop while it owns a background shell; kit's gate scripts exit 2 to send lint or test failures back to the agent.
- A refusal says what to do instead, in text the agent can act on (`MODEL_REFUSAL`, `EFFORT_REFUSAL` in foundry; `refusal()` in subagent-limits).
- The hooks that refuse or rewrite other plugins' calls fail open: foundry wraps each handler in `.catch(failOpen)`, which logs to the debug log and lets the call through; worktrees wraps its handlers in `.catch(passThrough)`.

## Consequences

- Adding a rule to a crew or agent means deciding which side it belongs on. foundry's ADR-0001, section 9, is the module-level application of this decision.
- A hook bug costs a missed rule, not a stuck session.
- subagent-limits refuses tools without such a guard (no `.catch` in `plugins/subagent-limits/hooks/register.ts`), so it doesn't follow the fail-open half of this decision. TODO: decide whether it should.
