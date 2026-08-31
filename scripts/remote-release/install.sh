#!/bin/sh
set -eu
exec "${NODE:-node}" "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/remote-release.mjs" install "$@"
