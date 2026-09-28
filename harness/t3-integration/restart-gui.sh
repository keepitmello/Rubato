#!/bin/sh
# 데스크톱 앱을 새 코드 위로 올린다. `rubato restart` 와 `rubato update` 가
# 둘 다 이 스크립트를 부른다 — 앱을 다루는 자리는 하나여야 두 동사가 갈라지지
# 않는다.
#
# 앱에는 성질이 다른 두 가지가 실린다. 브리지(harness/t3-integration/src/)는
# 앱이 켜질 때 레포에서 읽으므로 다시 켜기만 하면 되고, 핀과 overlay 는 T3 서버
# 번들에 컴파일돼 들어가므로 다시 만들어야 한다. 그래서 순서가 정해진다:
# 끄고 → 번들을 맞추고 → 켠다. 빌드가 도는 앱이 읽는 dist 를 갈아끼우기 때문에
# 앱이 내려간 그 창 말고는 안전한 자리가 없다.
#
# 무엇을 다시 만들지는 install-gui.sh 가 핀·overlay 지문으로 판단한다. 이미
# 맞는 설치는 빌드 없이 지나가므로 평소 재시작은 그대로 빠르다. 여기서 그
# 판단을 흉내내지 않는다.
#
# 종료 코드로 호출한 쪽에 결과를 말한다 — 셋은 서로 달라 보여야 한다.
#   0  무언가 했다 (번들을 맞췄거나, 껐다 켰다)
#   1  하려다 실패했다
#   2  이 머신에 데스크톱 앱이 없다
set -u

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# 진행 표시. tty 가 아니면 스스로 빠지므로 파이프·테스트가 보는 것은 그대로다.
. "$HERE/../scripts/rubato-progress.sh"

HOST_OS="${RUBATO_HOST_OS:-$(uname -s)}"
is_darwin() { [ "$HOST_OS" = Darwin ]; }

. "$HERE/../scripts/account-home.sh"

PGREP_BIN="${RUBATO_PGREP_BIN:-/usr/bin/pgrep}"
OSASCRIPT_BIN="${RUBATO_OSASCRIPT_BIN:-/usr/bin/osascript}"
GUI_APP="${RUBATO_GUI_APP:-/Applications/Rubato.app}"
T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
# 윈도우는 .app 이 없다. T3 가 켜는 것은 dist-electron/main.cjs 다.
GUI_BUNDLE="${RUBATO_GUI_BUNDLE:-$T3_DIR/apps/desktop/dist-electron/main.cjs}"
START_GUI="${RUBATO_START_GUI:-$HERE/start-gui.sh}"
INSTALL_GUI="${RUBATO_INSTALL_GUI:-$HERE/install-gui.sh}"
RESTART_SSH_SERVERS="${RUBATO_RESTART_SSH_SERVERS:-$HERE/restart-ssh-servers.sh}"
GUI_LOG="${RUBATO_GUI_LOG:-$HOME/.rubato-pi/logs/rubato-gui-restart.log}"
# 번들을 맞추는 일은 길면 몇 분이고 출력도 수십 줄이다. 그 수십 줄은 잘
# 끝났을 때 아무도 읽지 않으므로 기록으로 보내고, 화면에는 진행만 남긴다.
# 실패했을 때만 꼬리를 꺼낸다 — 그때는 읽어야 하는 내용이다.
INSTALL_LOG="${RUBATO_GUI_INSTALL_LOG:-$HOME/.rubato-pi/logs/rubato-gui-install.log}"
# 메인 Electron 바이너리로 찾는다. 헬퍼가 Rubato.app/Contents/Frameworks 밑에
# 살아서 짧은 패턴은 창이 닫힌 뒤에도 계속 걸리고, 그러면 다시 켜기가 조용히
# 건너뛰어진다. 내장 T3 서버도 같은 Contents/MacOS/Electron 경로를 쓰므로 이
# 패턴으로 기다리면 그 자식까지 덮는다.
# 비-Darwin 은 start-electron.mjs 가 넘기는 dist-electron/main.cjs 인자로 찾는다.
# macOS pgrep leaves out its own ancestors. A restart pressed in the app runs as
# the app's descendant, so without -a the running app looked closed: it was not
# quit, and a second one was opened over it.
PGREP_ARGS="-f"
if is_darwin; then
  GUI_PROC_PATTERN="${RUBATO_GUI_PROC_PATTERN:-Rubato\\.app/Contents/MacOS/Electron}"
  PGREP_ARGS="-af"
else
  GUI_PROC_PATTERN="${RUBATO_GUI_PROC_PATTERN:-dist-electron/main.cjs}"
fi
GUI_WAIT_MAX="${RUBATO_GUI_WAIT_SECS:-30}"
case "$GUI_WAIT_MAX" in
  ''|*[!0-9]*) GUI_WAIT_MAX=30 ;;
