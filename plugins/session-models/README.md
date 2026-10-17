# session-models

Shows the main thread's model and effort, the agents running now, by model and effort, and the session's working directory. Agents include the main thread, subagents and teammates that run inside the session. It warns when too many run at once, or when one sends a huge context with every request.

```
model: Opus · effort: high · agents: Opus (12 medium, 1 high), Sonnet (2 low) · ⚠ 15 live · ⚠ ctx 910K · cwd: ~/src/app
```

The line is dim. Only the warnings marked ⚠ are drawn in the warning color. The directory comes last, with your home folder shown as `~`. When the band is too narrow, the path loses its start, so the folders nearest you stay readable: `cwd: …/plugins/session-models`. The line sits in the band above the prompt, alongside any other plugin's line there; collapse the band with its `[-]` or ctrl+x ctrl+a. In the VS Code extension and on a phone, which have no band, the line falls back to the plugin status line. That status shows everywhere, in its usual yellow, while such a surface is attached.

A crew is a named top-level agent (one with a name, spawned by the main thread) that has at least one live descendant. Its size is the lead plus every live descendant, grandchildren included, and the segment breaks that size down by model:

```
crews: export 4 (opus 1, sonnet 3) · staffing 3 (opus 1, sonnet 2)
```

Crews run largest first, then by name. Past three, the rest collapse to `+N more`. With no crew, the segment is left out. Crew members still count in `agents:` and in the live total as before. An unnamed lead, a named agent with no live helpers, and finished helpers are not counted. A member whose model is not known yet adds to the size but not to the breakdown.

| Setting | Default | What it does |
| --- | --- | --- |
| `liveAgentsWarn` | 6 | Warns when this many agents run at once, counting the main thread. |
| `contextWarnK` | 300 | Warns when a running agent sends this many thousand tokens of context per request. |

The [main README](../../README.md) covers installing, reading the line, and what it can't see.
