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

PGREP_BIN="${RUBATO_PGREP_BIN:-/usr/bin/pgrep}"
OSASCRIPT_BIN="${RUBATO_OSASCRIPT_BIN:-/usr/bin/osascript}"
GUI_APP="${RUBATO_GUI_APP:-/Applications/Rubato.app}"
START_GUI="${RUBATO_START_GUI:-$HERE/start-gui.sh}"
INSTALL_GUI="${RUBATO_INSTALL_GUI:-$HERE/install-gui.sh}"
GUI_LOG="${RUBATO_GUI_LOG:-$HOME/.rubato-pi/logs/rubato-gui-restart.log}"
# 메인 Electron 바이너리로 찾는다. 헬퍼가 Rubato.app/Contents/Frameworks 밑에
# 살아서 짧은 패턴은 창이 닫힌 뒤에도 계속 걸리고, 그러면 다시 켜기가 조용히
# 건너뛰어진다. 내장 T3 서버도 같은 Contents/MacOS/Electron 경로를 쓰므로 이
# 패턴으로 기다리면 그 자식까지 덮는다.
GUI_PROC_PATTERN="${RUBATO_GUI_PROC_PATTERN:-Rubato\\.app/Contents/MacOS/Electron}"
GUI_WAIT_MAX="${RUBATO_GUI_WAIT_SECS:-30}"
case "$GUI_WAIT_MAX" in
  ''|*[!0-9]*) GUI_WAIT_MAX=30 ;;
esac

sync_bundle() {
  [ -f "$INSTALL_GUI" ] || return 0
  sh "$INSTALL_GUI" --apply
}

if [ ! -e "$GUI_APP" ]; then
  echo "데스크톱 앱이 없어 건너뜁니다."
  exit 2
fi

if ! "$PGREP_BIN" -f "$GUI_PROC_PATTERN" >/dev/null 2>&1; then
  # 꺼진 앱은 옛 코드로 돌고 있지는 않지만 번들은 여전히 낡을 수 있고, 그것을
  # 다시 만드는 것은 아무도 하지 않는다 — start-gui.sh 는 켜기만 한다. 번들만
  # 맞추고 앱은 그대로 둔다: 이 머신이 창을 띄우고 싶어하는지는 여기서 정할
  # 일이 아니다.
  if [ ! -f "$INSTALL_GUI" ]; then
    echo "데스크톱 앱은 이미 꺼져 있어 건너뜁니다."
    exit 2
  fi
  if sync_bundle; then
    echo "데스크톱 앱은 꺼져 있습니다. 번들만 새 코드로 맞췄으니 다음에 켜면 반영됩니다."
    exit 0
  fi
  echo "데스크톱 앱은 꺼져 있고, 번들을 새 코드로 맞추지도 못했습니다. 켜면 옛 코드입니다 — 손으로: sh \"$INSTALL_GUI\" --apply" >&2
  exit 1
fi

# 종료는 graceful 만 쓴다. osascript `quit` 은 Dock > 종료 와 같은 이벤트라
# before-quit 핸들러가 먼저 흐른다. 내장 서버가 SQLite 를 들고 있어서 강제
# 종료는 그 파일을 어긋난 채로 남길 수 있다. 그래서 이 경로에 kill 은 없다.
if "$OSASCRIPT_BIN" -e 'tell application "Rubato" to quit' >/dev/null 2>&1; then
  :
elif "$OSASCRIPT_BIN" -e 'tell application id "app.rubato.t3" to quit' >/dev/null 2>&1; then
  :
else
  echo "데스크톱 앱에 종료를 요청하지 못했습니다. 옛 코드가 그대로입니다 — 손으로: osascript -e 'tell application \"Rubato\" to quit'" >&2
  exit 1
fi

# 정말 사라졌는지 보고 나서 다시 켠다 — 넘겨짚지 않는다.
GUI_WAIT=0
while "$PGREP_BIN" -f "$GUI_PROC_PATTERN" >/dev/null 2>&1 && [ "$GUI_WAIT" -lt "$GUI_WAIT_MAX" ]; do
  sleep 1
  GUI_WAIT=$((GUI_WAIT + 1))
done
if "$PGREP_BIN" -f "$GUI_PROC_PATTERN" >/dev/null 2>&1; then
  echo "데스크톱 앱이 종료 요청을 받고도 끝나지 않았습니다. 옛 코드가 그대로입니다 — 다시 켜지 않았습니다. 손으로: osascript -e 'tell application \"Rubato\" to quit'" >&2
  exit 1
fi
if [ ! -x "$START_GUI" ]; then
  echo "데스크톱 앱은 껐지만 다시 켤 진입점이 없습니다 ($START_GUI). 앱은 스스로 돌아오지 않습니다 — 손으로: sh \"$START_GUI\"" >&2
  exit 1
fi

# 앱이 내려간 지금이 번들을 다시 만들 수 있는 유일한 창이다. 여기서 실패해도
# 앱을 볼모로 잡지 않는다 — 옛 번들로라도 돌아오는 편이 앱이 없는 것보다 낫다.
RESTART_FAIL=0
if ! sync_bundle; then
  echo "핀·overlay 를 다시 얹지 못했습니다. 옛 번들 그대로 다시 켭니다 — 손으로: sh \"$INSTALL_GUI\" --apply" >&2
  RESTART_FAIL=1
fi

# nohup 으로 이 스크립트의 프로세스 그룹에서 떼어 놓는다. 그러지 않으면 앞단
# 작업이 끝나면서 새로 뜬 앱에 SIGHUP 이 갈 수 있다.
mkdir -p "$(dirname "$GUI_LOG")" 2>/dev/null || true
nohup "$START_GUI" >>"$GUI_LOG" 2>&1 </dev/null &
GUI_PID=$!
sleep 1
GUI_STAT="$(ps -p "$GUI_PID" -o stat= 2>/dev/null || true)"
case "$GUI_STAT" in
  ""|*Z*)
    if wait "$GUI_PID" 2>/dev/null; then
      echo "데스크톱 앱을 다시 켰습니다 (바뀐 브리지 코드를 읽습니다)."
    else
      echo "데스크톱 앱은 껐지만 다시 켜지지 않았습니다. 앱은 스스로 돌아오지 않습니다 — 손으로: sh \"$START_GUI\" (기록: $GUI_LOG)" >&2
      RESTART_FAIL=1
    fi
    ;;
  *)
    echo "데스크톱 앱을 다시 켰습니다 (바뀐 브리지 코드를 읽습니다)."
    ;;
esac
exit "$RESTART_FAIL"
