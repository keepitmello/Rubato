#!/bin/zsh
set -euo pipefail
echo "peekaboo: $(command -v peekaboo || echo missing)"
peekaboo --version || true
peekaboo permissions status || true
echo "cua-driver: $(command -v cua-driver || echo missing)"
if command -v cua-driver >/dev/null; then
  cua-driver --version || true
  cua-driver status || true
  cua-driver permissions status || true
fi
echo "Codex Computer Use app:"
ls "/Users/wy/.codex/computer-use/Codex Computer Use.app/Contents/MacOS" 2>/dev/null || echo missing

