# foundry backlog

Working list for the next foundry runs, collected 2026-10-26 from a design conversation with Ram. Sources: Felix Rieseberg, "How to be more ambitious" (felixrieseberg.com); Thorsten Ball, "How I work with Agents" (X article, 2026-10-25); Addy Osmani's Clarity (clarity.addy.ie). foundry 0.1.0 itself builds run 1.

## Roles

| Role | Who | Power |
| --- | --- | --- |
| Owner | Ram | Rules on blockers, on changes to frozen scope, on production deploys, and on every push or PR. |
| King | The foreman (main session) | Product owner for the run. Decides what "right" means, logs every decision. Asks the owner only when two choices lead to clearly different outcomes with significant impact, or when a blocker can't be resolved. |
| Cynic | New agent, Opus high, outside every crew | Recommends, never decides. Gates every question bound for the owner: answer it from the plan, defer it to the end-of-run list, or pass it on. Checks drift, including overlap between crews. Stateless: reads the approved plan and decision log fresh each call. Can't suppress a `BLOCKED:`. |
| Judge | New agent, inside each crew | Never the builder. Opus high at least, and one effort level above the builder it judges, capped at xhigh. Gates the merge: the foreman merges only when the judge's report says pass. Also rules on the integration branch in `single` mode. |
| Generals | Leads | As in 0.1.0, plus the depth pass, the ladder and the proof rules below. |
| Troops | Members | As in 0.1.0. |
| Writer | New member type | See "Technical writer". |
| DevOps | New member type | See "DevOps agent". |

A more capable judge means a higher effort level on Opus, not a different model. Fable stays out unless the owner asks for it.

## Run 1: foundry 0.2.0, the core factory

