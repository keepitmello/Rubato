#!/bin/bash
# T3 Code를 Rubato 공식 GUI로 깐다. 화면 제공자 이름은 Rubato다.
# 터미널 실행기는 Rubato CLI다. 내부 driver id는 rubato-pi로 남긴다.
#
# 기본은 계획만 출력한다. 적용은 --apply.
#
# --prepare 는 앱이 켜져 있어도 되는 일만 한다. 소스를 핀 + overlay 로 맞추고, 번들이
# 낡았으면 켜진 앱이 읽는 폴더 옆(<폴더>.rubato-next)에 빌드한다. 앱 실행용 번들
# (.electron-runtime)과 서명은 건드리지 않는다. 그다음 --apply 는 앱이 내려간 사이에
# 미리 만든 폴더를 이름만 바꿔 끼운다 — 예전에는 앱을 끈 채로 30초 남짓 빌드했다.
# --prepare 의 종료 코드:
#   0   번들이 이미 이 소스에 맞다
#   10  새 번들을 옆에 만들어 뒀다 (앱을 껐다 켜야 한다)
#   11  의존성이 바뀌어 미리 만들 수 없다 (앱을 끈 뒤 --apply 가 받고 빌드한다)
#   1   실패
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# Tests and callers may pin this. Unset means the machine we are on.
HOST_OS="${RUBATO_HOST_OS:-$(uname -s)}"
is_darwin() { [ "$HOST_OS" = Darwin ]; }
APPLY=0
PREPARE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --prepare) APPLY=1; PREPARE=1 ;;
    --help|-h)
      printf '%s\n' '사용법: harness/t3-integration/install-gui.sh [--apply | --prepare]' \
        '  T3 Code를 받아 Rubato overlay를 얹고, 제공자 이름을 Rubato로 연결한다.' \
        '  --prepare 는 앱을 켜 둔 채 새 번들을 옆 폴더에 미리 빌드한다.'
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
# 미리 만든 번들. 켜진 앱이 읽는 세 폴더마다 옆에 같은 이름 + 접미사로 만든다.
# 도장은 그 번들이 어느 지문으로 만들어졌는지다.
STAGE_SUFFIX=.rubato-next
STAGED_STAMP="$T3_DIR/.rubato-gui-staged"
OUTPUT_DIRS="apps/web/dist apps/server/dist apps/desktop/dist-electron"
RUNTIME_STAMP="$T3_DIR/.rubato-gui-runtime"

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
# node_modules 가 이 락파일로 받은 그대로인가. 아니면 받는 일이 켜진 앱이 쓰는
# node_modules 를 바꾸므로, 미리 빌드하지 않고 앱을 끈 뒤로 미룬다.
deps_current() {
  [ -x "$T3_DIR/node_modules/.bin/vp" ] || return 1
  want_deps="$(cd "$T3_DIR" 2>/dev/null && shasum -a 256 pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)"
  [ -n "$want_deps" ] && [ "$(cat "$DEPS_STAMP" 2>/dev/null || true)" = "$want_deps" ]
}
# T3 의 `vp run --filter @t3tools/desktop --filter t3 build` 와 같은 세 단계를, 각각
# 켜진 앱이 읽는 폴더 옆에 쓰게 해서 차례로 돈다. vp run 을 거치지 않는 이유: 작업
# 실행기는 정해진 환경변수만 작업에 넘기는데, 출력 위치가 거기서 빠지면 빌드는 켜진
# 앱의 폴더에 그대로 쏟아진다. 여기서는 각 단계에 위치를 직접 준다. 단계가 T3 와
# 갈라지면 install-gui.test.mjs 가 잡는다.
staged_build() {
  (
    cd "$T3_DIR" || exit 1
    export PATH="$(dirname "$NODE"):$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    vp="$T3_DIR/node_modules/.bin/vp"
    # 서버 빌드가 옆 폴더에 쓰는 것은 staged-build-edits.mjs 의 편집 덕분이다. 그 편집이
    # 빠진 트리에서 돌리면 켜진 앱이 읽는 apps/server/dist 를 지우고 다시 쓴다.
    grep -q 'RUBATO_T3_OUT_SUFFIX' apps/server/scripts/cli.ts || {
      printf '  서버 빌드 스크립트에 옆 폴더 편집이 없다 — 앱을 끈 뒤에 빌드한다\n' >&2
      exit 1
    }
    for dir in $OUTPUT_DIRS; do rm -rf "$dir$STAGE_SUFFIX"; done
    (cd apps/web && "$vp" build --outDir "dist$STAGE_SUFFIX" --emptyOutDir) || exit 1
    (cd apps/server && RUBATO_T3_OUT_SUFFIX="$STAGE_SUFFIX" "$NODE" scripts/cli.ts build) || exit 1
    (cd apps/desktop && "$NODE" scripts/build-browser-secret.mjs \
      && "$NODE" scripts/build-preview-annotation-css.mjs \
      && "$vp" pack --out-dir "dist-electron$STAGE_SUFFIX") || exit 1
    staged_complete
  )
}
staged_complete() {
  [ -f "$T3_DIR/apps/web/dist$STAGE_SUFFIX/index.html" ] \
    && [ -f "$T3_DIR/apps/server/dist$STAGE_SUFFIX/bin.mjs" ] \
    && [ -f "$T3_DIR/apps/server/dist$STAGE_SUFFIX/client/index.html" ] \
    && [ -f "$T3_DIR/apps/desktop/dist-electron$STAGE_SUFFIX/main.cjs" ]
}
# 앱이 내려간 사이에 미리 만든 폴더를 이름만 바꿔 끼운다. 하나라도 못 바꾸면
# 바꾼 것을 되돌리고 실패한다 — 그러면 부르는 쪽이 그 자리에서 빌드한다.
swap_staged() {
  (
    cd "$T3_DIR" || exit 1
    staged_complete || exit 1
    swapped=''
    for dir in $OUTPUT_DIRS; do
      rm -rf "$dir.rubato-old"
      if { [ ! -e "$dir" ] || mv "$dir" "$dir.rubato-old"; } && mv "$dir$STAGE_SUFFIX" "$dir"; then
        swapped="$swapped $dir"
        continue
      fi
      # 이 폴더는 옛것만 옮겨졌을 수 있다. 앞서 바꾼 폴더는 새것을 도로 옆에 두고 옛것을 돌린다.
      [ ! -e "$dir" ] && [ -e "$dir.rubato-old" ] && mv "$dir.rubato-old" "$dir"
      for back in $swapped; do
        mv "$back" "$back$STAGE_SUFFIX" && mv "$back.rubato-old" "$back"
      done
      exit 1
    done
    rm -f "$STAGED_STAMP"
    # 옛 번들 300MB 를 지우는 데 앱이 기다릴 이유는 없다.
    for dir in $OUTPUT_DIRS; do
      [ -d "$dir.rubato-old" ] && { nohup rm -rf "$dir.rubato-old" >/dev/null 2>&1 & }
    done
    exit 0
  )
}
# 앱 실행용 번들(.electron-runtime)을 다시 만들어야 하는 입력: 아이콘, 그리고 이름과
# 번들 id 를 정하는 런처·package.json. 번들 코드(dist-electron)는 번들 밖에서 읽으므로
# 여기 들지 않는다. 예전에는 빌드할 때마다 비워서, 켤 때마다 290MB 를 다시 복사하고
# 다시 서명했다.
runtime_fingerprint() {
  shasum -a 256 "$HERE/assets/Rubato.png" "$HERE/assets/Rubato.icns" \
    "$T3_DIR/apps/desktop/scripts/electron-launcher.mjs" "$T3_DIR/apps/desktop/package.json" 2>/dev/null \
    | cut -d' ' -f1 | shasum -a 256 | cut -d' ' -f1
}
build_desktop() {
  (
    cd "$T3_DIR" || exit 1
    export PATH="$(dirname "$NODE"):$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    want_deps="$(shasum -a 256 pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)"
    # T3 의 pnpm-workspace.yaml 은 supportedArchitectures 에 linux 와 x64 를 더해 둬서,
    # 맥에서도 workerd·tsgo·lightningcss 같은 네이티브 바이너리를 리눅스·인텔용까지
    # 네 벌씩 받는다. 맥 설치는 그중 이 기계 것만 쓴다. 빈 저장소에서 새로 깔 때
    # 받는 양이 여기서 갈린다. 윈도우는 WSL 쪽이 리눅스 것을 쓸 수 있어 upstream
    # 설정을 그대로 둔다.
    arch_flags=''
    is_darwin && arch_flags="--cpu=$("$NODE" -p process.arch) --os=darwin"
    # 기계마다 깔린 vp·pnpm 버전이 제각각이다. 전역 vp 0.3.x 는 `vp i -- --cpu=…` 를
    # "Unknown options: 'cpu', 'os'" 로 거절해서, 그것 하나만 믿던 설치가 핀을 올릴
    # 때마다(락파일이 바뀌어 여기로 온다) 멈췄다. 그래서 있는 도구를 차례로 쓴다.
    # 핀이 정한 pnpm 을 그대로 받는 corepack 이 먼저다. 아키텍처 제한은 받는 양만
    # 줄이는 최적화라, 어느 도구도 그 옵션으로 못 받으면 제한 없이 한 번 더 받는다.
    #
    # 핀이 hoist 설정을 바꾸면(v0.0.45 → v0.1.0 의 publicHoistPattern) pnpm 은
    # node_modules 를 통째로 지우고 다시 깔려고 확인을 묻는다. 터미널이 없으면
    # ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY 로 그만둔다 — 앱의 업데이트 버튼
    # 경로가 그렇다. 지우는 것은 핀이 정한 설치로 되돌리는 것이라 묻지 않는다.
    # 환경변수(npm_config_/pnpm_config_)로는 pnpm 11 이 이 설정을 안 읽는다.
    install_deps() {
      set -- --config.confirm-modules-purge=false "$@"
      if command -v corepack >/dev/null 2>&1 && corepack pnpm install "$@"; then return 0; fi
      if [ -x node_modules/.bin/vp ] && ./node_modules/.bin/vp i -- "$@"; then return 0; fi
      if command -v vp >/dev/null 2>&1 && vp i -- "$@"; then return 0; fi
      if command -v pnpm >/dev/null 2>&1 && pnpm install "$@"; then return 0; fi
      return 1
    }
    if [ ! -x node_modules/.bin/vp ] || [ -z "$want_deps" ] \
      || [ "$(cat "$DEPS_STAMP" 2>/dev/null || true)" != "$want_deps" ]; then
      if ! command -v corepack >/dev/null 2>&1 && [ ! -x node_modules/.bin/vp ] \
        && ! command -v vp >/dev/null 2>&1 && ! command -v pnpm >/dev/null 2>&1; then
        printf '  pnpm 도 vp 도 없다\n' >&2
        exit 1
      fi
      if ! install_deps $arch_flags; then
        [ -n "$arch_flags" ] || exit 1
        printf '  이 기계 것만 받기에 실패해 모든 아키텍처로 다시 받는다\n' >&2
        install_deps || exit 1
      fi
      [ -n "$want_deps" ] && printf '%s\n' "$want_deps" > "$DEPS_STAMP"
    fi
    # 앱이 꺼져 있어도 제자리에 바로 쓰지 않는다. 빌드가 도중에 실패하거나 끊기면
    # 세 폴더 중 일부만 새것이 되고, 옛 번들로 다시 켠 앱은 그 섞인 것을 읽는다.
    # 옆에 다 만든 뒤에만 바꿔 끼우면 실패해도 옛 번들이 통째로 남는다.
    if [ -x node_modules/.bin/vp ] && grep -q 'RUBATO_T3_OUT_SUFFIX' apps/server/scripts/cli.ts 2>/dev/null; then
      staged_build && swap_staged
    elif [ -x node_modules/.bin/vp ]; then
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
    # apply.mjs 가 읽는 *-edits.mjs 는 전부 넣는다. 이름으로 나열했더니 나중에 생긴 것이 빠졌다.
    shasum -a 256 "$HERE/apply.mjs" "$HERE"/*-edits.mjs "$HERE/write-gui-settings.mjs" 2>/dev/null
    shasum -a 256 "$HERE/assets/Rubato.png" "$HERE/assets/Rubato.icns" 2>/dev/null
    find "$HERE/assets/web" -type f -exec shasum -a 256 {} + 2>/dev/null | sort
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

# 소스를 핀 + overlay 로 맞추고 설정·진입점을 쓴다. restart-gui.sh 가 같은 잠금 안에서
# 방금 --prepare 로 이 일을 마쳤으면(RUBATO_GUI_PREPARED=1) 앱이 내려간 사이에 다시 하지
# 않는다 — 그동안 소스가 바뀔 틈이 없고, 앱이 꺼져 있는 시간만 1초 남짓 는다.
if is_darwin; then
  bash "$HERE/install-macos-app.sh" --check-target || exit 1
fi
prepare_sources() {
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
# 아래 checkout --force 와 overlay 는 t3-source 를 핀 + overlay 로 되돌린다. 그 전에
# 거기서 사람이 고친 파일을 옮겨 둔다 — 말없이 지우지도, 설치를 막지도 않는다.
PRESERVE_DIR="$HOME/.rubato-pi/backups/t3-source/$(date +%Y%m%d-%H%M%S)"
if [ -f "$T3_DIR/.rubato-pi-overlay.json" ]; then
  PRESERVED="$("$NODE" "$HERE/apply.mjs" --t3 "$T3_DIR" --preserve-edits "$PRESERVE_DIR")" || { err "t3-source 수정 보존 실패"; exit 1; }
  case "$PRESERVED" in
    *'"preserved":[]'*) : ;;
    *) warn "t3-source 에서 고친 파일을 옮겨 두고 핀으로 되돌렸다: $PRESERVE_DIR" ;;
  esac
fi
git -C "$T3_DIR" checkout --force "$PIN" || { err "T3 checkout 실패"; exit 1; }
ok "T3 $PIN"

"$NODE" "$HERE/apply.mjs" --t3 "$T3_DIR" || { err "overlay 적용 실패"; exit 1; }
ok "Rubato overlay"

# T3 는 assets 에서 아이콘을 읽어 Dock 타일과 런타임 번들 아이콘을 만든다.
# 읽는 경로를 바꾸는 대신 그 자리에 Rubato 것을 깔아둔다 — 경로를 바꾸면 그
# 절대 경로가 소스에 박혀 머신마다 달라지고, 레포를 옮기면 그림이 사라진다.
# 위 checkout 이 매번 upstream 파일로 되돌리므로 여기서 다시 깐다.
# 수정 시각은 레포의 원본 것으로 맞춘다. 런처는 이 파일이 만들어 둔 아이콘보다
# 새로우면 아이콘을 다시 만들고, 그러면 앱 실행용 번들 전체를 다시 복사하고 서명한다.
# 복사할 때마다 시각이 지금으로 바뀌어 재시작마다 그 일이 일어났다. 그림이 정말
# 바뀌면 runtime_fingerprint 가 그 번들을 비운다.
for target in assets/prod/black-macos-1024.png assets/prod/black-universal-1024.png; do
  if [ -f "$T3_DIR/$target" ]; then
    { cp "$HERE/assets/Rubato.png" "$T3_DIR/$target" && touch -r "$HERE/assets/Rubato.png" "$T3_DIR/$target"; } \
      || warn "아이콘 교체 실패: $target"
  fi
done
# 웹 쪽 진입점 — 부트 스플래시, 브라우저 탭, 아이폰 홈 화면 — 은 apps/web/public 의
# 같은 이름 파일을 읽는다. T3 원본처럼 모서리가 투명한 타일이고, Rubato.png 의
# 여백을 잘라 크기별로 미리 만들어 둔 것이다(assets/web).
for icon in "$HERE"/assets/web/*; do
  cp "$icon" "$T3_DIR/apps/web/public/$(basename "$icon")" || warn "아이콘 교체 실패: $(basename "$icon")"
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
  `startRemoteServer({ t3Source: ${q(t3Source)}, t3Home: ${q(t3Home)}, node: ${q(node)} });`,
  "",
].join("\n"));
' "$REMOTE_ENTRY" "$HERE/remote-server.mjs" "$T3_DIR" "$T3_HOME" "$NODE" \
  && ok "SSH 원격 진입점 $REMOTE_ENTRY" || warn "SSH 원격 진입점을 만들지 못했다: $REMOTE_ENTRY"
}
if [ "$PREPARE" = 1 ] || [ "${RUBATO_GUI_PREPARED-}" != 1 ]; then
  prepare_sources
fi

WANT="$(build_fingerprint)"

# 앱이 켜져 있을 수 있다. 켜진 앱이 읽는 폴더는 건드리지 않고 옆에만 만든다.
if [ "$PREPARE" = 1 ]; then
  if [ -f "$BUNDLE" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
    ok "데스크톱은 이미 이 핀에 맞다"
    record_deps_stamp
    exit 0
  fi
  if [ "$(cat "$STAGED_STAMP" 2>/dev/null || true)" = "$WANT" ] && staged_complete; then
    ok "새 데스크톱 번들은 이미 옆에 만들어 뒀다"
    exit 10
  fi
  if ! deps_current; then
    say "의존성이 바뀌었다. 앱을 끈 뒤에 받고 빌드한다"
    exit 11
  fi
  say "새 데스크톱 번들을 옆에 만든다 ${DIM}(앱은 켜 둔 채로)${RST}"
  rm -f "$STAGED_STAMP"
  if staged_build; then
    printf '%s\n' "$WANT" > "$STAGED_STAMP"
    ok "새 데스크톱 번들 (켤 때 바꿔 끼운다)"
    exit 10
  fi
  err "데스크톱 빌드 실패"
  exit 1
fi

built=0
if [ -f "$BUNDLE" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
  ok "데스크톱은 이미 이 핀에 맞다"
  record_deps_stamp
  built=1
elif [ "$(cat "$STAGED_STAMP" 2>/dev/null || true)" = "$WANT" ] && swap_staged; then
  printf '%s\n' "$WANT" > "$STAMP"
  ok "데스크톱 번들을 미리 만든 것으로 바꿨다"
  record_deps_stamp
  built=1
else
  say "데스크톱을 빌드한다 ${DIM}(처음이면 몇 분 걸려요)${RST}"
  if build_desktop; then
    printf '%s\n' "$WANT" > "$STAMP"
    # 다른 지문으로 미리 만들어 둔 번들이 있었다면 이제 쓸 일이 없다.
    for dir in $OUTPUT_DIRS; do rm -rf "$T3_DIR/$dir$STAGE_SUFFIX"; done
    rm -f "$STAGED_STAMP"
    ok "데스크톱 빌드"
    built=1
  else
    err "데스크톱 빌드 실패"
  fi
fi

# T3 런처는 아이콘을 mtime 으로만 판단해서, 원본을 Rubato 것으로 바꿔도 먼저 만들어
# 둔 icns 를 그대로 쓸 수 있다. 이름이 바뀌면 옛 이름의 런타임 번들도 옆에 남는다.
# 그 입력이 바뀌었을 때만 비우고 다음 실행에서 다시 만들게 한다.
# 빌드가 실패했으면 비우지 않는다. 옛 번들이 앱을 켤 유일한 길이고, 비운 뒤 다시
# 만들기 전에 끊기면 /Applications/Rubato.app 은 아무것도 안 가리킨다.
RUNTIME_WANT="$(runtime_fingerprint)"
if [ "$built" = 1 ] && [ "$(cat "$RUNTIME_STAMP" 2>/dev/null || true)" != "$RUNTIME_WANT" ]; then
  rm -rf "$T3_DIR/apps/desktop/.electron-runtime"
  printf '%s\n' "$RUNTIME_WANT" > "$RUNTIME_STAMP"
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
  if [ -f "$BUNDLE" ]; then
    err "새 데스크톱을 빌드하지 못해 앱은 옛 번들로 켜진다. 다시: bash $HERE/install-gui.sh --apply"
  else
    err "$APP 은 만들었지만 데스크톱이 없어서 아직 안 켜진다. 다시: bash $HERE/install-gui.sh --apply"
  fi
  exit 1
fi

if [ "$built" = 1 ]; then
  ok "데스크톱. 실행: sh $HERE/start-gui.sh"
  exit 0
fi
if [ -f "$BUNDLE" ]; then
  err "새 데스크톱을 빌드하지 못해 앱은 옛 번들로 켜진다. 다시: bash $HERE/install-gui.sh --apply"
else
  err "데스크톱이 없어서 아직 안 켜진다. 다시: bash $HERE/install-gui.sh --apply"
fi
exit 1
