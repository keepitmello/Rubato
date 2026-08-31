#!/bin/sh
# localhost OpenAI 호환 면. Aside Cursor 가 Rubato Connect 직결을 치게 한다.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$HERE/find-node.sh"
if ! NODE="$(rubato_find_node)"; then
  echo "rubato aside-cursor needs Node.js 24+ already installed." >&2
  exit 2
fi
exec "$NODE" "$HERE/../rubato-pi/src/aside-cursor-server.mjs" "$@"
