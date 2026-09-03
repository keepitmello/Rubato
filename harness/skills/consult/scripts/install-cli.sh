#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${CONSULT_BIN_DIR:-$HOME/.local/bin}"
SRC="$HERE/consult"

[ -f "$SRC" ] || { echo "missing consult CLI: $SRC" >&2; exit 1; }
mkdir -p "$BIN"
chmod +x "$SRC"
ln -sfn "$SRC" "$BIN/consult"
echo "installed consult -> $BIN/consult"
