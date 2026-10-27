# ADR-0013: kit records what it set up in a versioned manifest, written by a script

Status: accepted, 2026-10-27
Proposed on 2026-10-26 by foundry run 2's design crew. It applies [ADR-0012](0012-extension-framework.md) and was accepted with it on 2026-10-27.

## Context

kit init sets a project up, but leaves no machine-readable record of what it found: the checks, the agent types and which of them are read-only, the risky paths, the setup scripts. The only marker is the `.claude/kit/` directory (`docs/architecture.md`, kit section). So:

- foundry init can't build on kit's scan, and lists agent types by hand.
- The stop gate's skip list is hard-coded in the template (`plugins/kit/skills/init/hooks-reference.md:57`, `case "$agent" in kit:scout|kit:reviewer|Explore|Plan|claude-code-guide) exit 0 ;; esac`, and `:79` for ps1). No other plugin can add its read-only types to it.

The existing interface that can't take the work is the set of project files in kit's table (`CLAUDE.md`, gates, checklist, setup script): they are prose and shell, written by the model, and no code can read the facts back out of them.

## Decision

### The manifest

`<repo>/.claude/kit/manifest.json`, under `plugins/kit/docs/manifest.schema.json` (draft 2020-12, closed at every level). Fields, all required: `version` (1), `kit` (the writing kit's version), `checks`, `agents`, `riskyPaths`, `setupScripts`. An agent is `{name, readOnly, declaredBy}`; `name` is the full agent type, `^[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9_-]{1,64})?$`. A qualified name's prefix must equal `declaredBy`; a bare name has `declaredBy: "project"`.

The pattern keeps every name free of shell and PowerShell metacharacters, so it renders into the gates unquoted.

### The producer: `plugins/kit/scripts/kit_manifest.py`

Standard library, Python 3.9+ (P19). Only this script writes the manifest. kit init calls it after the owner approves, never before.

- `kit_manifest.py write --repo <dir> --facts <file|->` takes the approved facts: a JSON object with exactly `checks`, `agents`, `riskyPaths`, `setupScripts`. It validates them against the schema's rules and writes the manifest. Agents in an existing manifest declared by a plugin other than `kit` or `project` are kept unless the facts name them; everything else is replaced.
- `kit_manifest.py declare --repo <dir> --by <plugin> --read-only <name>[,<name>...]` adds or updates agents as `readOnly: true, declaredBy: <plugin>` in an existing manifest. Each name's prefix must equal `--by`.

**Output.** Exit 0 prints one JSON line on stdout:

```
{"manifest": "<path>", "changed": true|false, "gates": {"stop-gate.sh": "<status>", "stop-gate.ps1": "<status>"}}
```

`<status>` is `updated`, `unchanged`, `absent` (no such gate file) or `no-markers` (the gate exists without the markers below, so the script left it alone).

**Errors.** Nothing is written on error. Stderr is one line, `kit_manifest: <CODE>: <detail>`.

| Exit | Codes |
| --- | --- |
| 2, bad input | `BAD_ARGS`, `BAD_JSON`, `MISSING_FIELD`, `BAD_FIELD` (wrong type, bad enum, or an unknown key), `BAD_AGENT_NAME`, `DUPLICATE_AGENT` (two agents whose names case-fold equal), `DECLARER_MISMATCH` |
| 3, state | `NO_REPO` (the `--repo` dir doesn't exist), `NO_MANIFEST` (`declare` with no manifest), `MANIFEST_CORRUPT` (the existing file isn't JSON or doesn't match the schema), `NEWER_VERSION` (the existing file's `version` is above 1) |

**Bytes.** The object is built with keys in schema order (`version`, `kit`, `checks`, `agents`, `riskyPaths`, `setupScripts`, and each item's keys in its schema order) and `agents` sorted by name (Python's default string order). It is serialised as exactly `json.dumps(obj, indent=2) + "\n"`: default separators, `ensure_ascii` left at its default `True` (so non-ASCII is written as `\uXXXX` escapes), no `sort_keys`. It is written as UTF-8 without BOM, with LF only (opened with `newline="\n"` or in binary, so Windows adds no `\r`). No timestamp. `kit` is the script's `KIT_VERSION`, which equals kit's `plugin.json` version. The file is written to a temp file beside it and renamed. A second run with the same input leaves identical bytes and reports `"changed": false` (P6).

### The stop gate reads its skip list from the manifest

The kit crew wraps the skip line of both templates in markers:

```sh
# kit:read-only-agents:begin
case "$agent" in Explore|Plan|claude-code-guide|kit:reviewer|kit:scout) exit 0 ;; esac
# kit:read-only-agents:end
```

```powershell
# kit:read-only-agents:begin
if ($in.agent_type -in 'Explore','Plan','claude-code-guide','kit:reviewer','kit:scout') { exit 0 }
# kit:read-only-agents:end
```

On every `write` and `declare`, the script re-renders the line between the markers in `.claude/kit/stop-gate.sh` and `.claude/kit/stop-gate.ps1`: Claude Code's built-in read-only types (`Explore`, `Plan`, `claude-code-guide`) in that order, then every manifest agent with `readOnly: true` that isn't already listed (case-folded), sorted. Nothing outside the markers changes. The sh `case` matches case-sensitively and the ps1 `-in` doesn't; a type whose case differs from its declaration is tested, which is the safe direction.

kit's own agents go in the manifest like any other: `kit:reviewer` and `kit:scout` read-only, `kit:builder` and `kit:test-writer` not.

### kit init

- After the owner approves, kit init writes its files as today, then calls `write` with the approved facts. The proposal shows the manifest's facts as one item.
- A **declare flow**: when kit init is started with args `declare read-only: <type>, <type>` (foundry init does this, foundry ADR-0002), it shows the owner the declaration ("foundry asks kit to mark `foundry:judge`, `foundry:cynic` read-only: no worktree, no stop-gate run"), and on approval calls `declare --by <the types' prefix>`. When there is no manifest yet, it runs the full init and carries the declaration into its facts.
- kit init still treats `.claude/kit/` as "kit has run here", but a missing manifest in an existing `.claude/kit/` is offered as its own small proposal: write the manifest from the current files.

kit goes to 0.2.0 (P16): a new project file, a new script and a changed gate template.

## Seams

The contract test is `plugins/kit/tests/test_contract_manifest.py`; its fixture `plugins/kit/tests/fixtures/manifest.json` is synthetic and validates against the schema.

1. **Producer.** `write` on a temp repo, given the fixture's `checks`, `agents`, `riskyPaths` and `setupScripts` as the facts, makes `.claude/kit/manifest.json` whose keys equal the schema's `required` list, with `version` 1 and `kit` equal to `plugins/kit/.claude-plugin/plugin.json`'s version. A bad input (a bare `judge` with `declaredBy: "foundry"`, a missing `checks`, a non-JSON facts file) exits 2 with the named code on stderr and writes nothing. Running `write` twice gives byte-identical files and `"changed": false` the second time. `declare` with no manifest exits 3, `NO_MANIFEST`.
2. **Stop-gate skip list.** Take the sh block under "## `.claude/kit/stop-gate.sh`" in `hooks-reference.md`, put `false` in place of `<TEST_COMMAND>`, and write it into a temp git repo as `.claude/kit/stop-gate.sh`. After `declare --by foundry --read-only foundry:judge`, the gate exits 0 for `{"agent_type":"foundry:judge"}` on stdin and exits 2 for `{"agent_type":"kit:builder"}`. The script reports `"stop-gate.sh": "updated"`, then `"unchanged"` on a repeat. The test skips, saying why, only when no `bash` is on `PATH`.

## Consequences

- The manifest is public surface (P15). Renaming or retyping a field bumps `version`, and readers treat an unknown version as no manifest (ADR-0012, rule 6).
- An existing kit project has no manifest until kit init or kit revise writes one. Readers handle its absence, so nothing breaks.
- The gate files a project already has lack the markers, so the script leaves them alone (`no-markers`) until kit init re-proposes them.
- kit still declares no dependency, and still reads nothing of foundry's.
