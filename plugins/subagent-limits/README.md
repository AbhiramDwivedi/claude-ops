# subagent-limits

Keeps subagents small. The main agent still decides how work is split. This mod tells it how to split well, watches each subagent's context, and steps in when one grows too large.

- It adds a short section to the main agent's system prompt with the rules for sizing and splitting work.
- It adds a context budget to every subagent's brief: read files by line range, keep output short, and write a handoff note when asked to checkpoint.
- When a subagent's requests carry `nudgeAtK` thousand tokens of context, it asks the agent to finish its current item and checkpoint.
- Past `stopAtK`, the agent gets 8 more tool calls to commit and write its note, and then every tool call is refused.
- Each note goes with the first tool call of the request that crossed the limit. The model's tool calls in that response start only once its usage has arrived, a moment after the response ends, so the request is measured before its tools run.
- When a subagent waits over 4 minutes on one of its own tool calls and its next request rebuilds most of a large context (100K tokens or more), its prompt cache expired. The mod shows you a toast and tells that agent once, with the measured size and pause, so it checks on long jobs sooner. Agents whose caches never expire never see it.
- It ships the `subagent-limits:split-work` skill, with templates for briefs and handoff notes.

| Setting | Default | What it does |
| --- | --- | --- |
| `nudgeAtK` | 300 | Asks a subagent to checkpoint when its requests carry this many thousand tokens of context. |
| `stopAtK` | 450 | Gives a subagent 8 tool calls to checkpoint past this many thousand tokens, then refuses its tools. Always at least 50 above `nudgeAtK`. |
| `cacheNotes` | true | Tells a subagent once when its prompt cache expired during a long pause. Off: only you get the toast. |

The [main README](../../README.md) covers installing, why the limits sit where they do, and what it can't see.

## Check the limits against your own agents

The defaults come from one person's agents. `scripts/ctx_study.py` reads your subagent transcripts and tells you whether 300K and 450K suit how you work, or which values would cost less.

It reads `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl` and never writes there. Forks (`isFork` in the `.meta.json`) are left out of every number. It measures:

- context at each agent's first request, at its first Edit/Write (R_edit), and at its peak
- how many agents pass each limit, and what share of weighted cost (`input + 1.25 cache_write + 0.1 cache_read + 5 output`) went to requests above it
- cache-expiry rewrites: requests after an agent's first whose cache write is at least half its context
- this mod's activity: briefs carrying the contract, nudges, wind-down notes, refusals, final reports starting with `CHECKPOINT:`, and predecessor-to-successor pairs
- the re-orientation fraction: a successor's growth before its first edit, divided by the median for other agents
- a what-if simulation of the cost change at limits of 200K to 450K, and a verdict on the current limits

### Run it

Python 3.8 or newer, standard library only. Installed from the marketplace, the script is at `~/.claude/plugins/cache/claude-ops/subagent-limits/<version>/scripts/ctx_study.py`. In a clone of the repo it's at `plugins/subagent-limits/scripts/ctx_study.py`.

```
py -3 <path>/ctx_study.py              # Windows
python3 <path>/ctx_study.py            # macOS, Linux
```

Options: `--since DAYS` (default 7, `0` for all time), `--limits 300,450` (in K tokens; pass your own if you changed `nudgeAtK` or `stopAtK`), `--projects DIR` (default `~/.claude/projects`), `--out DIR` (default `~/.claude/ctx-study`).

To run it every Monday at 09:00, point the schedule at a clone. The `<version>` folder in the plugin cache changes on every update, which would break the schedule.

```
schtasks /Create /TN ctx-study /SC WEEKLY /D MON /ST 09:00 /TR "C:\Windows\pyw.exe -3 C:\path\to\claude-ops\plugins\subagent-limits\scripts\ctx_study.py"
0 9 * * 1  python3 /path/to/claude-ops/plugins/subagent-limits/scripts/ctx_study.py >/dev/null   # crontab
```

### Output

Everything goes to `--out`:

- `report-YYYY-MM-DD.md`: the report. A run with a window other than 7 days adds a suffix (`-all`, `-30d`), so it doesn't overwrite the weekly one.
- `agents-YYYY-MM-DD.csv`: one row per agent, forks included and flagged.
- `history.csv`: one line per run, appended, to show trends across weeks. Filter by `window_days` when comparing.

The reports contain project names and agent descriptions, so they stay in your home directory. Don't commit them anywhere.

### How the mod's activity is detected

The marker strings come from `hooks/register.ts`. If they change there, update them in the script. Before 0.3.0 this mod was called pit-stop and tagged its notes `[pit-stop]`; both tags are matched, so older transcripts still count.

- Contract: the agent's brief contains `[subagent-limits] Context budget.`
- Nudge, wind-down and refusal: the note text with a concrete token count, found in anything except the agent's own output. A note whose count is more than 10% above the agent's own peak is treated as a quotation and ignored. That stops an agent that read the mod's source or tests from being counted.
- CHECKPOINT: the agent's last text message starts with `CHECKPOINT:`.
- Successor: a predecessor is an agent that ended with CHECKPOINT or was refused. Its successor is the first non-fork agent in the same parent session that started after the predecessor's last event and whose brief (minus the appended contract) either names the predecessor's agent id, names a note file from its report (a path containing handoff, checkpoint, note or relay), or shares at least three 8-word runs with the report. Each agent can succeed only one predecessor.

### Limitations

- The simulation uses 0.6 as the re-orientation fraction until at least 3 measured pairs exist. Its cost model ignores output tokens.
- The verdict flags the limits when the cheapest simulated limit is more than 50K from the nudge limit. It also prints the rule of thumb (2 x median R_edit), which ignores the cost of handing off and so usually comes out lower.
- When `CLAUDE_CODE_SESSION_ID` is set (the script is run from inside Claude Code), that session's transcripts are skipped. A scheduled run doesn't skip anything, so it includes partly written transcripts from any session still running at the time.
- Only edits made through Edit, Write, MultiEdit and NotebookEdit count as an agent's first edit. Edits made through Bash don't.
