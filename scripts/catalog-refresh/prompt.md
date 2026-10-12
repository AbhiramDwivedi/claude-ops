You are refreshing the workflow-audit advice catalog. Work only in `plugins/workflow-audit/catalog/`. Read `plugins/workflow-audit/CONTRACT.md` (sections "catalog/prices.json" and "catalog/practices.json", and the metric key table) before editing.

Today is {{TODAY}}. Look for new material published since {{SINCE}}.

## What to check

1. **Prices.** Fetch https://platform.claude.com/docs/en/about-claude/pricing. Compare every model in `prices.json`. Add new models, fix changed numbers, and preserve prompt-length tiers such as `over_100k`; do not flatten tiered pricing into a note. Keep the longest-prefix layout. If anything changed, set `checked` to today. If nothing changed, leave the file untouched.
2. **Docs.** Fetch every distinct `source.url` of kind `docs` in `practices.json`, every run, whatever the entry's date: docs are undated and change silently. If a page is too long for one fetch, read it in parts. If a page now says something different from an entry's `claim`, fix the entry, or mark it `superseded` or `contested` with a note. If a page states clearly new advice that a transcript metric could check, add an entry.
3. **Staff posts.** Use web search to find posts since {{SINCE}} by Boris Cherny (@bcherny) and Thariq Shihipar (@trq212) about how to use Claude Code. Staff posts outweigh docs: when one conflicts with a docs entry, the docs entry becomes `superseded` and its `superseded_by` names the post's entry. X usually blocks fetching. Grade a post `anthropic-staff` only if you read its full text first-hand, from the post itself or an exact quote on a reliable page with the status URL. Anything you saw only as a search snippet or a paraphrase goes in the summary under "Unverified", and the catalog stays unchanged.
4. **Engineering blog.** Search anthropic.com/engineering for posts since {{SINCE}} that change Claude Code advice.

## Rules

- Change something only when you have a source for it. When in doubt, leave the entry alone and say so in the summary. No changes is a fine result.
- Keep ids stable. Never delete an entry. Retire it with `status: superseded` and a note.
- Set `practices.json` → `updated` to today only if that file changed.
- Do not touch any file outside `plugins/workflow-audit/catalog/`.
- Edit files only with the Edit tool. Bash allows exactly one command: `python -m unittest discover -s plugins/workflow-audit/tests`. Run it after editing and fix any failures your edits caused. The wrapper script reruns it, so don't mention tests in the summary unless they fail.
- Write plainly: short sentences, no hype.

## Final message

Your final message becomes the PR body. Use this format and nothing else:

```
SUMMARY: <one line, under 100 characters, e.g. "Opus 5.5 cache-read price fixed; 1 new staff-post entry"; or "No changes">

## Changes
- <entry id or model>: <what changed> (<source url>)

## Unverified
- <post url or description>: <why it wasn't used>

## Checked, unchanged
- <short list of sources checked>
```
