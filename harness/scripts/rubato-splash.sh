#!/bin/sh
# 부팅 스플래시. 엔진이 화면을 잡기까지 3초 남짓 걸리는데, 그동안 까만
# 화면을 두지 않는다. 로고는 즉시(0.03초) 뜨고 그 아래 한 줄이 단계에 따라
# 바뀐다. 엔진에 넘기기 직전 그린 영역을 되감아 지우고 한 줄만 남긴다.
#
#   rubato-splash.sh open           로고를 그리고 커서를 감춘다
#   rubato-splash.sh step <말>      아래 한 줄을 <말> 로 바꾼다
#   rubato-splash.sh close          그린 것을 지우고 요약 한 줄만 남긴다
#
# 화면을 못 그리는 곳(파이프, CI, TERM=dumb)에서는 전부 조용히 빠진다.
# 그래야 스크롤백과 로그가 이스케이프 문자로 더러워지지 않는다.
set -eu

# stdout 이 터미널이 아니거나, 터미널이 커서 이동을 못 하면 그리지 않는다.
if [ ! -t 1 ] || [ "${TERM-}" = dumb ] || [ -n "${NO_COLOR-}" ] || [ -n "${RUBATO_NO_SPLASH-}" ]; then
  exit 0
fi

# 창이 로고보다 좀으면 줄이 감겨서 close 가 지울 줄 수가 어긋난다.
# 그럴 땐 로고를 포기하고 한 줄짜리로 간다. 로고는 들여쓰기 2 + 폭 30.
COLS="${COLUMNS:-}"
[ -z "$COLS" ] && COLS="$(tput cols 2>/dev/null || echo 80)"
if [ "$COLS" -lt 34 ] 2>/dev/null; then
  NARROW=1; LINES=2   # 빈 줄 + 상태 1줄
else
  NARROW=""; LINES=5  # 로고 3줄 + 빈 줄 + 상태 1줄
fi

ESC=$(printf '\033')
RST="${ESC}[0m"
DIM="${ESC}[2m"

# 색은 두 단계로 떨어뜨린다. truecolor 를 알리는 터미널에서는 그라데이션을
# 쓰고, 아니면 256색으로 간다. 둘 다 아니면 색 없이 글자만.
if [ "${COLORTERM-}" = truecolor ] || [ "${COLORTERM-}" = 24bit ]; then
  C1="${ESC}[38;2;244;162;97m"
  C2="${ESC}[38;2;231;111;81m"
  C3="${ESC}[38;2;138;177;125m"
elif [ -n "${TERM-}" ]; then
  C1="${ESC}[38;5;215m"
  C2="${ESC}[38;5;209m"
  C3="${ESC}[38;5;108m"
else
  C1=""; C2=""; C3=""
fi

case "${1-}" in
  open)
    # 줄바꿈은 \r\n 으로 보낸다. \n 만 보내면 줄바꿈을 엄격하게 다루는
    # 터미널(그리고 cmux 같은 재생기)에서 로고가 계단처럼 밀린다.
    printf '%s' "${ESC}[?25l"   # 커서 감춤. close 가 되돌린다.
    printf '\r\n'
    if [ -z "$NARROW" ]; then
      printf '  %s█▀▄  █ █  █▀▄  ▄▀▄  ▀█▀  ▄▀▄%s\r\n' "$C1" "$RST"
      printf '  %s█▀▄  █ █  █▀▄  █▀█   █   █ █%s\r\n' "$C2" "$RST"
      printf '  %s▀ ▀  ▀▀▀  ▀▀▀  ▀ ▀   ▀   ▀▀▀%s\r\n' "$C2" "$RST"
      printf '\r\n'
    fi
    printf '  %s· 준비하는 중%s' "$DIM" "$RST"
    ;;

  step)
    # 상태 줄만 다시 쓴다. 줄 처음으로 가서 지우고 새로 찍는다.
    printf '\r%s  %s· %s%s' "${ESC}[K" "$DIM" "${2-}" "$RST"
    ;;

  close)
    # 그린 만큼 위로 올라가며 지운다. 스크롤백에 부팅 찌꺼기를 남기지 않는다.
    i=0
    while [ "$i" -lt "$LINES" ]; do
      printf '%s' "${ESC}[2K${ESC}[1A"
      i=$((i + 1))
    done
    printf '%s\r' "${ESC}[2K"
    printf '%s' "${ESC}[?25h"   # 커서 복구
    # 남기는 것은 이 한 줄뿐이다.
    printf '  %s✦%s %srubato%s %s%s%s\r\n\r\n' \
      "$C3" "$RST" "$C1" "$RST" "$DIM" "${2-}" "$RST"
    ;;
esac
