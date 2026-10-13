# Gate templates for kit init

Fill the `<...>` placeholders with the commands found in the scan. Keep each gate fast: the edit gate runs after every edit, so it should check the one file that changed (or run an incremental typecheck) in a few seconds.

How hooks report back: a hook that exits 2 has its stderr shown to the agent. After an edit, that tells the agent what broke. On Stop or SubagentStop, it keeps the agent working instead of letting it stop. The Stop input carries `"stop_hook_active": true` when the agent is already continuing because of a Stop hook; the gate then lets it stop, so a test failure the agent can't fix can't loop forever.

## `.claude/settings.json` (merge; keep existing hooks)

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/kit/edit-gate.sh\"", "timeout": 60 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/kit/stop-gate.sh\"", "timeout": 600 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/kit/stop-gate.sh\"", "timeout": 600 }] }
    ]
  }
}
```

Leave out `SubagentStop` when the tests take more than about a minute. The stop gate skips read-only agent types (from the hook input's `agent_type`); add the project's own read-only agents to that list. On Windows without Git Bash, use the PowerShell versions below with `powershell -NoProfile -File "$CLAUDE_PROJECT_DIR/.claude/kit/stop-gate.ps1"`.

## `.claude/kit/edit-gate.sh`

Reads the edited file's path from the hook input. Use an interpreter the project already depends on (node for a JS/TS repo, python for a Python repo); delete the other line.

```sh
#!/usr/bin/env bash
# kit edit gate: lint/typecheck the file just edited. Exit 2 shows the errors to the agent.
input=$(cat)
file=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).tool_input||{}).file_path||""))')
file=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))')
case "$file" in
  <*.ts|*.tsx>) ;;          # only the file types the linter covers
  *) exit 0 ;;
esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
if ! out=$(<LINT_COMMAND> "$file" 2>&1); then
  printf 'Lint/typecheck failed after editing %s. Fix it:\n%s\n' "$file" "$(printf '%s\n' "$out" | tail -n 30)" >&2
  exit 2
fi
```

## `.claude/kit/stop-gate.sh`

```sh
#!/usr/bin/env bash
# kit stop gate: run the tests before an agent reports done. Exit 2 sends the failure back to it.
input=$(cat)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
# SubagentStop carries agent_type: read-only agents changed nothing, so skip them.
agent=$(printf '%s' "$input" | sed -n 's/.*"agent_type" *: *"\([^"]*\)".*/\1/p')
case "$agent" in kit:scout|kit:reviewer|Explore|Plan|claude-code-guide) exit 0 ;; esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
[ -z "$(git status --porcelain 2>/dev/null)" ] && exit 0   # nothing changed: nothing to test
if ! out=$(<TEST_COMMAND> 2>&1); then
  printf 'Tests fail. Fix them, or say why you cannot, before you finish:\n%s\n' "$(printf '%s\n' "$out" | tail -n 40)" >&2
  exit 2
fi
```

## `.claude/kit/stop-gate.ps1` (Windows without bash)

```powershell
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($in.stop_hook_active) { exit 0 }
if ($in.agent_type -in 'kit:scout','kit:reviewer','Explore','Plan','claude-code-guide') { exit 0 }
Set-Location $env:CLAUDE_PROJECT_DIR
if (-not (git status --porcelain)) { exit 0 }
$out = & <TEST_COMMAND> 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  $tail = ($out -split "`n" | Select-Object -Last 40) -join "`n"
  [Console]::Error.WriteLine("Tests fail. Fix them, or say why you cannot, before you finish:`n$tail")
  exit 2
}
```

## Trying a gate by hand

```sh
echo '{"tool_input":{"file_path":"src/app.ts"}}' | CLAUDE_PROJECT_DIR=$PWD bash .claude/kit/edit-gate.sh; echo "exit $?"
echo '{"stop_hook_active":false}' | CLAUDE_PROJECT_DIR=$PWD bash .claude/kit/stop-gate.sh; echo "exit $?"
```

## `.claude/worktree-setup.sh` stub (multi-service repos only)

Called by the `worktrees` plugin in each new worktree. Slot N owns ports `PORT_BASE` to `PORT_BASE+9`. Keep only the steps the scan found; delete the rest.

```sh
#!/usr/bin/env bash
# kit: make this worktree runnable. Env: WORKTREE_PATH, WORKTREE_SLOT, PORT_BASE.
set -eu
main=$(git -C "$WORKTREE_PATH" worktree list --porcelain | sed -n '1s/^worktree //p')
cd "$WORKTREE_PATH"

# Dependencies: per worktree, from the shared cache. Never copy or symlink node_modules or a venv.
pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile
uv sync --frozen

# Gitignored config the code reads.
cp -n "$main/.env" .env 2>/dev/null || true

# Generated code: regenerate, don't copy.
<pnpm prisma generate>

# Lint/typecheck caches: only valid with --cache-strategy content (new checkout, new mtimes).
mkdir -p node_modules/.cache && cp -rn "$main/node_modules/.cache/." node_modules/.cache/ 2>/dev/null || true

# Per-slot Compose project and database.
echo "COMPOSE_PROJECT_NAME=<repo>-wt$WORKTREE_SLOT" >> .env.local
echo "<DATABASE_URL>=postgres://localhost:5432/<app>_wt$WORKTREE_SLOT" >> .env.local

# Ports.
cat >> <.env.local> <<EOF
<WEB_PORT>=$((PORT_BASE + 0))
<API_PORT>=$((PORT_BASE + 1))
<DB_PORT>=$((PORT_BASE + 2))
EOF
echo "worktree slot $WORKTREE_SLOT: ports $PORT_BASE-$((PORT_BASE + 9))"
```

Write a `.ps1` twin (`$env:PORT_BASE`, `Set-Content -Encoding utf8`) when the project is worked on from Windows.
