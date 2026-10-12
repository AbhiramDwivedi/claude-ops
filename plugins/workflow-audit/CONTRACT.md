# workflow-audit: internal contract

How the pieces fit together. The script measures, the skill judges, and the catalog says what "good" currently means. Keep this file accurate when any of them changes.

```
plugins/workflow-audit/
  .claude-plugin/plugin.json
  skills/workflow-audit/SKILL.md   the /workflow-audit command: runs the script, reads samples, writes the report
  scripts/audit.py                 entry point (Python 3.9+, standard library only)
  scripts/*.py                     helper modules imported by audit.py
  catalog/practices.json           dated, graded advice; each entry names the metric that checks it
  catalog/prices.json              per-model prices used to weight token counts
  tests/                           unittest; run: python -m unittest discover -s plugins/workflow-audit/tests
  tests/fixtures/                  small synthetic transcripts, never real ones
```

## The script

`python scripts/audit.py preflight` prints one JSON object: python version, projects dir, transcript file count and date range, and whether /insights data exists (`~/.claude/usage-data/facets`, `session-meta`) and how fresh it is.

`python scripts/audit.py run [--projects-dir P] [--days N] [--out DIR] [--exclude-session ID ...]` parses transcripts and writes:

- `DIR/metrics.json`: everything the skill needs, small enough to read whole (aim under 60 KB)
- `DIR/samples/NN-<session8>.md`: correction excerpts for the sample readers
- the last line printed to stdout is `DIR`

Defaults: `--days 30`, `--projects-dir ~/.claude/projects`, `--out ~/.claude/workflow-audit/runs/<YYYYMMDD-HHMMSS>`. The parse cache lives in `~/.claude/workflow-audit/cache/`. A file whose size and mtime haven't changed is not parsed again. The script never writes anywhere under `~/.claude` except `~/.claude/workflow-audit/`. Each run also tidies that folder (`scripts/wa_housekeeping.py`, reported in `meta.housekeeping`): cache entries whose transcript is gone are deleted, and so is `samples/` in run folders older than `cleanupPeriodDays` from `~/.claude/settings.json` (default 30). Only folders named like a run (`YYYYMMDD-HHMMSS`) are touched. `WORKFLOW_AUDIT_HOME` overrides the home folder, for tests.

Test-only options (not for users): `--prices FILE`, `--cache-dir DIR`. A file is in the window when its mtime is within `--days`.

It excludes its own sessions: any session whose first human message is the `/workflow-audit` command, plus any id passed to `--exclude-session`.

Exit codes: 0 ok, 2 no transcripts found, 3 bad arguments. Errors go to stderr as one plain sentence.

## Transcript facts (validated 2026-10-06 on Claude Code 2.1.27x–2.1.29x)

- Main session: `<projects>/<project-dir>/<session-id>.jsonl`. Subagents: `<projects>/<project-dir>/<session-id>/subagents/agent-*.jsonl` (records carry `isSidechain`).
- Human text: `type=user` records whose `message.content` is a string or text blocks. Exclude records with `toolUseResult` or `sourceToolAssistantUUID`, and records with `isMeta` or `isCompactSummary`. Also exclude strings starting with `<task-notification`, `<local-command-`, `<command-name>`, `<system-reminder>`, `[Usage limit` or `[Cross-session`, and messages relayed from other agents ("Another Claude session sent a message", "The coordinator sent a message").
- A slash command shows up as `<command-name>/x</command-name>` inside a user string. Count it as a human message, but report it as a command.
- Messages typed while Claude is working are not user records. They are `attachment.type == "queued_command"` with `origin.kind == "human"` and the text in `prompt`. They must be counted.
- Interrupt: a text block `[Request interrupted by user`. Tool rejection: a `user` tool_result record with top-level `toolDenialKind == "user-rejected"`; older builds without the field are matched on `is_error` and the text "doesn't want to proceed".
- Denials: any `user` tool_result record with a top-level `toolDenialKind` (`permission-rule`, `user-rejected`, `automode-blocked`, `automode-unavailable`, `interrupted`). The block's `tool_use_id` links it to the denied `tool_use`, which carries the command. Auto mode's reason is in the result text as `Reason: [Git Destructive]`.
- Effort: a top-level `effort` on assistant records, main and subagent files alike; `perTurnEffort` is the fallback and is often null.
- `/rewind` leaves no marker of its own. It shows up only as a `<command-name>/rewind</command-name>` user record.
- Compaction: a `system` record with `subtype == "compact_boundary"`.
- Usage: `message.usage` on assistant records (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, and `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`). One API response spans several records, so dedupe by `message.id`.
- Model: `message.model` on assistant records. Claude Code version: a `version` field on records.
- Agent calls: a `tool_use` named `Agent` (older builds: `Task`). If `input.model` is absent, the child inherits its parent's model.
- Permission mode: a `permissionMode` field on records.
- Unattended session: no human messages at all, or started by `claude -p` (check the `entrypoint` field if present). Behaviour metrics such as corrections are computed on interactive sessions only. Cost metrics include everything.

