---
name: interview
description: Interviews the owner about a goal before foundry plans it, asking only what the repo can't answer, and writes the answers to docs/requirements.md as numbered, checkable requirements. Use when the foreman reaches the interview step of /foundry:run, or when the person asks to capture requirements for a goal before building.
---

# foundry interview

You are the foreman, in the main thread. You turn a goal into requirements the crews can be held to. This skill is the only part of foundry that calls `AskUserQuestion`. No subagent, cynic or architect answers a question meant for the owner, and a requirement always records a choice someone made: the owner, the owner's goal text, or a default the owner allowed. Facts the repo already states are never requirements.

Args: `<goal> | <foundry dir>/interview.json | <requirements path>`. `<plugin>` below is two levels above this skill's base directory, and `<skill base>` is this skill's base directory. Every CLI call is `node <plugin>/interview/cli.ts <command> ...`. The questions come from `<skill base>/branches.md`; you never edit it.

## Classify the size

Size the goal from its text alone, before any fact-finding.

- `small` when all hold: the goal names the files, command or module it changes; it states or implies its own done condition; it adds no external service, no stored data shape and no user-facing surface; the repo is not greenfield.
- `large` when any holds: the repo is greenfield; the goal adds a product, app, service or module that doesn't exist yet; it adds an external service or integration; it adds a stored data shape; or, after fact-finding, it touches the domains of three or more packs besides `core`.
- `standard` otherwise.

Pick the packs by "Pick the packs" in `skills/principles/SKILL.md`, applied to the goal and the fact-finder's lines. `core` is always in. On a greenfield repo the owner's answer to the `outcome` branch picks them.

Write the state file with Write, then log one line in `decisions.md`:

```json
{ "goal": "<goal>", "size": "standard", "packs": ["core", "service"], "opened": [], "requirements": [], "visits": {}, "stopped": false }
```

```
- HH:MM | interview size standard, packs core, service | <reason> | none | followed
```

A `small` goal gets no fact-finder and no questions. Write one `functional` requirement from the goal itself, with `Source: goal`, and go to "Write requirements.md".

## Find the facts first

For `standard` and `large`, before any question, start one fact-finder in the foreground:

```
Agent({
  subagent_type: "<roles.search from .claude/foundry.json, else general-purpose>",
  name: "interview-facts",
  model: "sonnet",
  effort: "low",
  description: "Find facts for the owner interview",
  prompt: "<goal>, <repo>, <requirements path>, and each candidate branch id with its Fact line"
})
```

Its brief says: read only; report what the repo says, never what to decide; one line per finding, in exactly these forms:

- `FACT: <branch id> | <fact> | <path:line>`
- `UNKNOWN: <branch id>`
- `SPEC: <path> | <what it specifies>` for an existing spec, plan, issue export or `requirements.md` entry the goal touches.

Ignore any line that recommends a decision. Read every `SPEC:` path yourself. For each branch a `FACT:` line or an open R-n settles, set `visits[<id>] = { "by": "fact", "note": "<fact> (<path:line>)" }`. Facts are context for the architect and never become requirements.

On a greenfield repo, start the fact-finder only when `docs/` has files, which it reads as specs.

## Ask the owner

Loop until the interview stops.

1. Run `node <plugin>/interview/cli.ts next <skill base>/branches.md <foundry dir>/interview.json 3`. Each `NEXT:` line is `NEXT: <id> | <pack> | <ask> | <recommend> | opens: <ids or none>`. `NEXT: none` ends the loop.
2. Ask the returned branches in one `AskUserQuestion` call, one question per branch. Each question cites what the facts already say. The first option is the recommended answer, its label ending ` (Recommended)`, so "yes" accepts it. One or two alternatives follow. The last option is `Stop the interview`. At most 3 questions per call and 3 to 4 options per question.
3. For each answer, if it is too vague for its `Writes` kind (an `nfr` answer with no number, a `functional` answer with no example), ask one follow-up on that branch before recording it. Then set `visits[<id>] = { "by": "owner", "note": "<the answer>" }`. Add to `opened` each id from the branch's `Opens` that the answer makes relevant. Set `visits[<id>] = { "by": "closed", "note": "<why>" }` for each branch the answer rules out; an answer "runs only on my laptop" closes `environments` and `availability`.
4. When an answer conflicts with an open R-k, ask one question: "R-k says X; this goal needs Y. Replace R-k?", recommending the replacement.
5. Rewrite `interview.json` with Write and go to step 1.

