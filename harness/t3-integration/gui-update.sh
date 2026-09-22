#!/bin/bash
# Finder/Dock 환경에서도 CLI와 같은 Node 선택기를 사용한다.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../scripts/find-node.sh"
NODE="$(rubato_find_node)"
export PATH="$(dirname "$NODE"):$HOME/.bun/bin:$PATH"
exec "$NODE" "$HERE/gui-update.mjs" "$@"
