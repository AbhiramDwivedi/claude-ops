# ADR-0003: kit vendors workflow-audit's transcript parser, byte for byte

Status: accepted. Recorded on 2026-10-26 from the code as it stands at `0954e71`.

## Context

`/kit:revise` mines a project's transcripts, and workflow-audit already has a tested parser for them (`plugins/workflow-audit/scripts/wa_parse.py`, with `wa_common.py`). ADR-0001 rules out kit importing from workflow-audit's directory: a user can install kit without workflow-audit.

## Decision

kit carries copies of `wa_parse.py` and `wa_common.py` in `plugins/kit/scripts/`, identical to workflow-audit's. `kit_mine.py` imports them from its own directory and says so in its docstring. While both plugins live in this repo, `plugins/kit/tests/test_mine.py` (`test_vendored_parser_matches_workflow_audit`) compares the files with `filecmp.cmp(..., shallow=False)` and fails on any difference; it skips when workflow-audit isn't alongside.

## Consequences

- workflow-audit owns the parser. A change to `plugins/workflow-audit/scripts/wa_parse.py` or `wa_common.py` must be copied to kit in the same change, or kit's tests fail.
- A transcript-format fix ships in two plugins and needs a version bump in both (ADR-0009).
- `wa_common.py` in kit still describes itself as "shared by the workflow-audit modules"; the copy can't be edited to say otherwise without breaking the byte-for-byte check.
