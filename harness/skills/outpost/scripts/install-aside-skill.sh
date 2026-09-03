#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/aside-skill/chatgpt-work-outpost"
ACCOUNT_ROOT="${ASIDE_ACCOUNT_ROOT:-$HOME/.aside/u/0}"
DEST="$ACCOUNT_ROOT/skills/user/chatgpt-work-outpost"
VALIDATOR="$ACCOUNT_ROOT/skills/builtin/skill-creator/scripts/validate-frontmatter.mjs"

[ -f "$SRC/SKILL.md" ] || { echo "missing bundled Aside skill: $SRC/SKILL.md" >&2; exit 1; }
[ -f "$VALIDATOR" ] || { echo "missing Aside skill validator: $VALIDATOR" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
node "$VALIDATOR" "$SRC/SKILL.md"
TMP="$(mktemp -d "$(dirname "$DEST")/.chatgpt-work-outpost.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
cp -R "$SRC/." "$TMP/"
rm -rf "$DEST"
mv "$TMP" "$DEST"
trap - EXIT
cmp -s "$SRC/SKILL.md" "$DEST/SKILL.md" || {
  echo "installed Aside skill differs from canonical source" >&2
  exit 1
}
echo "installed Aside skill -> $DEST"
