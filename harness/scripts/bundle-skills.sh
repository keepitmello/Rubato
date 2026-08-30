#!/bin/bash
# ~/.agents/skills 를 이 레포에 배포용으로 담는다.
#
# **정본이 아니다.** 정본은 `~/.agents/skills` 이고, 그중 일부는 agent-taskforce
# 레포가 `snapshot.sh` 로 따로 뜬다. 여기 있는 것은 새 기기가 이 레포만 clone 해도
# 스킬이 딸려오게 하려는 사본이다. Claude Code 와 Codex 도 `~/.agents/skills` 를
# 심링크로 보므로, 설치기가 이 사본을 그 자리에 풀어 주면 세 CLI 가 같은 것을 읽는다.
#
# **여기 있는 파일을 직접 고치지 마라.** 정본에서 고치고 이 스크립트를 다시 돌린다.
# 이 레포 쪽만 고치면 다음 실행이 조용히 되돌린다 — agent-taskforce 의 `snapshot.sh`
# 에서 실제로 겪은 실패이고(CLAUDE.md 의 "스냅샷은 한 방향" 절), 사본이 늘면
# 그 실패가 재현될 자리도 는다.
#
# 심링크는 실체를 따라가 뜬다(`-L`). 남의 레포를 가리키는 것도 내용이 들어온다 —
# 새 기기에는 그 레포가 없기 때문이다.
set -euo pipefail

SRC="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/skills"

[ -d "$SRC" ] || { echo "bundle-skills: 원본이 없다 - $SRC" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"

count=0
while IFS= read -r -d '' dir; do
  name="$(basename "$dir")"
  case "$name" in .*) continue ;; esac
  [ -f "$dir/SKILL.md" ] || continue   # 스킬이 아닌 것은 담지 않는다
  cp -RL "$dir" "$DEST/$name"
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
Claude Code 와 Codex 도 그 자리를 보므로 세 CLI 가 같은 스킬을 읽는다.

담긴 스킬 ${count}개. 심링크는 실체를 따라가 떴다.
EOF

echo "bundled ${count} skills -> $DEST"