When you ask about `hosting` or `integrations`, say that `docs/requirements.md` is committed and holds no names, emails, user paths or private infrastructure. The `Ask` text in `branches.md` already says so; keep it in the question.

## Stop the interview

The interview stops when `next` prints `NEXT: none`, when the goal is `small`, or when the owner says stop: the `Stop the interview` option, or an "Other" answer such as "stop", "enough" or "go".

On an early stop, fill with defaults:

1. Set `stopped: true` in `interview.json`.
2. Run `node <plugin>/interview/cli.ts remaining <skill base>/branches.md <foundry dir>/interview.json`. It prints a `NEXT:` line for every branch still unasked, or `NEXT: none`.
3. For each branch it prints, set `visits[<id>] = { "by": "default", "note": "<the recommended answer>" }`. Each becomes a requirement with `Source: default`.
4. Name the defaults. The message that starts the run on its own after the interview lists every id filled this way, as `Defaults filled: R-<n> (<branch id>), ...`.

The cynic never answers in the owner's place, here or later.

## Write requirements.md

The foreman writes the file with Edit or Write; crews never edit it. New requirements take ids from the highest in the file plus one, and ids are never reused. Each branch visited `owner` or `default` becomes one requirement of the kind its `Writes` field names: `functional` needs at least one `Example:`; `nfr` needs a `Measure:` with a digit; `constraint` needs neither. Hosting, integrations, auth, secrets, data sensitivity and compliance answers are `constraint`; scale, latency, availability and cost are `nfr`. A `non-goal` answer is a `- <text>` line under `## Non-goals`. `Source:` is `owner`, `default` or `goal`. Put the ids this run accepted in `interview.json` as `requirements`.

The shape, from a project that asked for CSV export:

```
# Requirements

Kept by foundry's owner interview (ADR-0008). Ids are never reused.

## R-1: Owners can export their invoices as CSV
Status: open
Kind: functional
Added: 2026-10-29T19:42:00Z | add invoice export
Source: owner
Example: Given an account with 3 invoices, when the owner clicks Export, then a CSV with 3 rows downloads.

## R-2: The export finishes quickly for large accounts
Status: open
Kind: nfr
Measure: p95 under 5 s at 10,000 invoices
Added: 2026-10-29T19:42:00Z | add invoice export
Source: default

## Non-goals
- No PDF export.
```

`Status` is `open`, `met`, `dropped` or `replaced by R-<k>` with `k` a later id. `Added` is `<RFC 3339 date-time> | <goal>`; the time is the run's `## Run` start. A change of mind is a new id plus `Status: replaced by R-<new>` on the old one; nothing is deleted.

Keep the file free of anything private. It is committed, so it holds no names, emails, user paths or private infrastructure. Describe hosting and integrations by type, and if an owner's answer names one, rewrite it by type before you write the requirement.

Run `node <plugin>/interview/cli.ts check <requirements path>` and fix the file until it prints `OK:`. Each error line is `ERROR: <text>`, for example `ERROR: R-2: nfr needs a Measure with a number`.

## Confirm and commit

For `standard` and `large`, ask one last question: "Build against R-a to R-b as written in `<requirements path>`?", recommended answer "Yes". Any other answer edits the file, reruns `check` and asks again.

Then commit the file alone on the target branch: `git switch <target>` if needed, `git add <requirements path>`, check `git status --porcelain`, `git commit -m "docs(req): <goal, short>"`. Log `- HH:MM | requirements R-a..R-b accepted (owner interview) | <size> | none | followed`. Crews work in worktrees that see only committed files, so the commit comes before the plan is drafted.

## Greenfield

A repo is greenfield when `git ls-files -- . ':!docs/**' ':!.claude/**' ':!README*' ':!LICENSE*' ':!.gitignore' ':!.gitattributes'` prints nothing. Run the interview with size `large` and requirements path `docs/requirements.md`.

## Return

Hand control back to the run skill, which goes on to its next section. Do not recommend, plan or start crews from here.
