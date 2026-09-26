#!/bin/zsh
# Is the computer-use backend installed, running and allowed?
set -u

if ! command -v cua-driver >/dev/null 2>&1; then
  print "cua-driver: not installed (Rubato Settings → macOS Permissions → Computer use → Install)"
  exit 1
fi
cua-driver --version
if ! cua-driver status; then
  print "daemon not running: open -g -a /Applications/CuaDriver.app"
  exit 1
fi
cua-driver permissions status --json
