#!/bin/bash
# T3 Code를 Rubato 공식 GUI로 깐다. 화면 제공자 이름은 Rubato다.
# 터미널 실행기는 Rubato CLI다. 내부 driver id는 rubato-pi로 남긴다.
#
# 기본은 계획만 출력한다. 적용은 --apply.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# Tests and callers may pin this. Unset means the machine we are on.
HOST_OS="${RUBATO_HOST_OS:-$(uname -s)}"
is_darwin() { [ "$HOST_OS" = Darwin ]; }
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
DEPS_STAMP="$T3_DIR/.rubato-gui-deps"

# T3 는 packageManager 로 pnpm 을 선언하고, 그 설치가 vite-plus 를 devDependency
# 로 끌어온다. 그래서 전역 vp 가 없어도 빌드는 된다 — 예전에는 여기서 전역 vp 만
# 찾다가, 없으면 빌드를 건너뛰고도 "더블클릭으로 켠다"고 말하는 빈 앱을 남겼다.
#
# 설치 여부는 vp 의 존재가 아니라 lockfile 로 판단한다. vp 만 보면, 핀이 올라가며
# 새 의존성이 늘어도 옛 node_modules 를 그대로 쓰고 빌드에서 resolve 실패로 터진다
# (@daypicker/react). 락파일이 달라졌으면 받는다.
#
# 도장은 build_desktop 안에서만 찍으면 안 된다. 지문이 맞아 빌드를 통째로 건너뛰는
# 길에서는 node_modules 가 이미 이 핀의 것인데도 도장이 비어 있어, 다음 업데이트가
# 멀쩡한 설치를 다시 받는다. 두 길 모두에서 남긴다.
record_deps_stamp() {
  deps_hash="$(cd "$T3_DIR" 2>/dev/null && shasum -a 256 pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)"
  [ -n "$deps_hash" ] || return 0
  [ "$(cat "$DEPS_STAMP" 2>/dev/null || true)" = "$deps_hash" ] && return 0
  printf '%s\n' "$deps_hash" > "$DEPS_STAMP"
}
build_desktop() {
  (
    cd "$T3_DIR" || exit 1
    export PATH="$(dirname "$NODE"):$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    want_deps="$(shasum -a 256 pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)"
    if [ ! -x node_modules/.bin/vp ] || [ -z "$want_deps" ] \
      || [ "$(cat "$DEPS_STAMP" 2>/dev/null || true)" != "$want_deps" ]; then
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
      [ -n "$want_deps" ] && printf '%s\n' "$want_deps" > "$DEPS_STAMP"
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

# 핀과 overlay 소스를 합친 지문. rubato update 와 rubato restart 가 매번 이
# 스크립트를 부르므로, 이미 맞는 설치는 다시 빌드하지 않고 지나가야 한다.
#
# 여기에 들어가는 것은 **T3 번들에 컴파일돼 들어가는 것뿐**이다. src/ 는 아니다:
# 브리지(src/bridge.mjs 등)는 번들에 들어가지 않고, 앱이 켜질 때
# write-gui-settings.mjs 가 적어둔 절대경로로 레포에서 곧장 import 된다
# (overlay/apps/server/src/provider/Drivers/RubatoPiDriver.ts 의
# `import(config.bridgeModule)`). 그래서 브리지를 고쳤을 때 필요한 것은 앱을 껐다
# 켜는 것뿐인데, 예전에는 src/ 가 이 지문에 섞여 있어서 한 줄만 고쳐도 데스크톱
# 전체 빌드가 돌았다 — 결과 번들은 한 바이트도 달라지지 않는데.
#
# 이 식이 바뀌었으므로 기존 설치는 한 번 더 빌드하고, 그 다음부터 짧아진다.
build_fingerprint() {
  {
    printf '%s\n' "$PIN"
    find "$HERE/overlay" -type f -exec shasum -a 256 {} + 2>/dev/null | sort
    shasum -a 256 "$HERE/apply.mjs" "$HERE/write-gui-settings.mjs" 2>/dev/null
    shasum -a 256 "$HERE/assets/Rubato.png" "$HERE/assets/Rubato.icns" 2>/dev/null
  } | shasum -a 256 | cut -d' ' -f1
}

printf '\n%s== T3 GUI ==%s\n' "$BOLD" "$RST"
if [ "$APPLY" -eq 0 ]; then
  plan "T3 $PIN 을 $T3_DIR 에 받는다"
  plan "overlay를 적용하고 이름·아이콘·제공자를 Rubato로 쓴다"
  plan "T3 데이터는 $T3_HOME, Pi 서버는 $AGENT_DIR"
  plan "SSH 원격 진입점 $HOME/.rubato/t3-remote-server.mjs 를 만든다"
  if is_darwin; then
    plan "데스크톱을 빌드하고 /Applications/Rubato.app 을 만든다"
  else
    plan "데스크톱을 빌드한다. 실행은 start-gui.sh (T3 electron)"
  fi
  exit 0
fi

mkdir -p "$(dirname "$T3_DIR")" "$T3_HOME/userdata"
if [ ! -d "$T3_DIR/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/pingdotgg/t3code.git "$T3_DIR" || {
    err "T3 클론 실패"; exit 1
  }
fi
# `rubato restart` 도 이 스크립트를 거치므로, 핀이 이미 내려와 있으면 네트워크를
# 치지 않는다. 그러지 않으면 비행기 안에서 앱을 다시 켜는 것조차 fetch 실패로
# 막힌다. 받아야 할 때만 받고, 체크아웃은 FETCH_HEAD 가 아니라 핀 자체로 한다.
if ! git -C "$T3_DIR" cat-file -e "$PIN^{commit}" 2>/dev/null; then
  git -C "$T3_DIR" fetch --depth 1 origin "$PIN" || { err "T3 fetch 실패"; exit 1; }
fi
git -C "$T3_DIR" checkout --force "$PIN" || { err "T3 checkout 실패"; exit 1; }
ok "T3 $PIN"

"$NODE" "$HERE/apply.mjs" --t3 "$T3_DIR" || { err "overlay 적용 실패"; exit 1; }
ok "Rubato overlay"

# T3 는 assets 에서 아이콘을 읽어 Dock 타일과 런타임 번들 아이콘을 만든다.
# 읽는 경로를 바꾸는 대신 그 자리에 Rubato 것을 깔아둔다 — 경로를 바꾸면 그
# 절대 경로가 소스에 박혀 머신마다 달라지고, 레포를 옮기면 그림이 사라진다.
# 위 checkout 이 매번 upstream 파일로 되돌리므로 여기서 다시 깐다.
for target in assets/prod/black-macos-1024.png assets/prod/black-universal-1024.png; do
  if [ -f "$T3_DIR/$target" ]; then
    cp "$HERE/assets/Rubato.png" "$T3_DIR/$target" || warn "아이콘 교체 실패: $target"
  fi
done
ok "아이콘 Rubato"

export RUBATO_GUI_T3_HOME="$T3_HOME"
export RUBATO_GUI_BRIDGE="$BRIDGE"
export RUBATO_GUI_DESCRIPTOR="$DESCRIPTOR"
export RUBATO_GUI_CATALOGUE="${HOME}"
"$NODE" "$HERE/write-gui-settings.mjs" || { err "T3 설정 실패"; exit 1; }
ok "제공자 이름 Rubato, 프로젝트 트리 사이드바"

# 다른 기계의 데스크톱이 이 기계를 SSH 환경으로 붙일 때 부르는 진입점이다.
# overlay 가 데스크톱의 원격 실행기를 원격 $HOME 기준 이 경로로 고정한다
# (apply.mjs 의 apps/desktop/src/main.ts 편집). 경로를 바꾸면 거기도 바꿔야 한다.
REMOTE_ENTRY="$HOME/.rubato/t3-remote-server.mjs"
mkdir -p "$(dirname "$REMOTE_ENTRY")"
"$NODE" -e '
const [out, mod, t3Source, t3Home, node] = process.argv.slice(1);
const q = JSON.stringify;
const url = require("node:url").pathToFileURL(mod).href;
require("node:fs").writeFileSync(out, [
  "// install-gui.sh 가 만든다. 고치지 말고 install-gui.sh --apply 를 다시 돌려라.",
  `import { startRemoteServer } from ${q(url)};`,
  `await startRemoteServer({ t3Source: ${q(t3Source)}, t3Home: ${q(t3Home)}, node: ${q(node)} });`,
  "",
].join("\n"));
' "$REMOTE_ENTRY" "$HERE/remote-server.mjs" "$T3_DIR" "$T3_HOME" "$NODE" \
  && ok "SSH 원격 진입점 $REMOTE_ENTRY" || warn "SSH 원격 진입점을 만들지 못했다: $REMOTE_ENTRY"

WANT="$(build_fingerprint)"
built=0
if [ -f "$BUNDLE" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
  ok "데스크톱은 이미 이 핀에 맞다"
  record_deps_stamp
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

# 맥 앱 번들은 맥에만 만든다. T3 런처는 비-Darwin 에서 electron 바이너리를
# 그대로 돌려서, 윈도우는 start-gui.sh → start-electron.mjs 가 곧 실행 경로다.
if is_darwin; then
  # bash 로 부른다. 실행 비트는 전송 중에 쉽게 사라지고, 그때 이 줄은 조용히
  # 실패해서 아래의 "응용 프로그램: " 이 빈 경로를 성공처럼 찍었다.
  APP="$(bash "$HERE/install-macos-app.sh")" || APP=''
  if [ -z "$APP" ]; then
    err "응용 프로그램을 만들지 못했다: $HERE/install-macos-app.sh"
    exit 1
  fi
  if [ "$built" = 1 ]; then
    ok "응용 프로그램: $APP  (더블클릭으로 켠다)"
    exit 0
  fi
  err "$APP 은 만들었지만 데스크톱이 없어서 아직 안 켜진다"
  exit 1
fi

if [ "$built" = 1 ]; then
  ok "데스크톱. 실행: sh $HERE/start-gui.sh"
  exit 0
fi
err "데스크톱이 없어서 아직 안 켜진다"
exit 1