1. **Judge and proof.** Every report carries proof: the command and its output, before/after numbers, or a walk through the real flow. The judge checks the proof against a "not evidence" list: tests the builder wrote after building, "I verified it" with no output, a typecheck alone, a mocked end-to-end test, output from another commit. It re-runs the proof itself only when the proof looks suspect or the change touches a high-impact path. Re-running everything costs too much.
2. **Done-checks the crew can't game.** A crew's done-check is code it doesn't own, or tests written by a test-writer before the builder starts, which the builder may not edit. The example plan in 0.1.0, where `auth` owns `tests/auth/**`, breaks this.
3. **Cynic**, as in the roles table. The foreman follows its recommendation by default and logs a one-line reason for any overrule. Overrules appear in the end-of-run report.
4. **Message tags.** Leads tag messages `BLOCKED:` (can't continue) or `PROPOSAL:` (more scope), as well as the existing `QUESTION:`.
5. **Altitude check.** The foreman asks once whether the goal is the end or one step toward an outcome, and offers the bigger version. The owner decides.
6. **Depth pass, at two levels.** Before planning, answer: what would a top practitioner do that wasn't asked for, what's the rawest material, which tools would they use, what besides the model verifies the result. A short pass by the foreman shapes which crews exist; a full pass by each lead shapes its members' tasks.
7. **Scope freeze.** Expand once while planning (altitude, depth, red team), get the owner's approval, then freeze. The cynic enforces the freeze.
8. **Escalation ladder.** Trigger: two fix attempts at one level end with the same check failing. Then a fresh agent one level up, never a resume. Its first deliverable is a root-cause analysis with evidence, then the fix. When it starts, it names competing theories and tests the cheapest to rule out first. Ladder: Sonnet, then Opus medium, high, xhigh. If xhigh fails twice, the lead sends `BLOCKED:`. A hook refuses `effort: max` from inside a crew. Every Agent call in a run sets model and effort.
9. **Be brave.** Builders and leads get: "Be brave: take the hard path, keep going when it gets difficult, don't ask permission for anything in scope. Never be brave with the truth: proof or it didn't happen." The ladder catches stubbornness.
10. **Describe jobs, not characters.** Role prompts say what the agent does, not who it is.
11. **Red team, optional.** An Opus member whose brief is to break the crew's work. Suggested for crews that touch high-impact paths (auth, money, migrations, CI, lockfiles).
12. **High-impact paths.** Tagged in the plan. They trigger the red team, and they're the only files the end-of-run report asks the owner to read. The judge's rubric (from Thorsten): it works; it's understood at the boxes-and-arrows level; it was tested end to end; it can be changed a month from now.
13. **Lead checks its environment first.** Before splitting the work, a lead proves it can run its own checks in its worktree. If it can't, that's an early `BLOCKED:`.
14. **Resource slices.** The foreman gives each crew its own port range and its own database or temp directory, so parallel end-to-end tests don't collide.
15. **Heartbeats.** A hook writes a "last active" timestamp per crew agent on each tool call. A running agent with no tool call for N minutes counts as stalled, and `/foundry` shows it. A timer wakes the foreman to check. Needs a probe.
16. **Scheduled follow-ups.** For example, resume after the 5-hour limit resets: read the reset time from the `usage-limits` plugin, save a resume point, schedule a wake-up after the reset. If the Claude Code process can't stay open while limited, the fallback is Windows Task Scheduler starting `claude --resume`. Needs a probe.
17. **DevOps agent.** Generic: it reads the deploy target, health checks and smoke URLs from project config. It validates deploys with proof: health endpoint, smoke test, logs, rollout. It may validate a preview. Promoting to production always goes to the owner.
18. **Technical writer.** See below.
19. **Skills in the plan.** The foreman lists the project's skills alongside its agent types, matches them to crews in the plan, and leads pass them to members.
20. **Lead goal enforcement.** The goal and what done means go in a file the lead re-reads. A `SubagentStop` hook refuses a lead's stop until its report carries proof against the goal, or starts with `CHECKPOINT:` or `BLOCKED:`. Check whether `/goal` exists and whether a subagent can use it.
21. **Commit trailers.** Members' commits carry `Foundry-Crew: <slug>`.
22. **Architecture docs.** `docs/architecture.md`: roles and who talks to whom (with a diagram), the run lifecycle, what's stored on disk, each hook and what it enforces, failure modes and recovery. Outline at the start of the build, content at the end. Written by the writer.

### Technical writer

foundry ships a `foundry:writer` agent (Opus) whose job is the prose a crew ships: READMEs, docs, release notes, the architecture doc. It loads the best writing skill the session has. That's the owner's `technical-writer` skill when it's installed. A project can name another in its foundry config. Without one, the agent falls back to rules built into its own definition: Zinsser's clarity, simplicity and brevity; Google developer style for reference and how-to; never invent a fact. The writer's work goes through the judge like any other.

The writer doesn't write the king's reports or leads' reports. Those keep their fixed, terse formats.

### Probes before planning run 1

1. Does an in-session timer (Cron, Monitor) fire while the foreman is idle, and does it survive a usage-limit stop?
2. Does `/goal` exist, and can a subagent use it?
3. Can a `SubagentStop` hook block a lead from stopping?
4. Can an agent definition preload skills, and can it fix its effort level?

## Run 2: the extension framework

- **RFC: how skills and plugins extend each other.** No inheritance; it breaks like a fragile base class does. Instead, data contracts on disk (a base skill writes a manifest with a schema, an extension reads it) plus named extension points the base declares. First check what Claude Code already offers: skill-to-skill calls, agent skill preloads, plugin dependencies, the mod API.
- **Prototype: `foundry init` extending `kit init`.** kit writes its manifest (checks, agents, risky paths). foundry adds role mapping, port slices, deploy target, the writing skill, prompt overrides per role. These describe jobs, not characters. If the manifest is missing, foundry runs `kit:init` first.
- **`foundry retro`.** Reads the decision log and reports: escalations by level, cynic recommendations and overrules, stalls, interruptions of the owner, judge rejections. Proposes changes to the project's foundry config and prompts. Turning repeated work into skills goes to `kit:revise`.

## Separately: technical-writer skill update (ai-tools repo)

Add from Clarity: state logical relations with connectors, not by placing sentences side by side; chain paragraphs (test: cover the page and predict what comes next); give the strongest objection its own paragraph; name who did it; revise by reordering as well as cutting; interview the author when TODOs would outnumber facts. Credit Clarity in `craft.md`. Keep the existing rule against question openers. One agent can do this; it doesn't need a crew.

## Rejected

- Unmeasured stretch goals ("2x or don't stop"). Allowed only as a number the judge re-measures.
- An A/B eval of 0.2.0 against 0.1.0.
- "Stop managing context": the owner's data says otherwise.
- "Don't worry about duplication" across crews.
- Post-merge follow-ups like "check CI": out of scope, foundry hands off before pushing.
