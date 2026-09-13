#!/bin/bash
# T3 Code를 Rubato 공식 GUI로 깐다. 화면 제공자 이름은 Rubato다.
# 내부 driver id는 rubato-pi로 남긴다.
#
# 기본은 계획만 출력한다. 적용은 --apply.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --help|-h)
      printf '%s\n' '사용법: harness/t3-integration/install-gui.sh [--apply]' \
        '  T3 Code를 받아 Rubato overlay를 얹고, 제공자 이름을 Rubato로 연결한다.'
      exit 0 ;;
    *) printf '모르는 옵션: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$RST" "$1"; }
err()  { printf '  %s✗%s %s\n' "$RED" "$RST" "$1"; }
say()  { printf '  %s\n' "$1"; }
plan() { printf '    %s[계획]%s %s\n' "$DIM" "$RST" "$1"; }

T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_HOME="${RUBATO_T3_HOME:-$HOME/.rubato/t3-home}"
PIN="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).upstreamCommit)" "$HERE/upstream.json")"
AGENT_DIR="${RUBATO_PI_CODING_AGENT_DIR:-$HOME/.rubato-pi/agent}"
BRIDGE="$HERE/src/bridge.mjs"
DESCRIPTOR="$AGENT_DIR/server/connection.json"

printf '\n%s== T3 GUI ==%s\n' "$BOLD" "$RST"
if [ "$APPLY" -eq 0 ]; then
  plan "T3 $PIN 을 $T3_DIR 에 받는다"
  plan "overlay를 적용하고 제공자 이름을 Rubato로 쓴다"
  plan "T3 데이터는 $T3_HOME, Pi 서버는 $AGENT_DIR"
  plan "데스크톱을 빌드할 수 있으면 빌드하고, rubato-gui 로 띄운다"
  exit 0
fi

mkdir -p "$(dirname "$T3_DIR")" "$T3_HOME/userdata"
if [ ! -d "$T3_DIR/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/pingdotgg/t3code.git "$T3_DIR" || {
    err "T3 클론 실패"; exit 1
  }
fi
git -C "$T3_DIR" fetch --depth 1 origin "$PIN" || { err "T3 fetch 실패"; exit 1; }
git -C "$T3_DIR" checkout --force FETCH_HEAD || { err "T3 checkout 실패"; exit 1; }
ok "T3 $PIN"

node "$HERE/apply.mjs" --t3 "$T3_DIR" || { err "overlay 적용 실패"; exit 1; }
ok "Rubato overlay"

export RUBATO_GUI_T3_HOME="$T3_HOME"
export RUBATO_GUI_BRIDGE="$BRIDGE"
export RUBATO_GUI_DESCRIPTOR="$DESCRIPTOR"
export RUBATO_GUI_CATALOGUE="${HOME}"
node "$HERE/write-gui-settings.mjs" || { err "T3 설정 실패"; exit 1; }
ok "제공자 이름 Rubato, 프로젝트 트리 사이드바"

if [ -f "$T3_DIR/package.json" ] && [ -x "$T3_DIR/node_modules/.bin/vp" ]; then
  say "이미 있는 T3 툴체인으로 데스크톱을 빌드한다"
  (cd "$T3_DIR" && ./node_modules/.bin/vp run --filter @t3tools/desktop --filter t3 build) || warn "데스크톱 빌드를 건너뛴다"
elif command -v vp >/dev/null 2>&1; then
  say "vp로 의존성을 설치하고 데스크톱을 빌드한다"
  (cd "$T3_DIR" && vp i && vp run --filter @t3tools/desktop --filter t3 build) || warn "데스크톱 빌드를 건너뛴다"
else
  warn "vp가 없어 데스크톱 바이너리는 안 만들었다. https://vite.plus 설치 뒤 다시 --apply"
fi

ok "GUI 설치 끝. 실행: rubato-gui"
exit 0
