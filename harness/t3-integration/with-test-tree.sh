#!/usr/bin/env bash
# Run one foreground T3 check in a disposable checkout without copying the
# running desktop tree or its dependencies. Keep all authored changes in Rubato.
set -euo pipefail

if [ "${1:-}" != -- ] || [ "$#" -lt 2 ]; then
  printf 'usage: bash with-test-tree.sh -- COMMAND [ARG ...]\n' >&2
  exit 2
fi
shift

here="$(cd "$(dirname "$0")" && pwd -P)"
source_tree="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
source_tree="$(git -C "$source_tree" rev-parse --path-format=absolute --git-common-dir)"
pin="$(node -p 'require(process.argv[1]).upstreamCommit' "$here/upstream.json")"
git --git-dir="$source_tree" cat-file -e "$pin^{commit}"

scratch="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/rubato-t3-check.XXXXXXXX")" && pwd -P)"
tree="$scratch/t3"
cleanup() {
  local status=$?
  trap - EXIT
  if [ -e "$tree/.git" ] || [ -d "$tree" ]; then
    if ! git --git-dir="$source_tree" worktree remove --force -- "$tree"; then
      printf 'could not remove temporary T3 checkout: %s\n' "$tree" >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  rmdir "$scratch" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git --git-dir="$source_tree" -c core.hooksPath=/dev/null worktree add --quiet --detach -- "$tree" "$pin"
node "$here/apply.mjs" --t3 "$tree" >/dev/null
cd "$tree"
"$@"
