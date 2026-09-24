#!/bin/sh
# 다른 기계의 데스크톱이 SSH 환경으로 이 기계에 띄워 둔 Rubato 서버를 내린다.
# restart-gui.sh 가 번들을 맞춘 뒤 부른다(`rubato restart`·`rubato update` 둘 다).
#
# 그 서버는 이 기계의 데스크톱 앱과 따로 산다. 원격 실행기가 nohup 으로 띄워 두고
# ~/.t3/ssh-launch/<key>/pid 에 적어 두며, 데스크톱이 다시 붙을 때 pid 가 살아
# 있으면 그대로 쓴다. 그래서 번들과 브리지를 새로 맞춰도 내리지 않으면 옛 코드가
# 계속 돈다. 내리기만 하면 된다 — 데스크톱은 연결이 끊기면 다시 붙으면서 원격
# 실행기를 돌리고, 실행기는 죽은 pid 를 보고 새 코드로 띄운다.
#
# 우리가 띄운 것만 건드린다: 진입점(t3-remote-server.mjs) 이나 이 기계의 서버
# 번들을 인자로 가진 프로세스. 원본 T3 릴리스로 뜬 서버는 그대로 둔다.
# 종료는 SIGTERM 만 쓴다. 서버가 SQLite 를 들고 있어서 강제 종료는 없다.
#
# 종료 코드: 0 내렸다, 1 내리려다 실패했다, 2 내릴 것이 없었다.
set -u

HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$HERE/../scripts/rubato-progress.sh"

T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
LAUNCH_DIR="${RUBATO_SSH_LAUNCH_DIR:-$HOME/.t3/ssh-launch}"
WAIT_MAX="${RUBATO_SSH_SERVER_WAIT_MAX:-20}"
SERVER_BUNDLE="$T3_DIR/apps/server/dist/bin.mjs"

[ -d "$LAUNCH_DIR" ] || exit 2

PIDS=""
for pid_file in "$LAUNCH_DIR"/*/pid; do
  [ -f "$pid_file" ] || continue
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  kill -0 "$pid" 2>/dev/null || continue
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  # 진입점은 원격 실행기가 $HOME 기준 상대경로로 넘기므로 파일 이름으로 본다.
  # execve 로 갈아탄 뒤에는 서버 번들 경로가 인자에 남는다.
  case "$args" in
    *t3-remote-server.mjs*|*"$SERVER_BUNDLE"*) PIDS="$PIDS $pid" ;;
  esac
done
[ -n "$PIDS" ] || exit 2

# shellcheck disable=SC2086
kill -TERM $PIDS 2>/dev/null || true
progress_start "SSH 원격 서버가 내려가기를 기다리는 중"
waited=0
while :; do
  alive=""
  for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
  [ -z "$alive" ] && break
  [ "$waited" -ge "$WAIT_MAX" ] && break
  sleep 1
  waited=$((waited + 1))
done
progress_stop
if [ -n "$alive" ]; then
  ui_fail "SSH 원격 서버가 SIGTERM 을 받고도 끝나지 않았습니다(pid$alive). 옛 코드가 그대로입니다 — 손으로: kill$alive"
  exit 1
fi
count="$(printf '%s\n' $PIDS | grep -c .)"
ui_ok "SSH 원격 서버 ${count}개 (데스크톱이 다시 붙을 때 새 코드로 떠요)"
exit 0
