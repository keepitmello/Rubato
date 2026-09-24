#!/bin/sh
# usage: enable-web-ax.sh <App name | pid>
# Turns on web-content accessibility for an Electron/Chromium app so Peekaboo
# sees its buttons and fields. Re-run after the app restarts.
set -eu
here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
target="${1:?usage: enable-web-ax.sh <App name | pid>}"
# Resolve by the name Peekaboo shows. Electron apps launched from a dev runtime
# run as a process named "Electron", so System Events cannot find them by name.
case "$target" in
  *[!0-9]*)
    pid="$(peekaboo app list --no-remote --json | python3 -c '
import json, sys
name = sys.argv[1]
apps = (json.load(sys.stdin).get("data") or {}).get("apps") or []
hits = [a["pid"] for a in apps if name in (a.get("name"), a.get("bundle_id"))]
print(hits[0] if hits else "")' "$target")"
    [ -n "$pid" ] || { echo "no running app named $target" >&2; exit 1; } ;;
  *) pid="$target" ;;
esac
exec swift "$here/enable-web-ax.swift" "$pid"
