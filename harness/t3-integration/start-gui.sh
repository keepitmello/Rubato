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
AGENT_DIR="${RUBATO_PI_CODING_AGENT_DIR:-$HOME/.rubato-pi/agent}"
BUNDLE="$T3_DIR/apps/desktop/dist-electron/main.cjs"

# Dock 에 뜨는 이름·아이콘·번들 id. overlay 가 T3 런처를 이 값들에 맞춰 놨고,
# 안 주면 T3 기본값("T3 Code (Alpha)")으로 돌아간다.
export RUBATO_GUI_APP_NAME="${RUBATO_GUI_APP_NAME:-Rubato}"
export RUBATO_GUI_BUNDLE_ID="${RUBATO_GUI_BUNDLE_ID:-app.rubato.t3}"
export RUBATO_GUI_ICON_PNG="${RUBATO_GUI_ICON_PNG:-$HERE/../../rubato-codex/macos/Rubato.png}"

# 더블클릭으로 켜면 stderr 를 아무도 안 본다. 실패는 창으로도 알린다.
die() {
  printf 'Rubato GUI: %s\n' "$1" >&2
  if [ ! -t 2 ]; then
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
[ -f "$BUNDLE" ] || die "데스크톱이 아직 안 만들어졌다. 터미널에서 rubato update 를 돌려라."

mkdir -p "$AGENT_DIR"
if [ ! -S "$AGENT_DIR/server/pi.sock" ]; then
  "$NODE" "$HERE/../pi-server/src/cli.mjs" --agent-dir "$AGENT_DIR" >/tmp/rubato-pi-server.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$AGENT_DIR/server/pi.sock" ] && break
    sleep 0.3
  done
fi
[ -S "$AGENT_DIR/server/pi.sock" ] || die "Rubato 세션 서버가 안 떴다. /tmp/rubato-pi-server.log 를 봐라."

export T3CODE_HOME="$T3_HOME"
cd "$T3_DIR/apps/desktop" || die "T3 소스가 없다. 터미널에서 rubato update 를 돌려라."
exec "$NODE" scripts/start-electron.mjs