esac

sync_bundle() {
  [ -f "$INSTALL_GUI" ] || return 0
  mkdir -p "$(dirname "$INSTALL_LOG")" 2>/dev/null || true
  progress_start "데스크톱 번들을 맞추는 중"
  # install-gui.sh 는 bash 스크립트다. 리눅스의 sh(dash)로는 못 돈다.
  bash "$INSTALL_GUI" --apply >"$INSTALL_LOG" 2>&1
  sync_status=$?
  progress_stop
  if [ "$sync_status" -ne 0 ]; then
    tail -n 12 "$INSTALL_LOG" 2>/dev/null | sed 's/^/    /' >&2
    printf '    전체 기록: %s\n' "$INSTALL_LOG" >&2
  fi
  return "$sync_status"
}

# 번들을 맞춘 뒤, 다른 기계의 데스크톱이 SSH 환경으로 여기 띄워 둔 서버를 내린다.
# 데스크톱이 다시 붙으면서 새 코드로 띄운다. 내릴 것이 없으면(2) 조용히 지나간다.
restart_ssh_servers() {
  [ -f "$RESTART_SSH_SERVERS" ] || return 0
  ssh_status=0
  sh "$RESTART_SSH_SERVERS" || ssh_status=$?
  [ "$ssh_status" -ne 1 ]
}

# 앱을 끄고·번들을 맞추고·켜는 일은 한 번에 하나만 한다. `rubato restart`,
# `rubato update`, 앱의 업데이트·재시작이 모두 여기를 지나는데, 둘이 겹치면
# 같은 dist 를 동시에 쓰거나 한쪽이 번들을 만드는 사이 다른 쪽이 앱을 켠다.
# mkdir 이 원자적이라 잠금으로 쓴다. 치우는 것은 주인이 죽은 잠금뿐이고,
# pid 를 아직 못 쓴 새 잠금은 1분이 지나기 전에는 비었다고 보지 않는다.
APP_LOCK="${RUBATO_GUI_APP_LOCK:-$HOME/.rubato-pi/gui-update/app.lock}"
APP_LOCK_HELD=0
take_app_lock() {
  mkdir -p "$(dirname "$APP_LOCK")" 2>/dev/null || true
  if ! mkdir "$APP_LOCK" 2>/dev/null; then
    lock_owner="$(cat "$APP_LOCK/pid" 2>/dev/null || true)"
    case "$lock_owner" in
      ''|*[!0-9]*)
        [ -n "$(find "$APP_LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ] || return 1 ;;
      *)
        ! ps -p "$lock_owner" >/dev/null 2>&1 || return 1 ;;
    esac
    # 옮긴 뒤 다시 본다. 그사이 다른 쪽이 새로 잡았다면 그 잠금을 돌려놓는다.
    mv "$APP_LOCK" "$APP_LOCK.$$" 2>/dev/null || return 1
    if [ "$(cat "$APP_LOCK.$$/pid" 2>/dev/null || true)" != "$lock_owner" ]; then
      mv "$APP_LOCK.$$" "$APP_LOCK" 2>/dev/null || true
      return 1
    fi
    rm -rf "$APP_LOCK.$$"
    mkdir "$APP_LOCK" 2>/dev/null || return 1
  fi
  printf '%s\n' "$$" > "$APP_LOCK/pid"
  APP_LOCK_HELD=1
}
release_app_lock() {
  [ "$APP_LOCK_HELD" = 1 ] || return 0
  [ "$(cat "$APP_LOCK/pid" 2>/dev/null || true)" = "$$" ] && rm -rf "$APP_LOCK"
  APP_LOCK_HELD=0
}

# 어떻게 끝나든 그리던 줄과 커서는 되돌리고 잠금을 푼다. 신호를 받으면 멈춘다 —
# 트랩만 돌고 이어 가면 잠금 없이 앱을 다루게 된다.
trap 'progress_stop; release_app_lock' EXIT
trap 'exit 1' INT TERM

# The app and /Applications are the account's, not this HOME's (account-home.sh).
if is_darwin && [ -z "${RUBATO_GUI_APP-}" ] && ! rubato_home_is_account_home; then
  ui_skip "이 HOME 은 이 계정의 홈이 아니라서 데스크톱 앱을 건드리지 않아요"
  exit 2
fi

if [ ! -e "$GUI_APP" ]; then
  # Darwin keeps the .app gate. Windows install never creates that path;
  # presence is the T3 desktop build start-gui.sh already launches.
  if is_darwin || [ ! -f "$GUI_BUNDLE" ]; then
    ui_skip "데스크톱 앱이 없어요"
    exit 2
  fi
fi

if ! take_app_lock; then
  ui_fail "다른 재시작이나 업데이트가 데스크톱 앱을 다루는 중입니다. 끝난 뒤 다시 하세요 — 잠금: $APP_LOCK"
  exit 1
