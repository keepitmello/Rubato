#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

is_node_24() {
  candidate=$1
  [ -n "$candidate" ] && [ -x "$candidate" ] || return 1
  major=$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  [ "$major" -ge 24 ]
}

if [ -n "${RUBATO_CODEX_NODE:-}" ]; then
  if ! is_node_24 "$RUBATO_CODEX_NODE"; then
    echo "rubato-codex: RUBATO_CODEX_NODE must point to Node.js 24+" >&2
    exit 1
  fi
  node_bin=$RUBATO_CODEX_NODE
else
  node_bin=
  path_node=$(command -v node 2>/dev/null || true)
  for candidate in "$path_node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if is_node_24 "$candidate"; then
      node_bin=$candidate
      break
    fi
  done
  if [ -z "$node_bin" ]; then
    echo "rubato-codex: Node.js 24+ is required; set RUBATO_CODEX_NODE to its executable" >&2
    exit 1
  fi
fi

exec "$node_bin" "$script_dir/scripts/install.mjs" "$@"
