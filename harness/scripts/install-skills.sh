#!/bin/bash
# 번들된 스킬을 ~/.agents/skills 에 깐다. bundle-skills.sh 의 반대 방향이다.
#
# 이 레포만 clone 한 기기를 위한 것이다. rubato 는 `~/.agents/skills` 를 읽고
# Claude Code 와 Codex 도 같은 자리를 보므로, 여기 풀어 두면 셋이 같은 스킬을 쓴다.
#
# 기본(첫 설치): 없는 것만 넣는다. 이미 있는 것은 그 기기 정본일 수 있다.
# --sync-from <rev>: 업데이트용. 설치본이 그 rev 의 번들과 같으면 새 번들로
#   갈아끼운다. 사람이 고친 자리(번들과 다름)는 그대로 둔다.
# --force: 있는 것도 전부 덮는다.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/skills"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
FORCE=0
SYNC_FROM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --sync-from)
      [ "${2:-}" ] || { echo "install-skills: --sync-from 에 rev 가 없다" >&2; exit 2; }
      SYNC_FROM="$2"
      shift
      ;;
    --sync-from=*)
      SYNC_FROM="${1#--sync-from=}"
      [ -n "$SYNC_FROM" ] || { echo "install-skills: --sync-from 에 rev 가 없다" >&2; exit 2; }
      ;;
    *) echo "install-skills: 모르는 옵션 $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -d "$SRC" ]; then
  echo "install-skills: 번들이 없다 - $SRC (건너뜀)"
  exit 0
fi
mkdir -p "$DEST"

same_tree() {
  diff -qr -x .DS_Store -x .git "$1" "$2" >/dev/null 2>&1
}

PREV=""
cleanup_prev() {
  [ -n "$PREV" ] && rm -rf "$PREV"
}
if [ -n "$SYNC_FROM" ]; then
  git -C "$REPO" rev-parse --verify "$SYNC_FROM^{commit}" >/dev/null 2>&1 \
    || { echo "install-skills: --sync-from rev 를 찾지 못했다: $SYNC_FROM" >&2; exit 1; }
  PREV="$(mktemp -d "${TMPDIR:-/tmp}/install-skills-prev.XXXXXX")"
  trap cleanup_prev EXIT
  # 옛 번들이 없던 커밋이면 비어 있는 채로 둔다. 그때는 있는 것을 덮지 않는다.
  git -C "$REPO" archive "$SYNC_FROM" harness/skills 2>/dev/null | tar -x -C "$PREV" \
    || true
fi

added=0; current=0; replaced=0; kept=0
for dir in "$SRC"/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || continue
  dest="$DEST/$name"
  prev="$PREV/harness/skills/$name"
  if [ ! -e "$dest" ]; then
    cp -R "$dir" "$dest"
    added=$((added + 1))
  elif [ "$FORCE" -eq 1 ]; then
    rm -rf "$dest"
    cp -R "$dir" "$dest"
    replaced=$((replaced + 1))
  elif same_tree "$dest" "$dir"; then
    current=$((current + 1))
  elif [ -n "$SYNC_FROM" ] && [ -d "$prev" ] && same_tree "$dest" "$prev"; then
    rm -rf "$dest"
    cp -R "$dir" "$dest"
    replaced=$((replaced + 1))
  else
    kept=$((kept + 1))
  fi
done

echo "install-skills: 새로 $added, 이미 최신 $current, 갱신 $replaced, 로컬 유지 $kept -> $DEST"
if [ "$kept" -gt 0 ]; then
  if [ -n "$SYNC_FROM" ]; then
    echo "  (로컬에서 고친 스킬은 두었다. 덮어쓰려면 --force)"
  elif [ "$FORCE" -eq 0 ]; then
    echo "  (이미 있는 것은 두었다. 덮어쓰려면 --force)"
  fi
fi

# 이 HEAD 에서 스킬을 맞춘 것을 기록한다. 세션 시작이 이 값과 다르면
# 한 번 더 맞춘다 — 예전 업데이터가 있는 스킬을 건너뛴 기기를 고친다.
if git -C "$REPO" rev-parse --verify HEAD >/dev/null 2>&1; then
  stamp="${RUBATO_SKILLS_STAMP:-$HOME/.rubato-pi/skills-bundle-head}"
  mkdir -p "$(dirname "$stamp")"
  git -C "$REPO" rev-parse HEAD > "$stamp"
fi
exit 0
