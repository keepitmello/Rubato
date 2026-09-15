#!/bin/sh
# `rubato restart` 가 화면에 쓰는 것 전부. 단계 하나를 도는 동안의 진행 표시와,
# 끝나고 남는 결과 한 줄.
#
#   . "$HERE/rubato-progress.sh"
#   progress_start "데스크톱 번들을 맞추는 중"
#   ...오래 걸리는 일...
#   progress_stop
#   ui_ok "데스크톱 앱"            결과 줄은 부르는 쪽이 찍는다
#
# 진행 표시는 stderr 에만 그리고 스스로 지운다. stdout 에는 결과 줄만 흐르므로
# 파이프로 받는 쪽(테스트, CI, `| tee`)은 이 파일이 있기 전과 같은 것을 본다.
# tty 가 아니거나 TERM=dumb 이거나 CI 면 진행 표시는 통째로 빠진다.

PROGRESS_ESC=$(printf '\033')
if [ -t 1 ] && [ -z "${NO_COLOR+x}" ] && [ "${TERM-}" != dumb ]; then
  PROGRESS_GRN="${PROGRESS_ESC}[32m"
  PROGRESS_YEL="${PROGRESS_ESC}[33m"
  PROGRESS_DIM="${PROGRESS_ESC}[2m"
  PROGRESS_RST="${PROGRESS_ESC}[0m"
else
  PROGRESS_GRN=""; PROGRESS_YEL=""; PROGRESS_DIM=""; PROGRESS_RST=""
fi

# 한 일. 굵게 남는 줄은 이것뿐이다.
ui_ok() { printf '  %s✓%s %s\n' "$PROGRESS_GRN" "$PROGRESS_RST" "$1"; }
# 이 기기에 없거나 이미 꺼져 있어 할 일이 없던 것. 흐리게 지나간다.
ui_skip() { printf '  %s· %s%s\n' "$PROGRESS_DIM" "$1" "$PROGRESS_RST"; }
# 바로 윗줄에 붙는 부연. 사람이 알아야 할 결과(끊긴 대화 이름 같은 것)만.
ui_note() { printf '    %s%s%s\n' "$PROGRESS_DIM" "$1" "$PROGRESS_RST"; }
# 하려다 실패한 것. 무엇이 옛 코드로 남았는지와 손으로 할 방법은 부르는 쪽이 잇는다.
ui_fail() { printf '  %s✗%s %s\n' "$PROGRESS_YEL" "$PROGRESS_RST" "$1" >&2; }

PROGRESS_PID=""

progress_enabled() {
  [ -t 2 ] || return 1
  [ "${TERM-}" = dumb ] && return 1
  [ -n "${CI-}" ] && return 1
  [ -n "${RUBATO_NO_PROGRESS-}" ] && return 1
  return 0
}

# 경과 시간을 같이 보여준다. 3초 넘게 걸리는 단계에서 "멈춘 건가"를 없애는 것이
# 이 표시의 목적이라, 숫자가 올라가는 것 자체가 내용이다.
progress_start() {
  progress_stop
  progress_enabled || return 0
  PROGRESS_LABEL="$1"
  printf '\033[?25l' >&2
  (
    i=0
    while :; do
      case $((i % 10)) in
        0) f='⠋' ;; 1) f='⠙' ;; 2) f='⠹' ;; 3) f='⠸' ;; 4) f='⠼' ;;
        5) f='⠴' ;; 6) f='⠦' ;; 7) f='⠧' ;; 8) f='⠇' ;; *) f='⠏' ;;
      esac
      secs=$((i / 10))
      if [ "$secs" -ge 3 ]; then
        printf '\r\033[2K  \033[2m%s %s  %ds\033[0m' "$f" "$PROGRESS_LABEL" "$secs" >&2
      else
        printf '\r\033[2K  \033[2m%s %s\033[0m' "$f" "$PROGRESS_LABEL" >&2
      fi
      # 소수점 sleep 이 없는 sh 도 있다. 그때는 1초 간격으로 돌되 경과
      # 계산이 어긋나지 않게 눈금을 10 씩 올린다.
      if sleep 0.1 2>/dev/null; then i=$((i + 1)); else sleep 1; i=$((i + 10)); fi
    done
  ) &
  PROGRESS_PID=$!
}

# 그리던 줄을 지운다. 켜지지 않았으면 아무 일도 없다. 어떻게 끝나든
# (성공·실패·Ctrl-C) 커서는 되돌린다.
progress_stop() {
  [ -n "$PROGRESS_PID" ] || return 0
  kill "$PROGRESS_PID" 2>/dev/null || true
  wait "$PROGRESS_PID" 2>/dev/null || true
  PROGRESS_PID=""
  progress_enabled && printf '\r\033[2K\033[?25h' >&2
  return 0
}
