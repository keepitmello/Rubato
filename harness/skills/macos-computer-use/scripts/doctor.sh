#!/bin/zsh
# Is the computer-use backend installed, running and allowed?
set -u

if ! command -v cua-driver >/dev/null 2>&1; then
  print "cua-driver: not installed (Rubato Settings → macOS Permissions → Computer use → Install)"
  exit 1
fi
cua-driver --version
if ! cua-driver status; then
  if pgrep -f "CuaDriver.app/Contents/MacOS/cua-driver serve" >/dev/null; then
    print "daemon unreachable: a CuaDriver.app instance lost its socket; kill $(pgrep -f 'CuaDriver.app/Contents/MacOS/cua-driver serve' | tr '\n' ' ')then open -g -a /Applications/CuaDriver.app"
  else
    print "daemon not running: open -g -a /Applications/CuaDriver.app"
  fi
  exit 1
fi
cua-driver permissions status --json
