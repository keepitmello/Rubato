#!/bin/sh
# `rubato schedule`: scheduled tasks — list, run now, history, and the scheduler's launchd job.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$HERE/find-node.sh"
if ! NODE="$(rubato_find_node)"; then
  echo "rubato schedule needs Node.js 24+ already installed." >&2
  exit 2
fi
exec "$NODE" "$HERE/../scheduler/src/cli.mjs" "$@"
