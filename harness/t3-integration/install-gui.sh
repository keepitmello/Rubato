#!/bin/bash
# T3 Code를 Rubato 공식 GUI로 깐다. 화면 제공자 이름은 Rubato다.
# 터미널 실행기는 Rubato CLI다. 내부 driver id는 rubato-pi로 남긴다.
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
. "$HERE/../scripts/find-node.sh"
NODE="$(rubato_find_node)" || { err "Node 24+ 가 없다. nodejs.org 에서 설치한 뒤 다시 실행해라."; exit 1; }
PIN="$("$NODE" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).upstreamCommit)" "$HERE/upstream.json")"
AGENT_DIR="${RUBATO_PI_CODING_AGENT_DIR:-$HOME/.rubato-pi/agent}"
BRIDGE="$HERE/src/bridge.mjs"
DESCRIPTOR="$AGENT_DIR/server/connection.json"
BUNDLE="$T3_DIR/apps/desktop/dist-electron/main.cjs"
STAMP="$T3_DIR/.rubato-gui-build"

# T3 는 packageManager 로 pnpm 을 선언하고, 그 설치가 vite-plus 를 devDependency
# 로 끌어온다. 그래서 전역 vp 가 없어도 빌드는 된다 — 예전에는 여기서 전역 vp 만
# 찾다가, 없으면 빌드를 건너뛰고도 "더블클릭으로 켠다"고 말하는 빈 앱을 남겼다.
build_desktop() {
  (
    cd "$T3_DIR" || exit 1
    export PATH="$(dirname "$NODE"):$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    if [ ! -x node_modules/.bin/vp ]; then
      if command -v vp >/dev/null 2>&1; then
        vp i || exit 1
      elif command -v corepack >/dev/null 2>&1; then
        corepack pnpm install || exit 1
      elif command -v pnpm >/dev/null 2>&1; then
        pnpm install || exit 1
      else
        printf '  pnpm 도 vp 도 없다\n' >&2
        exit 1
      fi
    fi
    if [ -x node_modules/.bin/vp ]; then
      ./node_modules/.bin/vp run --filter @t3tools/desktop --filter t3 build
    elif command -v corepack >/dev/null 2>&1; then
      corepack pnpm --filter @t3tools/desktop --filter t3 build
    else
      pnpm --filter @t3tools/desktop --filter t3 build
    fi
  )
}

# 핀과 overlay 소스를 합친 지문. rubato update 가 매번 이 스크립트를 부르므로,
# 이미 맞는 설치는 다시 빌드하지 않고 지나가야 한다.
build_fingerprint() {
  {
    printf '%s\n' "$PIN"
    find "$HERE/overlay" "$HERE/src" -type f -exec shasum -a 256 {} + 2>/dev/null | sort
    shasum -a 256 "$HERE/apply.mjs" "$HERE/write-gui-settings.mjs" 2>/dev/null
    shasum -a 256 "$HERE/../../rubato-codex/macos/Rubato.png" "$HERE/../../rubato-codex/macos/Rubato.icns" 2>/dev/null
  } | shasum -a 256 | cut -d' ' -f1
}

printf '\n%s== T3 GUI ==%s\n' "$BOLD" "$RST"
if [ "$APPLY" -eq 0 ]; then
  plan "T3 $PIN 을 $T3_DIR 에 받는다"
  plan "overlay를 적용하고 이름·아이콘·제공자를 Rubato로 쓴다"
  plan "T3 데이터는 $T3_HOME, Pi 서버는 $AGENT_DIR"
  plan "데스크톱을 빌드하고 /Applications/Rubato.app 을 만든다"
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

"$NODE" "$HERE/apply.mjs" --t3 "$T3_DIR" || { err "overlay 적용 실패"; exit 1; }
ok "Rubato overlay"

export RUBATO_GUI_T3_HOME="$T3_HOME"
export RUBATO_GUI_BRIDGE="$BRIDGE"
export RUBATO_GUI_DESCRIPTOR="$DESCRIPTOR"
export RUBATO_GUI_CATALOGUE="${HOME}"
"$NODE" "$HERE/write-gui-settings.mjs" || { err "T3 설정 실패"; exit 1; }
ok "제공자 이름 Rubato, 프로젝트 트리 사이드바"

WANT="$(build_fingerprint)"
built=0
if [ -f "$BUNDLE" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
  ok "데스크톱은 이미 이 핀에 맞다"
  built=1
else
  say "데스크톱을 빌드한다 ${DIM}(처음이면 몇 분 걸려요)${RST}"
  if build_desktop; then
    # T3 런처는 아이콘을 mtime 으로만 판단해서, 원본을 Rubato 것으로 바꿔도
    # 먼저 만들어 둔 icns 를 그대로 쓴다. 이름이 바뀌면 옛 이름의 런타임 번들도
    # 옆에 남는다. 설치할 때 비우고 다음 실행에서 다시 만들게 한다.
    rm -rf "$T3_DIR/apps/desktop/.electron-runtime"
    printf '%s\n' "$WANT" > "$STAMP"
    ok "데스크톱 빌드"
    built=1
  else
    err "데스크톱 빌드 실패"
  fi
fi

APP="$("$HERE/install-macos-app.sh")"
if [ "$built" = 1 ]; then
  ok "응용 프로그램: $APP  (더블클릭으로 켠다)"
  exit 0
fi
err "$APP 은 만들었지만 데스크톱이 없어서 아직 안 켜진다"
exit 1
