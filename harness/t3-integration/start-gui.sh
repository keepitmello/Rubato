#!/bin/bash
# Pi 프로필 서버를 띄운 뒤 overlay된 T3 데스크톱을 연다.
#
# 앱 번들 런처는 이 파일만 가리킨다. 경로를 런처에 구워두면 그 경로가
# 사라져도 아무도 못 고치기 때문이다 — 한 번은 검증용 /private/tmp 경로가
# 런처에 박힌 채 남아서, tmp 가 비워진 뒤로 앱이 조용히 안 켜졌다.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_HOME="${RUBATO_T3_HOME:-$HOME/.rubato/t3-home}"
BUNDLE="$T3_DIR/apps/desktop/dist-electron/main.cjs"

# 더블클릭으로 켜면 stderr 를 아무도 안 본다. 실패는 창으로도 알린다.
die() {
  printf 'Rubato GUI: %s\n' "$1" >&2
  if [ ! -t 2 ] && [ "$(uname -s)" = Darwin ]; then
    /usr/bin/osascript -e "display alert \"Rubato\" message \"$1\"" >/dev/null 2>&1
  fi
  exit 1
}

# node 고르는 자리는 하나뿐이다. Dock 에서 켜면 PATH 가 /usr/bin:/bin 수준이라
# nvm node 가 안 보이고, 시스템 node 로는 T3 가 안 돈다.
. "$HERE/../scripts/find-node.sh"
NODE="$(rubato_find_node)" || die "Node 24+ 가 없다. nodejs.org 에서 설치한 뒤 다시 켜라."
export PATH="$(dirname "$NODE"):$PATH"

# 소스가 아니라 산출물을 본다. 클론만 해도 scripts/start-electron.mjs 는
# 생기므로, 그 파일로 게이트하면 빌드가 없는 설치를 멀쩡하다고 오판한다.
[ -f "$BUNDLE" ] || die "데스크톱이 아직 안 만들어졌다. Rubato 클론에서 ./install.sh --apply --gui 를 돌려라."

# Pi 세션 서버는 브리지가 띄운다. 여기서도 띄우면 살아있는지 판정하는 곳이
# 둘이 되고, 앱 번들을 바로 켜는 경로는 어차피 이 스크립트를 안 지난다.
export T3CODE_HOME="$T3_HOME"
cd "$T3_DIR/apps/desktop" || die "T3 소스가 없다. Rubato 클론에서 ./install.sh --apply --gui 를 돌려라."
exec "$NODE" scripts/start-electron.mjs
