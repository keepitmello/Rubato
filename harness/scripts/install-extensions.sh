#!/bin/bash
# 번들된 확장을 agentDir 밑에 깐다. install-skills.sh 의 확장 판이다.
#
# 여기 있는 확장은 `harness/rubato-pi/src/extensions/` 의 것들과 다르다. 저쪽은
# launch.mjs 가 경로를 직접 지정해 로드하는 하네스 부품이고, 이쪽은 senpi 가
# agentDir 밑을 훑어 **자동으로** 로드하는 사용자 확장이다. 등록 코드가 필요
# 없는 대신 설치가 필요하다.
#
# **이미 있는 확장은 건드리지 않는다.** 그 기기에서 사람이 고쳐 온 것이 정본일
# 수 있고, Orca 가 심어 둔 확장(orca-*.ts)과 한 디렉터리를 쓰기 때문이다.
# 덮어쓰려면 --force 를 준다.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/extensions"
DEST="${RUBATO_AGENT_DIR:-$HOME/.rubato-pi/agent}/extensions"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# 번들이 통째로 비면 디렉터리 자체가 사라진다. 마지막 확장을 폐기하면 그렇게
# 된다. 그때 여기서 죽으면 안 된다. 아래 폐기 목록이 "이건 지워라" 를 각 기기에
# 전하는 유일한 통로인데, 폐기가 비우기를 완성한 순간 그 통로가 닫히기 때문이다.
BUNDLE_PRESENT=1
[ -d "$SRC" ] || BUNDLE_PRESENT=0
mkdir -p "$DEST"

# 번들에서 폐기한 확장은 다른 기기에도 남기지 않는다. 일반 사용자 확장은
# 보존하지만, 이 파일은 Rubato가 설치했던 옛 번들이므로 업데이트 때 지운다.
removed=0
for name in promise-nudge.ts; do
  if [ -e "$DEST/$name" ]; then
    rm -f "$DEST/$name"
    removed=$((removed + 1))
  fi
done

added=0; kept=0; replaced=0
if [ "$BUNDLE_PRESENT" -eq 1 ]; then
for file in "$SRC"/*.ts "$SRC"/*.js; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  if [ -e "$DEST/$name" ]; then
    if [ "$FORCE" -eq 1 ]; then
      cp "$file" "$DEST/$name"
      replaced=$((replaced + 1))
    else
      kept=$((kept + 1))
    fi
  else
    cp "$file" "$DEST/$name"
    added=$((added + 1))
  fi
done
fi

echo "install-extensions: 새로 $added, 유지 $kept, 덮어씀 $replaced, 폐기 $removed -> $DEST"
[ "$kept" -gt 0 ] && [ "$FORCE" -eq 0 ] && echo "  (이미 있는 것은 두었다. 덮어쓰려면 --force)"
exit 0
