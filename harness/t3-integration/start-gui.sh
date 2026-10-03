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
HOST_OS="${RUBATO_HOST_OS:-$(uname -s)}"
OSASCRIPT_BIN="${RUBATO_OSASCRIPT_BIN:-/usr/bin/osascript}"

# 더블클릭으로 켜면 stderr 를 아무도 안 본다. 실패는 창으로도 알린다.
die() {
  printf 'Rubato GUI: %s\n' "$1" >&2
  if [ ! -t 2 ] && [ "$HOST_OS" = Darwin ]; then
    "$OSASCRIPT_BIN" -e "display alert \"Rubato\" message \"$1\"" >/dev/null 2>&1
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

# 맥에서는 앱 이름과 번들 id 를 런처(scripts/electron-launcher.mjs)가 켤 때마다 이
# 트리에서 읽어 번들을 만든다. 설치가 핀 checkout 과 overlay 사이에서 멈춘 트리는
# 그 파일이 T3 원본이라, 그대로 켜면 "T3 Code (Alpha).app" 이 새로 만들어져 떴다 —
# 재시작이 못 찾고 못 끄는 앱, 다른 권한과 다른 저장 상태. 그때는 런처를 돌리지 않고
# 마지막으로 성공한 설치가 만든 Rubato 번들로 옛 번들을 켠다. 런처가 정상일 때
# 띄우는 것과 같은 바이너리·인자·디렉터리다. 다음 설치가 트리를 다시 맞춘다.
# 윈도우·리눅스는 런처가 번들을 만들지 않고, 이름은 빌드된 main.cjs 에서 온다.
if [ "$HOST_OS" = Darwin ] && ! "$NODE" "$HERE/apply.mjs" --t3 "$T3_DIR" --verify >/dev/null 2>&1; then
  APP_BIN="$T3_DIR/apps/desktop/.electron-runtime/Rubato.app/Contents/MacOS/Electron"
  [ -x "$APP_BIN" ] || die "T3 소스가 설치 도중에 멈춘 상태다. Rubato 클론에서 ./install.sh --apply --gui 를 돌려라."
  printf 'Rubato GUI: T3 소스가 마지막 설치와 달라서 런처를 건너뛰고 마지막 Rubato 번들로 켠다\n' >&2
  unset ELECTRON_RUN_AS_NODE
  exec "$APP_BIN" dist-electron/main.cjs
fi
exec "$NODE" scripts/start-electron.mjs
