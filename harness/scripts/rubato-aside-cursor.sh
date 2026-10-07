#!/bin/sh
# localhost OpenAI 호환 면. Aside Cursor 가 Rubato Connect 직결을 치게 한다.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$HERE/find-node.sh"
if ! NODE="$(rubato_find_node)"; then
  echo "rubato aside-cursor needs Node.js 24+ already installed." >&2
  exit 2
fi
# The Cursor provider exists only in the engine build Rubato installs: pi-runtime stages
# it into that build's pi-ai, and the checkout's stock pi has none. The engine runs its
# own staged copy; this proxy runs from the checkout, so its pi lookups
# (engine-paths.mjs, RUBATO_PI_TEST_RUNTIME = a staged runtime root) go to that build.
# Without it every start died on providers/cursor.js and launchd kept respawning it.
if [ -z "${RUBATO_PI_TEST_RUNTIME-}" ]; then
  ENGINE_ROOT="$(RUBATO_ENGINE_SELECTION="$HERE/../rubato-pi/src/engine-selection.mjs" "$NODE" --input-type=module -e '
const { resolveLaunchEngine } = await import(process.env.RUBATO_ENGINE_SELECTION);
const engine = resolveLaunchEngine();
if (!engine.error && engine.root) process.stdout.write(engine.root);
' 2>/dev/null || true)"
  if [ -n "$ENGINE_ROOT" ]; then
    RUBATO_PI_TEST_RUNTIME="$ENGINE_ROOT"
    export RUBATO_PI_TEST_RUNTIME
  fi
fi
exec "$NODE" "$HERE/../rubato-pi/src/aside-cursor-server.mjs" "$@"
