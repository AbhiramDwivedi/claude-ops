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

## Amendment, 2026-10-27: kit refuses to declare editing types read-only

Status: accepted. The owner approved foundry run 3's plan at 2026-10-28T00:31:42Z, and this amendment is part of that plan (its wave-0 design crew wrote it). The decision above stands except where this section narrows it.

### Context

A manifest entry with `readOnly: true` takes a type out of worktrees' isolation (ADR-0014) and out of the stop gate. Nothing stops a project or plugin from declaring a type that edits files. Such a type would then edit the main checkout and stop without its tests running.

The interface that can't take the guard as it stands: `validate_facts` (`plugins/kit/scripts/kit_manifest.py:113`) checks both the input facts and the stored file, because `read_manifest` (`:191`) runs it on the existing manifest (`:221`) before `cmd_write` (`:434`) or `cmd_declare` (`:445`) can replace anything. A guard there would turn an existing manifest that declares `general-purpose` read-only into `MANIFEST_CORRUPT`, which no `write` could repair (P16). So the guard sits on the input path only, and reads stay tolerant.

### The refused list

This line is the list. ADR-0014 carries the same line, byte for byte; kit and worktrees each hold their own copy in code, since plugins share no code (P1).

Refused read-only types: general-purpose, kit:builder, kit:test-writer, foundry:architect, foundry:devops, foundry:lead, foundry:writer

`general-purpose` is Claude Code's built-in editing type, and worktrees' default for an unset type (`plugins/worktrees/hooks/register.ts:58`). The other six are this repo's agents whose `tools:` line includes `Write` or `Edit` (`foundry:architect`, `foundry:devops`, `foundry:writer`) or that have no `tools:` line, so they get every tool (`foundry:lead`, `kit:builder`, `kit:test-writer`). A name is refused when its case-folded (`str.casefold()`) full name equals a case-folded name on the list. Only the full name counts: `Kit:Builder` and `GENERAL-PURPOSE` are refused, while `builder`, `plugin:general-purpose` and `kit:builder2` are not. Only `readOnly: true` is refused; a refused name with `readOnly: false` is a normal entry (kit declares `kit:builder` that way).

The script holds the list as the module constant `REFUSED_READ_ONLY_TYPES`, a tuple of the seven names in the order above.

### Decision

- **`write` refuses a refused input fact.** After `validate_facts` accepts the facts, any agent in them with `readOnly: true` and a refused name makes `write` exit 2 with code `READ_ONLY_EDITING_TYPE`, and nothing is written. Every other bad-input code is checked first, so a fact that is also malformed reports its schema code.
- **`declare` refuses a refused name.** After each `--read-only` name passes `check_agent_name` and the duplicate check, a refused name makes `declare` exit 2 with `READ_ONLY_EDITING_TYPE`, before the manifest is read, so the code is the same when there is no manifest. `NO_REPO` (exit 3) is still checked first, in `main`. Since a qualified name's prefix must equal `--by`, `declare --by foundry --read-only Foundry:Lead` still exits 2 with `DECLARER_MISMATCH`; `declare --by foundry --read-only foundry:LEAD` exits 2 with `READ_ONLY_EDITING_TYPE`.
- **Stderr** is the usual one line: `kit_manifest: READ_ONLY_EDITING_TYPE: <detail>`, where the detail names the refused name as given in the input.
- **Reads stay tolerant.** `read_manifest` and `validate_facts` don't apply the guard. An existing manifest with a refused `readOnly: true` entry is read as before: no `MANIFEST_CORRUPT`.
- **Carried-over entries are dropped.** An entry a command would carry over from the existing file, rather than take from its input, is dropped when it has `readOnly: true` and a refused name. That covers `write`'s kept entries (declared by a plugin other than `kit` or `project` and not named in the facts, `kit_manifest.py:438-440`) and `declare`'s carried agents (`:461`). Entries declared by `kit` or `project` are replaced by `write`'s facts anyway, so a plain `write` repairs them. For each dropped entry, in the order the entries are sorted in the old file, the command writes one stderr line, exactly:

  `kit_manifest: warning: dropped <name> (declaredBy <declaredBy>): READ_ONLY_EDITING_TYPE`

  with `<name>` and `<declaredBy>` as stored in the old file. The command still exits 0, prints its usual stdout line, and reports `"changed": true` since the bytes change. These lines come before the existing temp-file warning line, which keeps its format. So "Exit 0 can add one stderr line" in the script's docstring becomes "one line per dropped entry, then at most one temp-file line", all starting `kit_manifest: warning: `.
- **The stop gate never skips a refused type.** `skip_list` (used by `plan_gates`) leaves out every agent with a refused name, whatever its `readOnly`, so a refused entry is never rendered into the gates' skip line, even if one reaches it.
- **Error table.** The exit-2 row gains `READ_ONLY_EDITING_TYPE`:

| Exit | Codes |
| --- | --- |
| 2, bad input | `BAD_ARGS`, `BAD_JSON`, `MISSING_FIELD`, `BAD_FIELD` (wrong type, bad enum, or an unknown key), `BAD_AGENT_NAME`, `DUPLICATE_AGENT` (two agents whose names case-fold equal), `DECLARER_MISMATCH`, `READ_ONLY_EDITING_TYPE` (a `readOnly: true` input agent, or a `--read-only` name, on the refused list) |
| 3, state | unchanged: `NO_REPO`, `NO_MANIFEST`, `MANIFEST_CORRUPT`, `NEWER_VERSION` |

- **Version.** kit goes to 0.3.0 (P16): input that 0.2.0's `write` accepted now exits 2. `KIT_VERSION` follows. The manifest's shape and `version` (1) don't change, and `plugins/kit/docs/manifest.schema.json` stays valid for every file 0.2.0 wrote; its description notes that the script refuses the listed types, and the schema itself doesn't enforce the list.

### Seams added

The contract test is `plugins/kit/tests/test_contract_manifest.py`, run through the script as today. Fixtures, if any, live in `plugins/kit/tests/fixtures/contract-readonly/`. It names every refused type literally.

1. For each of the seven refused names, and for `General-Purpose`, `write` with facts holding that agent at `readOnly: true` (with the `declaredBy` its prefix needs, or `project` for a bare name) exits 2; stderr's single line starts `kit_manifest: READ_ONLY_EDITING_TYPE: `; no manifest is written, and an existing one keeps its bytes.
2. The same agents at `readOnly: false` write fine (exit 0).
3. `declare --by foundry --read-only foundry:lead` (and `foundry:LEAD`) exits 2 with `READ_ONLY_EDITING_TYPE`, with or without a manifest, and leaves the manifest's bytes alone. `declare --by foundry --read-only foundry:judge` still works.
4. Tolerant read and repair: an existing manifest written by hand with `general-purpose` at `readOnly: true, declaredBy: "project"` doesn't make `write` exit 3; `write` with facts that leave it out exits 0, and the new manifest has no `readOnly: true` refused entry.
5. Drop on carry-over: an existing manifest with `foundry:lead` at `readOnly: true, declaredBy: "foundry"`, then `write` with facts that don't name it, and separately `declare --by foundry --read-only foundry:judge`: each exits 0, the new manifest has no `foundry:lead` entry, `"changed"` is `true`, and stderr holds the line `kit_manifest: warning: dropped foundry:lead (declaredBy foundry): READ_ONLY_EDITING_TYPE`.
6. Look-alikes pass: `plugin:general-purpose` (declared by `plugin`) and a bare `builder` at `readOnly: true` write fine.
