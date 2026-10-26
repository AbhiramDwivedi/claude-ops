# ADR-0010: workflow-audit's advice is a dated data catalog, refreshed weekly through a PR

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

workflow-audit checks a user's habits against current advice about Claude Code, and that advice changes: later guidance reverses earlier guidance, and prices change. Advice written into the skill's prompt would go stale silently.

## Decision

- The advice is data, in `plugins/workflow-audit/catalog/practices.json`: each entry has an id, a claim, a dated source with author and kind, an evidence grade, a status (`current` or superseded), `superseded_by`, and the metric that checks it. Prices are in `catalog/prices.json`, with the page they came from and the date checked. Both shapes are in `CONTRACT.md`. `tests/test_catalog.py` checks that ids are unique, that each `superseded_by` exists, that the enum fields hold allowed values, and that every entry's metric resolves in a fixture run.
- `scripts/catalog-refresh/run.sh` refreshes the catalog on a schedule. It runs headless Claude with a narrow tool list (`WebFetch WebSearch Read Grep Glob`, `Edit(plugins/workflow-audit/catalog/**)`, and the workflow-audit test command), a dollar budget (`BUDGET_USD`, default 5), in a temporary worktree. It fails if anything outside the catalog changed or the tests fail, bumps workflow-audit's patch version, pushes a `catalog-refresh/<date>` branch and opens a PR. It skips the week while last week's PR is still open. The script never merges; who merges the PR isn't recorded in the repo.

## Consequences

- The catalog's fields are a stored shape that the script, the skill and the refresh prompt (`scripts/catalog-refresh/prompt.md`) all depend on.
- The refresh job can only change data, never code or prompts, and only through a PR.
- The job runs on a machine outside this repo; its defaults (`REPO=$HOME/Projects/claude-ops`, mise shims for `claude` and `gh`) describe that machine. TODO: the scheduler that runs it isn't recorded in the repo.