fi

if ! "$PGREP_BIN" $PGREP_ARGS "$GUI_PROC_PATTERN" >/dev/null 2>&1; then
  # 꺼진 앱은 옛 코드로 돌고 있지는 않지만 번들은 여전히 낡을 수 있고, 그것을
  # 다시 만드는 것은 아무도 하지 않는다 — start-gui.sh 는 켜기만 한다. 번들만
  # 맞추고 앱은 그대로 둔다: 이 머신이 창을 띄우고 싶어하는지는 여기서 정할
  # 일이 아니다.
  if [ "${RUBATO_GUI_UPDATE_RELAUNCH-}" = 1 ]; then
    # 사용자가 업데이트를 누른 뒤 창을 닫아도 작업은 앱을 다시 열어야 한다.
    # 아래 공통 sync/launch 경로로 간다. CLI의 '꺼진 앱은 그대로'는 유지한다.
    GUI_ALREADY_CLOSED=1
  elif [ ! -f "$INSTALL_GUI" ]; then
    ui_skip "데스크톱 앱은 이미 꺼져 있어요"
    exit 2
  elif sync_bundle; then
    ui_ok "데스크톱 번들"
    ui_note "앱은 꺼져 있어요. 다음에 켜면 새 코드로 떠요."
    # 창이 없는 기계(WSL 등)도 다른 기계의 SSH 환경으로 서버를 돌릴 수 있다.
    restart_ssh_servers || exit 1
    exit 0
  else
    ui_fail "데스크톱 앱은 꺼져 있고, 번들도 새 코드로 맞추지 못했습니다. 켜면 옛 코드입니다 — 손으로: bash \"$INSTALL_GUI\" --apply"
    exit 1
  fi
fi

# 종료는 graceful 만 쓴다. osascript `quit` 은 Dock > 종료 와 같은 이벤트라
# before-quit 핸들러가 먼저 흐른다. 내장 서버가 SQLite 를 들고 있어서 강제
# 종료는 그 파일을 어긋난 채로 남길 수 있다. 그래서 이 경로에 kill 은 없다.
# 정말 사라졌는지 보고 나서 돌아온다 — 넘겨짚지 않는다.
quit_app() {
  if is_darwin; then
    if "$OSASCRIPT_BIN" -e 'tell application "Rubato" to quit' >/dev/null 2>&1; then
      :
    elif "$OSASCRIPT_BIN" -e 'tell application id "app.rubato.t3" to quit' >/dev/null 2>&1; then
      :
    else
      ui_fail "데스크톱 앱에 종료를 요청하지 못했습니다. 옛 코드가 그대로입니다 — 손으로: osascript -e 'tell application \"Rubato\" to quit'"
      return 1
    fi
  elif [ -n "${RUBATO_QUIT_GUI_BIN-}" ]; then
    if ! "$RUBATO_QUIT_GUI_BIN" >/dev/null 2>&1; then
      ui_fail "데스크톱 앱에 종료를 요청하지 못했습니다. 옛 코드가 그대로입니다 — 손으로: 창을 닫은 뒤 sh \"$START_GUI\""
      return 1
    fi
  else
    # WM_CLOSE. Terminate/taskkill 은 SQLite 를 어긋나게 남길 수 있어 쓰지 않는다.
    if ! command -v powershell.exe >/dev/null 2>&1; then
      ui_fail "데스크톱 앱에 종료를 요청하지 못했습니다. 옛 코드가 그대로입니다 — 손으로: 창을 닫은 뒤 sh \"$START_GUI\""
      return 1
    fi
    if ! powershell.exe -NoProfile -Command '
      $ok = $false
      Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "dist-electron[/\\]main\.cjs" } | ForEach-Object {
        $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($p) { if ($p.CloseMainWindow()) { $ok = $true } }
      }
      if (-not $ok) { exit 1 }
    ' >/dev/null 2>&1; then
      ui_fail "데스크톱 앱에 종료를 요청하지 못했습니다. 옛 코드가 그대로입니다 — 손으로: 창을 닫은 뒤 sh \"$START_GUI\""
      return 1
    fi
  fi

  GUI_WAIT=0
  progress_start "데스크톱 앱이 닫히기를 기다리는 중"
  while "$PGREP_BIN" $PGREP_ARGS "$GUI_PROC_PATTERN" >/dev/null 2>&1 && [ "$GUI_WAIT" -lt "$GUI_WAIT_MAX" ]; do
    sleep 1
    GUI_WAIT=$((GUI_WAIT + 1))
  done
  progress_stop
  if "$PGREP_BIN" $PGREP_ARGS "$GUI_PROC_PATTERN" >/dev/null 2>&1; then
    if is_darwin; then
      ui_fail "데스크톱 앱이 종료 요청을 받고도 끝나지 않았습니다. 옛 코드가 그대로입니다 — 다시 켜지 않았습니다. 손으로: osascript -e 'tell application \"Rubato\" to quit'"
    else
      ui_fail "데스크톱 앱이 종료 요청을 받고도 끝나지 않았습니다. 옛 코드가 그대로입니다 — 다시 켜지 않았습니다. 손으로: 창을 닫은 뒤 sh \"$START_GUI\""
    fi
    return 1
  fi
}

