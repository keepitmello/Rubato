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
export RUBATO_SYSTEM_PROMPT_FILE="$SOUL"
exec "$HERE/rubato-pi.sh" "$@"
