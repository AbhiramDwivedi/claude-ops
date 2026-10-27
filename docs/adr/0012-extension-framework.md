# ADR-0012: plugins extend each other through manifests the base owns

Status: accepted, 2026-10-27
Proposed on 2026-10-26 by foundry run 2's design crew, against `main` at `b665583`. Accepted on 2026-10-27 in the foreman's acceptance review at wave 0's merge, with that review's fixes, together with the per-module ADRs that apply it: [ADR-0013](0013-kit-manifest.md), [ADR-0014](0014-worktrees-declared-read-only-agents.md), [foundry ADR-0002](../../plugins/foundry/docs/adr/0002-kit-manifest-and-config.md) and [foundry ADR-0003](../../plugins/foundry/docs/adr/0003-event-log-and-retro.md).

## Context

foundry run 2 wants foundry to build on what kit set up in a project, and worktrees and kit's stop gate to learn which agent types are read-only from the plugins that define them. Today none of that can happen without one plugin knowing another's internals:

- kit writes no machine-readable record of a run. The only marker is the `.claude/kit/` directory (`docs/architecture.md`, kit section).
- worktrees knows read-only types from a constant, `READ_ONLY_AGENTS` (`plugins/worktrees/hooks/register.ts:8`), plus the user's `noIsolateAgents` setting. `foundry:judge` and `foundry:cynic` (`tools: Read, Grep, Glob, Bash`) still get a worktree, a setup-script run and a port slot.
- kit's stop-gate template hard-codes its skip list (`plugins/kit/skills/init/hooks-reference.md:57` for sh, `:79` for ps1).
- foundry's architect invents per-crew port ranges that nothing ties to worktrees' `PORT_BASE` slots (ADR-0005, consequences).

ADR-0001 says plugins cooperate only through Claude Code and the disk, and any plugin may run without any other. This ADR says how one plugin extends another inside that rule.

### What Claude Code offers, probed