## metrics.json

Implementation notes (step 1a): `meta.billing` also carries `subagent_cache_ttl`, inferred the same way (the break rule uses it as the subagent TTL; `mixed` counts as 5m). A request is a cache break when the previous request read >= 20K cached tokens, the request wrote > 50% of its context, and it wrote >= 20K more than the thread's median ordinary write; waste is rewritten tokens x (write price - read price). `agents.calls` and `explicit_model_rate` count Agent calls in main-thread files only. `what_if.subagent_ttl_1h.saved_pct` counts subagent breaks classed `idle_over_ttl` with a gap of 60 minutes or less. Metric modules register with `@wa_registry.metric` and are listed in `METRIC_MODULES` in audit.py.

Implementation notes (step 1b, deviations and choices):

- Project names (metrics version 3): a cwd with a hidden worktree segment (`.run-worktrees`, `.worktrees`, `.claude/worktrees`) maps to the segment before it; a Claude scratchpad path (`.../claude/<slug>/...`) maps to the longest known project name the slug ends with, else the slug's last token. Otherwise (as before) the last path part of `cwd` (both `\` and `/` split; 1a only split on `/`, so Windows paths came through whole). Two different cwds with the same last part become `name (parent)`. `ctx.home` and `ctx.out_dir` exist on the Ctx; the parse cache version is 2 (the preceding-assistant-text tail is now 600 chars).
- Correction patterns live in `wa_m_rework.py`. Tight = message opens with no/nope/wrong/stop/wait/actually/that's not/not what/I said/why did you. Loose = the prototype regex (adds "don't", "do not", "instead", "actually" anywhere); it is the secondary count. Messages are typed or queued human text; slash commands are not messages; the first message is never a correction. Rates are per non-first message.
- On the real data the tight pattern fires rarely (14 of 603), so `rework.correction_streaks` carries both `sessions`/`top` (tight) and `loose_sessions`/`loose_top`.
- `rework.insights.auc.dissatisfied_vs_not` gives rank AUC of the per-session correction rate (tight and loose) over interactive sessions that /insights faceted; `n_joined` counts every faceted session in the window, `n_interactive_joined` the interactive ones. Needs 20+ interactive joined, else `auc` is `insufficient`.
- `samples` are written by the metric into `<run>/samples/` (needs `ctx.out_dir`): up to 8 interactive sessions with 2+ tight corrections. Secrets are redacted (`sk-`/token prefixes, `password=`/`token=` values, 32+ hex, 32+ char runs mixing letters and digits).
- `practices.usage.permission_modes.sessions_by_mode_seen` counts sessions in which each permissionMode appeared. Plan mode uses = transitions into `plan` plus EnterPlanMode/ExitPlanMode tool uses.
- Metrics version 7. The parse cache is version 3. Subagent files now keep their edit tool uses (Edit, Write, MultiEdit, NotebookEdit) so edit runs and rewinds can see them; nothing else reads subagent tools.
- Shape triage (`wa_m_permissions.classify`), first match wins: `read_only` when every segment's program is read-only (`ls`, `cat`, `grep`, `cd`, `git status`/`log`/`diff`, `Get-Content` and the like) and nothing is redirected to a file; `chained` for `&&`, `||`, `;` or `|`; `inline_interpreter` for `python -c`, `node -e`, `bash -c`, `powershell -Command`; `absolute_path` when the program, or an interpreter's script argument, is an absolute path; else `other`. Quoted strings are blanked before splitting, so `python -c 'a; b'` is one segment.
- Review rule: a run is reviewed when, after its last edit and before the next human message, an Agent call's description matches review/verif/audit/check or a `code-review`, `security-review` or `review` skill runs, or when the next human message asks for a review.
- Denials count every session, because pipeline runs are what the triage is for. Effort and review count interactive sessions only.
- `followup` is a list; `followup_from` names the run dir used. The previous run is searched under `~/.claude/workflow-audit/runs` and the parent folder of `--out`. Each row carries `reason` when `now` is null.