if [ "${GUI_ALREADY_CLOSED-}" != 1 ]; then
  quit_app || exit 1
fi
if [ ! -x "$START_GUI" ]; then
  ui_fail "데스크톱 앱은 껐지만 다시 켤 진입점이 없습니다 ($START_GUI). 앱은 스스로 돌아오지 않습니다 — 손으로: sh \"$START_GUI\""
  exit 1
fi

# 앱이 내려간 지금이 번들을 다시 만들 수 있는 유일한 창이다. 여기서 실패해도
# 앱을 볼모로 잡지 않는다 — 옛 번들로라도 돌아오는 편이 앱이 없는 것보다 낫다.
RESTART_FAIL=0
if ! sync_bundle; then
  ui_fail "핀·overlay 를 다시 얹지 못했습니다. 옛 번들 그대로 다시 켭니다 — 손으로: bash \"$INSTALL_GUI\" --apply"
  RESTART_FAIL=1
fi
restart_ssh_servers || RESTART_FAIL=1

# 번들을 맞추는 동안 앱은 내려가 있고, 그 사이 Dock 이나 Finder 로 앱을 연
# 사람이 있다. 그 앱은 바꾸는 중이던 번들로 떠 있고, 여기서 하나를 더 켜면
# 같은 상태 DB 에 앱이 둘이 된다 — 나중 앱의 데스크톱 로그인이 먼저 앱의 것을
# 갈아치워서 먼저 앱은 페어링을 요구한다. macOS 에서는 T3 가 단일 인스턴스
# 잠금을 잡지 않는다. 그 앱도 한 번 더 정상 종료시킨 뒤에 켠다.
if "$PGREP_BIN" $PGREP_ARGS "$GUI_PROC_PATTERN" >/dev/null 2>&1; then
  ui_note "번들을 맞추는 사이 열린 앱이 있어요. 새 번들로 다시 켜려고 닫습니다."
  if ! quit_app; then
    ui_fail "번들을 맞추는 사이 열린 앱이 닫히지 않아 새 앱을 켜지 않았습니다. 앱이 둘이 되면 먼저 앱이 페어링을 요구합니다."
    exit 1
  fi
fi

# nohup 으로 이 스크립트의 프로세스 그룹에서 떼어 놓는다. 그러지 않으면 앞단
# 작업이 끝나면서 새로 뜬 앱에 SIGHUP 이 갈 수 있다.
mkdir -p "$(dirname "$GUI_LOG")" 2>/dev/null || true
progress_start "데스크톱 앱을 켜는 중"
if [ -n "${RUBATO_GUI_UPDATE_NODE-}" ]; then
  # GUI 업데이터가 자기 빌드 프로세스 그룹을 정리해도 새 앱은 살아야 한다.
  # nohup은 SIGHUP만 무시할 뿐 그룹을 나누지 않는다.
  if "$RUBATO_GUI_UPDATE_NODE" "$HERE/detach-gui.mjs" "$START_GUI" "$GUI_LOG"; then
    progress_stop
    ui_ok "데스크톱 실행 요청 (창 준비는 GUI 업데이터가 확인합니다)"
  else
    progress_stop
    ui_fail "데스크톱 앱을 다시 실행하지 못했습니다. 기록: $GUI_LOG"
    RESTART_FAIL=1
  fi
  exit "$RESTART_FAIL"
fi
nohup "$START_GUI" >>"$GUI_LOG" 2>&1 </dev/null &
GUI_PID=$!
sleep 1
GUI_STAT="$(ps -p "$GUI_PID" -o stat= 2>/dev/null || true)"
progress_stop
case "$GUI_STAT" in
  ""|*Z*)
    if wait "$GUI_PID" 2>/dev/null; then
      ui_ok "데스크톱 앱 (바뀐 브리지 코드를 읽습니다)"
    else
      ui_fail "데스크톱 앱은 껐지만 다시 켜지지 않았습니다. 앱은 스스로 돌아오지 않습니다 — 손으로: sh \"$START_GUI\" (기록: $GUI_LOG)"
      RESTART_FAIL=1
    fi
    ;;
  *)
    ui_ok "데스크톱 앱 (바뀐 브리지 코드를 읽습니다)"
    ;;
esac
exit "$RESTART_FAIL"
