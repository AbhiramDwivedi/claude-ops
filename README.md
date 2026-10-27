# claude-ops

[Claude Code](https://claude.com/claude-code) mods, an audit and a project kit. Two mods tell you a session is eating your usage limits while you can still stop it, not after you hit the wall. The third keeps subagents from growing large enough to do that. The audit looks back over a month of your sessions and tells you, with numbers, what to change. The last three keep parallel agents from stepping on each other, set each project up for them, and run them as crews: see [parallel work](#parallel-work).

The first two each add a dim line above the prompt, with only the warnings in color:

![session-models: model: Opus · agents: Opus (30, 1 live) — usage-limits: 5h 19% +4%/h (resets 1h28m) · ⚠ 7d 50% +21%/d out in 2d9h · ctx 22% · $173.63 · cache drops 1 (160K)](assets/mods.png)

[`usage-limits`](plugins/usage-limits) tracks the 5-hour and weekly windows. It shows how much of each you've used, how fast that number is climbing, and when it will hit 100% if that comes before the reset.

Here it is warning me for real: at +64% an hour, the 5-hour window runs out in 57 minutes, long before it resets.

![usage-limits warning: model: Opus · agents: Opus (3, 1 live), Sonnet (1) — ⚠ 5h 39% +64%/h out in 57m · 7d 67% +13%/d (resets 1d22h) · ctx 13% · $6.26 · cache drops 1 (74K)](assets/approaching-limit.png)

[`session-models`](plugins/session-models) tracks the agents in your session: which models they run on, how many are running right now, and how much context each one sends with every request.

[`subagent-limits`](plugins/subagent-limits) acts on that last number. It tells the main agent how to size and split work. When a subagent's context grows large, it calls the subagent in for a pit stop: the agent writes a handoff note, and a fresh agent goes back out with it. Past a hard limit it refuses the subagent's tools.

## Why these exist

I built these after a long session burned through my limits while everything on screen looked fine. I had done what the guides say: hand big work to subagents and pick the right model for each. It still got away from me. Here's how that happens.

You start a big job. You tell Claude to split it across subagents, Opus for the hard parts and Sonnet for the rest, and you put a strong model in charge. It goes well. Agents start, finish and report back.

Hours later the conversation has been compacted a few times. Somewhere in a summary, "Opus for the hard parts" became "use agents." New agents start without a model, so they run on whatever the main thread runs on. One agent's job grows from a fix into a whole feature, and every request it makes sends half a million tokens of context. Nothing on screen changes. The main thread looks calm because it is calm. The spending is happening where you aren't looking.

You find out when you hit the wall.

Nobody did anything wrong. Claude followed the instructions it still had, and you gave good ones at the start. Long sessions wear instructions down, and you can't steer by what you can't see.

These mods are the sign before the sharp bend. They don't take the wheel. They tell you what's ahead while you can still brake:

```
⚠ 5h 41% +38%/h out in 1h33m · 7d 18% +6%/d (resets 4d2h) · ctx 22% · $14.10
model: Fable · agents: Fable (6, 5 live), Opus (27), Sonnet (1) · ⚠ ctx 645K
```

Your agents have drifted onto your most expensive model, one of them is carrying a huge context, and at this pace the 5-hour window runs out in an hour and a half. You'd see all of that hours before the wall, while it's still cheap to fix.

subagent-limits is the exception. The other two are the gauges and the road signs, and subagent-limits is the pit crew. It changes what your agents do, so install it only if you want that.

[`workflow-audit`](plugins/workflow-audit) is the post-race review. The mods watch one session at a time; the audit reads a month of your transcripts and runs as a command, `/workflow-audit`, in its own session. It finds where your spend and rework go, checks your habits against current advice from Anthropic's docs and staff (dated, graded by evidence, and marked when later advice reversed it), and gives you at most five findings, each with one experiment to try. The next run tells you whether the experiment worked. It needs Python 3.9 or newer; everything stays on your machine.

## Parallel work

Once several agents work at once, the trouble moves from cost to collisions. Two agents edit the same checkout. A dev server outlives the agent that started it. Merged branches pile up locally and on the remote. An agent hands back its report and stays open because a log tail it started never exits.

[`worktrees`](plugins/worktrees) gives every agent that can edit its own git worktree, started from your current commit rather than `origin/main`, so an agent sees your unmerged branch. In a workspace whose ignored folders hold their own git repos, it leaves agents in the main checkout unless a setup script builds those repos into each worktree. A project can ship a setup script that installs dependencies and gives each worktree its own block of ports. When an agent stops, the mod stops what it left running, and it refuses the stop while the agent still owns a background shell or monitor. Once the session merges an agent's branch, the mod removes that agent's worktree and branch. `/tidy` removes the rest of the merged worktrees and branches, local and remote, when nothing would be lost. Read-only agent types such as `Explore`, `Plan` and `kit:scout` run in the session's checkout. From 0.6.0 so does every type that kit's manifest declares read-only, matched by full name; the mod rereads the manifest on every Agent call and ignores one it can't parse. Without kit, list those types in the `noIsolateAgents` setting, for example `foundry:judge,foundry:cynic`.

[`kit`](plugins/kit) sets a project up from its actual code. `/kit:init` proposes a conventions section for `CLAUDE.md`, lint and test hooks that stop an agent reporting done with broken checks, a review checklist and, where needed, a worktree setup script; it writes only what you approve. `/kit:revise` reads the project's recent sessions and proposes what to add or drop. The plugin also ships four agents with their model fixed: `builder` (Sonnet), `reviewer` (Opus, read-only), `test-writer` (Sonnet) and `scout` (Haiku, read-only), so picking the agent picks the model. From 0.2.0, once you approve the proposal, `scripts/kit_manifest.py` writes `.claude/kit/manifest.json`: the checks you approved, each agent type and whether it is read-only, the risky paths and the worktree setup scripts. Each time the script writes the manifest it also rewrites the skip list in kit's stop gates from it, so the gates don't run the tests for an agent that only reads. Another plugin marks its own agent types read-only through the script's `declare` command.

[`foundry`](plugins/foundry) runs a big goal as several crews at once. `/foundry:run` makes the main session the foreman: it asks whether the goal is the end or a step toward something bigger, splits it into crews that own separate files, shows you the plan, and freezes the scope once you approve. Each crew's lead delegates to your project's agents, or to general-purpose agents when there are none, with a model and effort set on every one. A judge in each crew checks the work against proof, and a crew merges only on its PASS, into your branch one at a time or into one integration branch for a single PR. Questions bound for you go first to a cynic agent, which recommends whether the foreman answers them, defers them to the end of the run, or passes them to you. The mod saves every crew agent's report to a file in case its hand-back gets lost, keeps crew messages inside the crew, sends a lead back when it tries to stop without a report, and wakes the foreman when an agent stalls or the usage limit resets. From 0.3.0, an architect agent writes the project's architecture doc and ADRs (`/foundry:init`), and plans each run as waves of crews with an extend-or-change verdict per module. Design work runs first, in wave 0, and waits for your approval. The mod refuses to start a crew before that approval, ahead of its wave, or over the parallel-crew cap.

foundry 0.4.0 builds on kit when it's installed. After the doc check, `/foundry:init` reads kit's manifest. When the manifest doesn't mark `foundry:judge` and `foundry:cynic` read-only and the session has `kit:init`, init hands that declaration to `kit:init` to put to you. Without kit, init says `kit is not installed` and carries on as 0.3.0 did. Init also proposes four new `.claude/foundry.json` keys: `roles` (which agent type does each job, such as `build: kit:builder`), `deploy`, `writingSkill` and `promptOverrides`. The 0.4.0 init has so far run only headless, with `claude -p`, which refused its write under `.git/`, so init stopped and left `.claude/foundry.json` unchanged; nobody has yet checked an interactive run. The hooks now append a line to `events.jsonl` in the session's foundry folder for each crew spawn, stall, tagged lead message and saved report, with no message, prompt or report text in it. A literal `HH:MM` the foreman types in the decision log is always replaced with the clock's time. `/foundry:retro` counts the decision log, the event log and the plan for each run and proposes changes to the config, which it writes only if you approve. Neither the event log nor the retro has run in a live run yet.

## Install

You need Claude Code 2.1.287 or newer, the first release with mods. The mod API is early access and can change between releases.

```
/plugin marketplace add AbhiramDwivedi/claude-ops
/plugin install usage-limits@claude-ops
/plugin install session-models@claude-ops
/plugin install subagent-limits@claude-ops
/plugin install workflow-audit@claude-ops
/plugin install worktrees@claude-ops
/plugin install kit@claude-ops
/plugin install foundry@claude-ops
```

The mods load when your next session starts.

If you installed these from the earlier claude-mods marketplace, the marketplace is now claude-ops and pit-stop is now subagent-limits. Remove the old marketplace with `/plugin marketplace remove claude-mods`, then run the commands above. If you changed pit-stop's limits, set them again on subagent-limits.

To get updates automatically, including the audit's advice catalog as models and Claude Code change, run `/plugin`, open **Marketplaces**, select claude-ops and choose **Enable auto-update**. It is off by default for marketplaces outside Anthropic's own.

`/plugin install` installs for your user by default, so a mod runs in every project. Keep it that way for usage-limits and session-models. Your limits are shared by every session you run, and the session burning through them may be in a project you didn't think to set up. subagent-limits changes what agents do, so you may prefer `claude plugin install subagent-limits@claude-ops --scope project` in the projects you want it in.

Each threshold appears as a row in `/config`. You can also set it under `pluginConfigs` in `~/.claude/settings.json`.

| Mod | Setting | Default | What it does |
| --- | --- | --- | --- |
| usage-limits | `warnAtPercent` | 90 | Toasts once when a window passes this percentage. |
| usage-limits | `rateWindowMinutes` | 30 | Sets how far back the 5-hour burn rate looks (10 to 300). |
| session-models | `liveAgentsWarn` | 6 | Warns when this many agents run at once, counting the main thread. |
| session-models | `contextWarnK` | 300 | Warns when a running agent sends this many thousand tokens of context per request. |
| subagent-limits | `nudgeAtK` | 300 | Asks a subagent to checkpoint when its requests carry this many thousand tokens of context. |
| subagent-limits | `stopAtK` | 450 | Gives a subagent 8 tool calls to checkpoint past this many thousand tokens, then refuses its tools. |
| subagent-limits | `cacheNotes` | on | Tells a subagent when its prompt cache expired during a long pause. The toast to you stays either way. |

Claude Code also has a built-in mod worth turning on alongside these. "You should know" runs a side agent that points out things you or Claude may have missed. Enable it with `/plugin enable cc-plugin-you-should-know@builtin`. It needs a first-party session with telemetry on.

## Reading the usage line

`5h 24% (resets 2h14m)` means you've used 24% of the 5-hour window and it resets in 2 hours 14 minutes.

`+38%/h` is how fast the 5-hour figure has climbed over the last 30 minutes. It appears after 5 minutes of readings, and only when the rate reaches 1% an hour.

`+6%/d` is the weekly window's pace, measured as the average since the week began, nights and weekends included. A busy afternoon would make a 30-minute rate look alarming for a whole week, so this mod doesn't use one. The weekly pace appears 6 hours into the week.

`⚠ 5h 41% +38%/h out in 1h33m` means that at this pace the window runs out in 1 hour 33 minutes, before it resets. A toast fires the first time this happens in each window. Another fires when you pass `warnAtPercent`.

`5h reset` means the last reading's reset time has passed. The next request brings a fresh figure.

`ctx 22%` is how full the main thread's context window is. `$14.10` is the session's cost at API prices, the same figure `/cost` reports.

`cache drops 3 (1.9M)` appears once an agent's prompt cache has expired during a pause of more than 4 minutes and its next request rebuilt at least 100K tokens of context. It counts the main thread and every subagent: three drops so far this session, which re-wrote 1.9M tokens. Subagents keep their cache for 5 minutes unless you set `subagentPromptCacheTtl`, so an agent that waits on a long test run or a sleep loop pays to rebuild its whole context.

## Reading the agents line

`model: Opus` is the main thread's model. Until a subagent is running, that, its effort and the directory are all the line shows.

`effort: high` is the effort the main thread's latest request asked for: a level, or a token budget such as `32K`. It appears after the first request, follows `/effort` at the next one, and is absent for a model that takes no effort.

`agents: Opus (12 medium, 1 high), Sonnet (2 low)` counts the agents running now: the main thread, subagents and teammates that run inside the session. Each counts once, under the model and effort of its latest request. Finished agents drop out. An agent on a model without effort counts as a bare number, such as `Haiku (2)`. An agent started without a model runs on the main thread's model, so if your main thread's model shows up here when you meant the work to go to cheaper ones, that's the sign.

`⚠ 14 live` appears while at least `liveAgentsWarn` agents are running. The toast fires once. It fires again only after the count drops 2 below the threshold, and never twice within 10 minutes.

`⚠ ctx 910K` is the largest context any running agent sent with its last request. The agent pays for that context again on every request, so a handful at this size will drain a window fast. Each agent gets one toast when it first crosses `contextWarnK`.

`cwd: ~/src/app` is the session's working directory, with your home folder as `~`. It follows a shell `cd`, `/cd` and worktree moves. A path too long for the band is cut from its start, as `…/plugins/session-models`; the status-line fallback shows it whole.

## What subagent-limits does

session-models shows you an agent carrying a huge context. subagent-limits keeps agents from getting there. The main agent still decides how to split the work, because only it knows the task. The mod gives it the rules and enforces two limits.

The main agent gets a short section in its system prompt. It says to give each agent one phase of work and to run agents in parallel only when they edit different files. When they would share files, it says to run a relay instead: one fresh agent per phase, each starting from the last one's handoff note. The `subagent-limits:split-work` skill has the longer version, with templates for briefs and handoff notes and a guide to picking each agent's model.

The section also tells the main agent to set a model on every subagent. An agent started without one runs on the session's model unless you set a fallback. If your session runs on an expensive model, set `CLAUDE_CODE_SUBAGENT_MODEL` in the `env` block of `~/.claude/settings.json`, for example to `sonnet`.

Every subagent's brief gets a context budget added to the end. It asks the agent to read files by line range, keep command output short, and write a handoff note if it is asked to checkpoint.

When a subagent's requests carry `nudgeAtK` thousand tokens of context, its next tool result comes with a note asking it to finish its current item and checkpoint. Past `stopAtK`, it gets 8 more tool calls to commit and write its note, and then every tool call is refused. Its final report starts with `CHECKPOINT:`, which tells the main agent to start a fresh agent from the note rather than resume the old one. A toast tells you each time.

The brief also asks agents to run the narrowest command that proves a change and not to wait in sleep loops. If a subagent's cache still expires while it waits on its own tool call, the mod tells it once how much context it rebuilt and after how long a pause, and suggests checking on long jobs sooner or running something shorter. It gives no fixed polling interval, because whether polling pays depends on your plan and your jobs. Replayed over 945 real subagents, the note would have reached about 4% of agents in normal sessions.

The defaults come from two analyses. One replayed 32 subagents from a long session against different limits, pricing every request at API rates. That includes re-writing an agent's whole context into the cache after it sits idle for more than five minutes, which was about a quarter of the cost. The other measured 938 subagents from a month of sessions on another machine. Both put the best limit at about twice the context an agent carries when it makes its first edit. Both datasets come from one person's work, so treat the defaults as a starting point and tune `nudgeAtK` and `stopAtK` for yours. The mod ships a script that runs this analysis on your transcripts: see [check the limits against your own agents](plugins/subagent-limits/README.md#check-the-limits-against-your-own-agents).

A fresh agent starts with 35K to 45K tokens of context. One briefed with a single phase of work read about 117K more before its first edit. For those agents the best limit was 300K to 350K, which cost about a fifth less than no limit. Lower limits backfire, because every agent cut off has to pay that startup again. At 200K the replay cost about a third more than no limit. At 250K it saved half as much as at 300K and ran 26% slower, against 13% at 300K. Agents briefed with a whole feature read about 220K before their first edit, and for them every limit up to 400K cost more than no limit.

Most agents never reach the limits. On the second machine the median agent peaked at 119K, and nearly all the saving came from a few runaway sessions. Briefs matter more than the limit. Most of what an agent reads before its first edit is command output, such as `cat`, `grep` and test runs, so a brief that names the exact files and line ranges pays off. Cutting the reading before the first edit from 135K to 100K more than doubled the saving at 300K. For a small fix, or edits where each step depends on the last, skip the subagent: the main thread already has the context.

## Limitations

The limit figures come from this session's own API responses. Your windows are shared by every session you run, but a session only learns the latest numbers when it makes a request. An idle session's line falls behind. The session doing the damage stays current.

Only Claude subscriptions (Pro and Max) report limits. With an API key, the usage line reads `limits: no reading yet`.

Teammates that run in their own terminal or tmux pane don't show up in the lead's count. Each is a separate process with its own copy of the mod. Teammates inside the lead's process are counted.

Burn rate is measured in percent of your window, not tokens. However your plan weighs cached reads, output and different models, the percentage already includes it.

The agent counts reset on `/clear`. They survive a mod reload but not a restart.

subagent-limits never limits the main thread, which Claude Code compacts on its own. It doesn't limit forks either, because a fork starts with its parent's whole context and shares its prompt cache.

subagent-limits keeps its counts inside the mod, so a reload starts them over. After one, an agent may be asked to checkpoint a second time, and a fork that is still running loses its exemption.

## Develop

To run the mods from a clone instead of the marketplace, pass the folders for one session:

```
claude --plugin-dir ./plugins/usage-limits --plugin-dir ./plugins/session-models --plugin-dir ./plugins/subagent-limits --plugin-dir ./plugins/workflow-audit --plugin-dir ./plugins/worktrees --plugin-dir ./plugins/kit --plugin-dir ./plugins/foundry
```

Or list them in the `env` block of `~/.claude/settings.json`. Separate the paths with `;` on Windows and `:` elsewhere:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-ops/plugins/usage-limits:/path/to/claude-ops/plugins/session-models:/path/to/claude-ops/plugins/subagent-limits" } }
```

An interactive session watches those folders and reloads a mod when you save a file.

Load each mod one way only. If it is in `CLAUDE_CODE_PLUGIN_DIRS` and also installed from the marketplace, it runs twice, with every line and toast doubled. `claude plugin list` shows both copies.

Before you commit:

```
claude plugin validate plugins/usage-limits   # checks the manifest and module as the engine reads them
claude plugin test plugins/usage-limits       # runs tests/*.test.ts
claude plugin test plugins/session-models
claude plugin test plugins/subagent-limits
claude plugin test plugins/worktrees
claude plugin test plugins/foundry            # foundry's crew hooks
node --test plugins/foundry/tests/*.check.ts  # foundry's prompt, config-schema and principle-pack checks
python -m unittest discover -s plugins/foundry/tests          # the retro script
python -m unittest discover -s plugins/kit/tests              # kit's transcript miner and manifest script
python -m unittest discover -s plugins/workflow-audit/tests   # the audit's script
```

When a mod loads, Claude Code writes its API types into the mod's `.claude-plugin/types/` folder, along with a list of the MCP tools on your machine. Git ignores that folder. After the first load, `tsc -p plugins/<mod>` type-checks the mod.

## License

[MIT](LICENSE)
