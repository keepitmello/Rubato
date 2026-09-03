#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${OUTPOST_BIN_DIR:-${CONSULT_BIN_DIR:-$HOME/.local/bin}}"
SRC="$HERE/outpost"

[ -f "$SRC" ] || { echo "missing outpost CLI: $SRC" >&2; exit 1; }
mkdir -p "$BIN"
chmod +x "$SRC"
ln -sfn "$SRC" "$BIN/outpost"
if [ -L "$BIN/consult" ] || [ -e "$BIN/consult" ]; then
  rm -f "$BIN/consult"
fi
echo "installed outpost -> $BIN/outpost"
