#!/bin/zsh
set -u

script_dir="${0:A:h}"
cua_ok=0
peekaboo_ok=0
driver_ok=0

print "Codex Computer Use:"
if /bin/zsh "$script_dir/launch-cua-repl.zsh" --check; then
  cua_ok=1
else
  print "unavailable"
fi

print "Peekaboo (fallback):"
if command -v peekaboo >/dev/null 2>&1; then
  print -r -- "binary=$(command -v peekaboo)"
  peekaboo --version || true
  peekaboo permissions status || true
  peekaboo_ok=1
else
  print "unavailable"
fi

print "Cua Driver (default):"
if command -v cua-driver >/dev/null 2>&1; then
  cua-driver --version || true
  cua-driver status && driver_ok=1
else
  print "unavailable"
fi

(( driver_ok || peekaboo_ok || cua_ok ))
