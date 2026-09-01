#!/bin/sh
# Launch rubato-pi with Documents/SOUL.md as the system prompt.
# Skips role prompt assembly (base + core + voice).
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
SOUL="${RUBATO_SYSTEM_PROMPT_FILE:-$HOME/Documents/SOUL.md}"
if [ ! -f "$SOUL" ]; then
  echo "rubato-soul: SOUL.md 가 없다 - $SOUL" >&2
  exit 1
fi
# iCloud Optimize 가 Documents 파일을 dataless stub 으로 두면
# Node readFileSync 가 EDEADLK(-11) 로 시작 즉시 죽는다. 읽기 전에 내려받는다.
if [ "$(uname -s)" = Darwin ]; then
  chflags nodataless "$SOUL" 2>/dev/null || true
fi
if ! head -c 1 "$SOUL" >/dev/null 2>&1; then
  echo "rubato-soul: SOUL.md 를 읽을 수 없다 - $SOUL" >&2
  echo "iCloud Optimize 로 파일이 이 맥에 없을 수 있다. Finder 에서 한 번 열거나 Always Keep Downloaded 로 고정해라." >&2
  exit 1
fi
export RUBATO_SYSTEM_PROMPT_FILE="$SOUL"
exec "$HERE/rubato-pi.sh" "$@"
