#!/bin/bash
# Pi 프로필 서버를 띄운 뒤 overlay된 T3 데스크톱을 연다.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_HOME="${RUBATO_T3_HOME:-$HOME/.rubato/t3-home}"
AGENT_DIR="${RUBATO_PI_CODING_AGENT_DIR:-$HOME/.rubato-pi/agent}"
ELECTRON="$T3_DIR/apps/desktop/scripts/start-electron.mjs"

if [ ! -f "$ELECTRON" ]; then
  printf 'T3 데스크톱이 없다. ./install.sh --apply --gui 를 먼저 실행해라.\n' >&2
  exit 1
fi

mkdir -p "$AGENT_DIR"
if [ ! -S "$AGENT_DIR/server/pi.sock" ]; then
  node "$HERE/../pi-server/src/cli.mjs" --agent-dir "$AGENT_DIR" >/tmp/rubato-pi-server.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -S "$AGENT_DIR/server/pi.sock" ] && break
    sleep 0.3
  done
fi

export T3CODE_HOME="$T3_HOME"
cd "$T3_DIR/apps/desktop"
exec node "$ELECTRON"
