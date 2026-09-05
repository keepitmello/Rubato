#!/bin/sh
# Shell prerequisites precede Node. Keep the same centered wordmark here;
# boot-chrome takes over this alt-screen and owns the full animated intro/outro.
set -eu
if [ ! -t 0 ] || [ ! -t 1 ] || [ "${TERM-}" = dumb ] || [ -n "${CI-}" ] \
  || [ -n "${RUBATO_NO_SPLASH-}" ] || [ "${RUBATO_BOOT_CHROME-}" = 0 ]; then
  exit 0
fi
# tput trusts inherited COLUMNS/LINES, which can describe the picker rather than
# the new zmx PTY. Read the actual terminal before positioning the first frame.
SIZE="$(stty size 2>/dev/null || true)"
ROWS="${SIZE%% *}"
COLS="${SIZE##* }"
if [ -z "$SIZE" ] || [ "$ROWS" = 0 ] || [ "$COLS" = 0 ]; then
  COLS=80
  ROWS=24
fi
case "$COLS:$ROWS" in *[!0-9:]*|:*|*:) exit 0 ;; esac
ROW=$((ROWS * 45 / 100))
[ "$ROW" -ge 1 ] || ROW=1
COL=$(((COLS - 6) / 2))
[ "$COL" -ge 1 ] || COL=1
ESC=$(printf '\033')
COLOR=""
if [ -z "${NO_COLOR+x}" ]; then
  case "${COLORTERM-}" in
    truecolor|24bit) COLOR="${ESC}[38;2;243;212;181m" ;;
    *) COLOR="${ESC}[38;5;223m" ;;
  esac
fi
case "${1-}" in
  open)
    printf '%s' "${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l"
    if [ "$COLS" -ge 8 ]; then
      printf '%s' "${ESC}[${ROW};${COL}H${COLOR}𝒓𝒖𝒃𝒂𝒕𝒐${ESC}[0m"
    fi
    ;;
  step)
    # Known Korean startup labels are at most 22 cells. Never stack or wrap them.
    if [ "$COLS" -ge 28 ] && [ "$ROWS" -ge 6 ]; then
      STATUS_ROW=$((ROW + 2))
      STATUS_COL=$(((COLS - 24) / 2))
      printf '%s' "${ESC}[${STATUS_ROW};1H${ESC}[2K${ESC}[${STATUS_ROW};${STATUS_COL}H${ESC}[2m· ${2-}${ESC}[0m"
    fi
    ;;
  close)
    printf '%s' "${ESC}[0m${ESC}[?1049l${ESC}[?25h"
    ;;
esac
