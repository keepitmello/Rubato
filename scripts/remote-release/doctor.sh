#!/bin/sh
set -eu
exec "${NODE:-node}" "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/remote-release.mjs" doctor "$@"