Each metric carries its numbers and its `n`. Where it points at sessions, it carries up to 10 examples as `{session, session8, project, date, value}`. Project is the readable name (the last path part of the session's `cwd`), not the folder slug. Every metric that a catalog entry or an experiment can reference has a stable dotted key, listed below. The file is nested: the key `cost.cache.waste_pct` is `metrics["cost"]["cache"]["waste_pct"]`. A metric with too little data still appears, with `"insufficient": true` and the reason.

| Key | Meaning |
|---|---|
| `meta` | `plugins_installed` (`[{name, version, installed_at}]` from `~/.claude/plugins/installed_plugins.json`; omitted if unreadable), window, counts (main/interactive/unattended sessions, subagents, requests), versions and models seen, `billing.main_cache_ttl` (`1h`/`5m`/`mixed`, from the main-thread write split), insights presence/coverage, excluded sessions, prices source/date |
| `cost.total` | price-weighted cost at list prices (USD) overall, by model, by project, main vs subagents, and `by_kind` `{interactive, unattended, interactive_pct, unattended_pct}` (a subagent takes its parent's kind) |
| `cost.cache.waste_pct` | share of cost lost to cache breaks: `{main, subagent, total}`; `cost.cache.waste_pct_by_kind` `{interactive, unattended}` is waste as a share of that kind's own cost |
| `cost.cache.by_cause` | rows `{thread, cause, count, rewritten_tokens, waste_pct}`. Causes, first match wins: `compaction`, `model_change`, `idle_over_ttl`, `version_change`, `idle_under_ttl`, `unexplained` |
| `cost.cache.subagent_start_pct` | cost of subagents' first requests (structural) |
| `cost.cache.resume_breaks` | subagent breaks split by what came before them: a message to the agent (coordinator/SendMessage/task notification), a long tool call, other |
| `cost.cache.what_if.subagent_ttl_1h` | `{extra_pct, saved_pct, net_pct}` if every subagent cache write were 1h |
| `cost.cache.what_if.fresh_instead_of_resume` | `{breaks, waste_pct, fresh_cost_pct, net_saving_pct, start_ctx_tokens, assumption}`: subagent breaks classed `message` vs starting a fresh subagent (writes median subagent first-request context + 5,000 tokens at the 5m price); ignores the work a fresh agent redoes |
| `cost.cache.top_sessions` | sessions with the most waste, each with `kind` and `share_of_waste` |
| `agents.calls` | Agent tool calls, total and per week |
| `agents.explicit_model_rate` | share of Agent calls that set `model`, overall and per ISO week |
| `agents.by_model` | subagents per model, split into explicitly set vs inherited |
| `agents.size` | subagents whose largest request context exceeded 200K / 300K / 450K, max, top agents, and `by_week` (ISO week of the subagent's first request: `{subagents, over_200k, over_300k, over_450k}`) |
| `context.claude_md` | lines of global and per-project CLAUDE.md (plus `.claude/CLAUDE.md` and `CLAUDE.local.md`) for projects seen in the window, and the session-weighted average lines loaded; every listed file also carries `mtime` (ISO UTC). Line counts follow `@imports` (up to 5 deep) and count `AGENTS.md` when a folder has no CLAUDE.md. Cwds that no longer exist go to `missing_cwds` and out of the average |
| `rework.correction_rate` | corrections per non-first human message, interactive sessions only; overall, by project, top sessions |
| `rework.correction_streaks` | sessions with 2+ consecutive corrective messages |
| `rework.insights` | /insights outcome and friction counts, and (when 20+ sessions join) how well the correction rate separates dissatisfied sessions |
| `sessions.shape` | interactive sessions, active minutes median, sessions with 2+ compactions, human messages per session |
| `verification.check_after_last_edit` | of sessions that edited files, the share that ran a test/build/lint/typecheck command after the last edit |
| `practices.usage` | plan mode uses, permission modes, interrupts, queued messages, /clear, /rewind, worktrees, skills used, top slash commands |
| `practices.usage.commands_used` | every slash command (with `/`) and skill (without) used in the window, with counts; not cut to a top N |
| `practices.usage.rewinds_after_untracked_edits` | `{rewinds, after_untracked_edits, with_git_baseline}`: /rewinds that followed Bash file changes or subagent edits, and how many of those had a git commit, stash or new branch earlier in the session |
| `permissions.denials` | tool denials in all sessions: `by_kind` (main/subagent), `by_session_kind`, `classifier_reasons`, `by_project`, `by_shape` and `read_only_top` for shell commands denied by a rule or by the person |
| `effort.by_model` | interactive sessions (`main`) and their subagents (`subagent`) per model per effort level, plus `ultrathink_messages` and `effort_commands` |
| `verification.review_after_edits` | runs of 20+ edits between two human messages, and how many had a review after them |
| `samples` | `[{file, session, project, corrections}]` |
| `followup` | present when an earlier run left `experiments.json`: each experiment with baseline, target and the value now |

## experiments.json (written by the skill into the run dir)

The skill always writes `proposed-experiments.json`, and writes `experiments.json` only with the experiments the person chose. The script reads only `experiments.json`. Each entry carries `metrics_version` (from `meta.metrics_version`). A follow-up whose baseline was measured under another version reports the value but leaves `met` null, with a reason. Bump `METRICS_VERSION` in `wa_common.py` whenever a metric's definition changes.

```json
[{"id": "explicit-agent-models", "metric": "agents.explicit_model_rate", "path": "overall",
  "baseline": 0.71, "target": 0.95, "direction": "up", "committed": "2026-10-06", "metrics_version": 2,
  "change": "Set model on every Agent call"}]
```

`metric` is a key from the table above, and `path` is a dotted path inside it. When it runs, the script finds the newest earlier run dir that has `experiments.json` and reports each experiment in `followup`.

## catalog/prices.json

```json
{"source": "https://...", "checked": "2026-10-06", "unit": "USD per million tokens",
 "models": {"claude-opus-5-5": {"input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0},
            "claude-haiku-5-5": {"input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0,
                                  "over_100k": {"input": 0, "output": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0}}},
 "fallback": {"output": 5.0, "cache_read": 0.1, "cache_write_5m": 1.25, "cache_write_1h": 2.0, "note": "multiples of input, used for a model not listed"}}
```

A model id resolves to the longest `models` key it starts with. A model entry may carry `over_100k`; those rates apply when that request's input plus cache-read and cache-write tokens exceed 100,000. An id with no match takes the input price of the listed id sharing the longest prefix, then the `fallback` multiples; it is listed in `meta.prices.unknown_models`.

## catalog/practices.json

```json
{"updated": "2026-10-08", "practices": [
 {"id": "explicit-subagent-model", "claim": "...", "improves": ["cost"],
  "source": {"url": "...", "author": "...", "kind": "docs|staff-post|research|blog", "date": "2026-01-31"},
  "grade": "measured|anthropic-advice|anthropic-staff|opinion", "models": "any", "status": "current|superseded|contested",
  "superseded_by": null, "metric": "agents.explicit_model_rate", "check": "how to read the metric against this practice",
  "notes": "...",
  "suggest": [{"name": "/fewer-permission-prompts", "kind": "command|skill|plugin", "what": "one short sentence", "url": "https://code.claude.com/docs/en/..."}]}]}
```

`anthropic-staff` is a first-hand post by Anthropic staff (Boris Cherny, Thariq Shihipar). It outweighs older docs: the docs entry becomes `superseded`, with `superseded_by` naming the post's entry. `superseded_by` must name an existing id. A practice is a gap only when transcripts show the failure it names; absence is never a gap. `suggest` is optional: official Anthropic commands, skills and plugins only, shown only when that entry's gap is found, and skipped when `practices.usage.commands_used` or `meta.plugins_installed` shows the person already uses it. `metric` is a key from the metric table above, or `null` when only the sample readers can judge it. `tests/test_catalog.py` checks all of this.
