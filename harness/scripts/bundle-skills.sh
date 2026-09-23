#!/bin/bash
# ~/.agents/skills 를 이 레포에 배포용으로 담는다.
#
# 스킬은 두 부류이고 정본의 방향이 서로 반대다.
#
#   1. 이 레포가 소유하는 것 (agent-taskforce, model-guide, dispatching, ...):
#      `harness/skills` 가 정본이고, 설치기가 그것을 `~/.agents/skills/<name>`
#      심링크로 건다. 그런 자리는 여기서 **건드리지 않는다** — 원본이 곧 목적지라
#      담을 것이 없고, 담으려 들면 자기 자신을 지운다.
#   2. 바깥에서 온 공유 스킬 (outpost, wy-server, find-skills, ...):
#      `~/.agents/skills` 가 정본이고 이 스크립트가 배포용 사본을 뜬다.
#      심링크는 실체를 따라가 뜬다(`-L`) — 남의 레포를 가리키는 것도 내용이
#      들어와야 새 기기에서 산다.
#
# **2번 자리의 파일을 이 레포에서 직접 고치지 마라.** 정본에서 고치고 이 스크립트를
# 다시 돌린다. 이 레포 쪽만 고치면 다음 실행이 조용히 되돌린다 — agent-taskforce 의
# `snapshot.sh` 에서 실제로 겪은 실패다.
#
set -euo pipefail

SRC="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/skills"

[ -d "$SRC" ] || { echo "bundle-skills: 원본이 없다 - $SRC" >&2; exit 1; }

mkdir -p "$DEST"

# 1번 부류를 먼저 가려낸다. 설치본이 DEST 안을 가리키는 심링크면 그 스킬의 정본은
# 여기다. 통째로 rm -rf 하면 그 실체를 지운 뒤 끊어진 링크를 복사하려다 죽는다.
owned=""
while IFS= read -r -d '' entry; do
  name="$(basename "$entry")"
  case "$name" in .*) continue ;; esac
  [ -L "$entry" ] || continue
  target="$(cd "$(dirname "$entry")" && cd "$(readlink "$entry")" 2>/dev/null && pwd -P)" || continue
  case "$target" in "$DEST"/*) owned="$owned $name" ;; esac
done < <(find "$SRC" -maxdepth 1 -mindepth 1 \( -type d -o -type l \) -print0)

is_owned() {
  case " $owned " in *" $1 "*) return 0 ;; esac
  return 1
}

# 2번 부류만 비우고 다시 담는다. 1번 부류와 README 는 그대로 둔다.
for existing in "$DEST"/*/; do
  [ -d "$existing" ] || continue
  name="$(basename "$existing")"
  is_owned "$name" && continue
  rm -rf "$existing"
done

count=0
kept=0
while IFS= read -r -d '' dir; do
  name="$(basename "$dir")"
  case "$name" in .*) continue ;; esac
  if is_owned "$name"; then
    kept=$((kept + 1))
    count=$((count + 1))
    continue
  fi
  [ -f "$dir/SKILL.md" ] || continue   # 스킬이 아닌 것은 담지 않는다
  cp -RL "$dir" "$DEST/$name"
  # 런타임 부산물은 담지 않는다. 담으면 레포에 커밋되고, 그러면 설치본과 번들이
  # 늘 달라 보여서 install-skills 가 그 스킬을 "사람이 고친 자리"로 보고 영영
  # 갱신하지 않는다. (.gitignore 와 install-skills 의 same_tree 와 같은 목록)
  find "$DEST/$name" \( -name __pycache__ -o -name .pytest_cache \) -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DEST/$name" -name '*.pyc' -delete 2>/dev/null || true
  # 스킬이 자기 git 레포인 경우가 있다(심링크로 걸린 남의 레포). .git 을 남기면
  # 바깥 레포가 그것을 embedded repo 로 보고 내용 없이 껍데기만 커밋한다 —
  # clone 한 사람에게는 빈 디렉토리로 도착한다.
  rm -rf "$DEST/$name/.git"
  count=$((count + 1))
done < <(find "$SRC" -maxdepth 1 -mindepth 1 \( -type d -o -type l \) -print0)

# 생성물 표시. 사람이 열었을 때 여기가 정본이 아님을 바로 알아야 한다.
cat > "$DEST/README.md" <<EOF
# skills — 배포용 사본 (생성물)

정본이 아니다. 정본은 \`~/.agents/skills\` 이고 이 디렉토리는
\`harness/scripts/bundle-skills.sh\` 가 뜬 사본이다.

**여기서 고치지 마라.** 정본에서 고치고 스크립트를 다시 돌린다.
이 쪽만 고치면 다음 실행이 조용히 되돌린다.

새 기기는 이 레포를 clone 한 뒤 설치기가 이것을 \`~/.agents/skills\` 로 풀어 준다.
Rubato와 기존 shared CLI는 이 설치본을 사용한다.

담긴 스킬 ${count}개 (그중 ${kept}개는 이 레포가 정본이라 그대로 두었다).
바깥 정본에서 온 것은 심링크 실체를 따라가 떴다.
EOF

echo "bundled ${count} skills (${kept} repo-owned, left in place) -> $DEST"
