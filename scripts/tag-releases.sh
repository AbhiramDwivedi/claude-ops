#!/usr/bin/env bash
# Tags every plugin version as `<plugin>--v<version>` at the commit that set it in that plugin's
# `.claude-plugin/plugin.json`, walking HEAD's first-parent history. Claude Code resolves a dependency's
# version range against these tags (https://code.claude.com/docs/en/plugins/dependencies.md); our plugins
# are relative-path marketplace entries, so the tags live in this repo. Existing tags are left alone, so
# the script is safe to run after every release.
#
#   scripts/tag-releases.sh            # create missing tags locally, print them
#   scripts/tag-releases.sh --dry-run  # print what it would tag
#   scripts/tag-releases.sh --push     # create missing tags, then push them to origin
set -euo pipefail

dry=0 push=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --push) push=1 ;;
    *) echo "usage: $0 [--dry-run] [--push]" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
created=()
declare -A seen=()

for manifest in plugins/*/.claude-plugin/plugin.json; do
  plugin=$(basename "$(dirname "$(dirname "$manifest")")")
  prev=""
  # oldest first, so each version is tagged at the first commit that carries it
  while read -r sha; do
    version=$(git show "$sha:$manifest" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)
    [[ -z "$version" || "$version" == "$prev" ]] && continue
    prev=$version
    tag="$plugin--v$version"
    # a version that comes back (a revert, then its revert) keeps the tag of its first commit
    [[ -n "${seen[$tag]:-}" ]] && continue
    seen[$tag]=1
    git rev-parse -q --verify "refs/tags/$tag" >/dev/null && continue
    if (( dry )); then echo "would tag $tag at $(git log -1 --format='%h %s' "$sha")"; continue; fi
    git tag -a "$tag" -m "$plugin $version" "$sha"
    echo "tagged $tag at $(git log -1 --format='%h %s' "$sha")"
    created+=("$tag")
  done < <(git log --first-parent --reverse --format=%H -- "$manifest")
done

if (( push && ${#created[@]} > 0 )); then
  git push origin "${created[@]/#/refs/tags/}"
fi
(( ${#created[@]} == 0 && !dry )) && echo "nothing to tag"
exit 0