Sources: `plugins/foundry/.claude-plugin/types/claude-code/index.d.ts` (the engine's type contract, laid down per mod and gitignored by `**/.claude-plugin/types/`), and `claude plugin` run against throwaway plugins in the session scratchpad. Nothing was installed.

| Mechanism | Evidence | Verdict |
| --- | --- | --- |
| plugin.json `dependencies` | d.ts:79-84: the engine lays "one entry per plugin the mod's plugin.json lists under "dependencies" (that plugin's own contract)", which types that plugin's `$` nouns. `claude plugin --help` lists `prune\|autoremove  Remove auto-installed dependencies that are no longer needed`; `claude plugin uninstall --help` has `--prune  Also remove auto-installed dependencies`. `claude plugin validate` accepts `"dependencies": ["kit"]` and `[{"name":"kit","version":"^0.1.0"}]` (exit 0) and rejects `42` (exit 1, `dependencies: Invalid input: expected array, received number`). | It governs install, not only types: a listed plugin is auto-installed. That makes it a hard dependency, which breaks ADR-0001's "any plugin may run without any other". **Not used.** Unknown, because probing them means installing: whether a version range is enforced, whether a missing dependency blocks loading, whether the dependency must come from the same marketplace. |
| Skill tool call by name | in use: `plugins/foundry/skills/run/SKILL.md` calls `foundry:init`; foundry's lead loads `subagent-limits:split-work` | **Used.** How foundry init runs `kit:init`. The caller checks the skill is listed first, so a missing plugin degrades instead of failing. |
| `skill.prompt` hook | d.ts:4440-4450: fires when a skill expands (`/name`, the Skill tool, a preload); returning `{ text }` replaces "the text the model reads". "A hook that fails passes it through." | **Rejected** for cross-plugin extension. It is the fragile-base-class route: the base's tests and its owner never see the rewritten text; the order of several plugins' handlers on one event is not pinned (ADR-0001, Consequences, TODO); a failure passes silently; and it changes a prompt the owner approved without asking again (P20). |
| `$.agent.register` (`AgentSpec`) | d.ts:460-556: `prompt` "replaces the session's"; `skills?: readonly string[]` (531); `isolation?: 'worktree' \| 'remote'` (555), with no "none" | **Not used** to change another plugin's agent types (the same fragile-base problem). Its `isolation` has no opt-out value, which is why worktrees needs a declaration (ADR-0014). |
| `agent.offer` | d.ts ~4197-4204: rows carry agent, description, source and provider | Exposes no `tools` list, so worktrees can't infer read-only from it. Not used. |
| Plugin state `$.state` | d.ts:3471: "Any plugin reads any value; its owner alone writes it." `plugin` and `key` must be literals in source. | A candidate for a plugin to declare its own read-only types without kit. **Deferred** (P11): worktrees would have to name each declaring plugin literally in its source, and kit's shell stop gate can't read plugin state. The owner can set worktrees' `noIsolateAgents` today. |
| Hook notes (`agent.spawn`, `tool.call` on `Agent`) | in use: subagent-limits appends `CONTRACT` to every subagent's prompt | A prefixed note appended to a prompt, owned and tested by its plugin. Allowed, but it is not an extension point: no other plugin plugs into it. |

## Decision

1. **The base writes a versioned manifest, under a schema it owns, through code.** The manifest carries `version` from its first release. A script in the base writes it after the owner approves, and validates what it writes; the model never hand-writes a stored shape another plugin reads (P20, P23, P29). The schema lives in the base's `docs/`.
2. **The base declares its extension points by name**, in its README and in the seams table of `docs/architecture.md`. Anything not declared is internal (P15).
3. **An extension reads and never edits.** To add to a base's manifest, an extension runs the base's own skill, whose approval step the owner sees. Only the base's script writes the file.
4. **Nothing extends by rewriting another plugin's prompt.** No `skill.prompt` handler for another plugin's skill, and no `$.agent.register` of another plugin's agent type. A plugin may append a note under its own prefix to prompts, as subagent-limits does, and it owns that note's tests.
5. **Dependencies are soft.** No plugin lists another under plugin.json `dependencies`. An extension detects the base (its skill is listed, or its manifest file exists) and degrades to its behaviour without the base. Whether it says so depends on which of two cases it is:
   - **A step the owner sees.** An extension that would have used the base in a step the owner is watching says so in one line when the base is missing. Case: foundry init, which tells the owner `kit is not installed; foundry init carries on without a kit manifest (0.3.0 behaviour)` ([foundry ADR-0002](../../plugins/foundry/docs/adr/0002-kit-manifest-and-config.md), section 1).
   - **A hook that reads the manifest on every call.** It treats a missing manifest as silent: no log line, no note, no toast. Otherwise it would repeat the same line on every call in every project without the base. Case: worktrees on each `Agent` call ([ADR-0014](0014-worktrees-declared-read-only-agents.md), Decision).
6. **Unknown means today's behaviour.** A reader that finds the manifest unreadable, invalid, or at a `version` it doesn't know treats it as absent and logs why under its own prefix (P5, P7), in both cases of rule 5. foundry init says `kit manifest unreadable, carrying on without it: <reason>`; worktrees logs `worktrees: kit manifest unreadable, ignoring it: <error>`. A missing manifest is not one of these errors: rule 5 alone decides whether it is mentioned.
7. **A declaration that relaxes a default matches exactly and comes only from an owner-approved source.** Today that is kit's manifest, written after kit init's approval step, or a plugin's own declaration in its own code. Never an arbitrary project file (P9). Matching is on the full agent type (`foundry:judge`), case-folded as worktrees does today, never on the bare name. An explicit setting on the call (`isolation`) wins over any declaration.

### Extension points declared by this run

| Base | Extension point | Contract | Readers | ADR |
| --- | --- | --- | --- | --- |
| kit | `.claude/kit/manifest.json`: checks, agents with `readOnly`, risky paths, setup scripts | `plugins/kit/docs/manifest.schema.json` | foundry init, worktrees, kit's stop gate | 0013 |
| kit | `kit:init` with `declare read-only: <type>, ...`: how another plugin adds its read-only types to the manifest, through the owner's approval | `plugins/kit/skills/init/SKILL.md` (kit crew, wave 1) | foundry init | 0013 |
| worktrees | read-only types: no worktree for a type the kit manifest marks `readOnly` | `plugins/worktrees/README.md` (worktrees crew, wave 1) | Claude Code `Agent` calls | 0014 |
| worktrees | `PORT_BASE` per worktree slot (already shipped) | worktrees README, setup-script contract | the project's setup script; foundry crews | 0005 |
| foundry | `<foundry dir>/events.jsonl` | `plugins/foundry/docs/events.schema.json`; foundry module doc, "On disk" | `foundry retro` | foundry ADR-0003 |

Two other foundry contracts from this run are foundry's own declared config and grammar, **not** extension points: `.claude/foundry.json` (contract `plugins/foundry/docs/foundry-config.schema.json`, [foundry ADR-0002](../../plugins/foundry/docs/adr/0002-kit-manifest-and-config.md)) and the `decisions.md` grammar ([foundry ADR-0003](../../plugins/foundry/docs/adr/0003-event-log-and-retro.md), section 2). Each has a declared contract that foundry's own code and tests hold it to, but foundry doesn't offer either for other plugins to build on, so rules 1 and 3 don't bind them. `.claude/foundry.json` also has no `version`, which rule 1 wouldn't allow for an extension point. Its departure from P29 is recorded in foundry ADR-0002, Consequences.

### Ports

foundry stops inventing port ranges. When the project has a `.claude/worktree-setup.*`, a crew uses the ports of its own worktree's slot (`PORT_BASE` to `PORT_BASE+9`), as the setup script passes them on (for example in `.env`). When it has none, worktrees gives no `PORT_BASE` (`plugins/worktrees/README.md:8`), and foundry's plan says so instead of naming a range (foundry ADR-0002).

## Consequences

- kit becomes a base: its manifest's shape is public surface (P15, P16), and a field rename is a breaking change with a version bump.
- Each new cross-plugin need is a new declared extension point in the base, written by the base's crew, not a patch in the extension. That is slower than a `skill.prompt` hook and is the point: the base's tests cover every way it can be extended.
- Without kit, foundry's judge and cynic still get worktrees, as in 0.3.0. The owner can set worktrees' `noIsolateAgents` to `foundry:judge,foundry:cynic`. A kit-free declaration route (plugin state) is deferred until a second plugin needs it.
- The `dependencies` unknowns stay open. If the owner later wants a hard dependency, that is a change to ADR-0001, not to this ADR.
- Resolves the ADR-0005 open question on port ranges.
