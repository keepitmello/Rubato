#!/bin/zsh
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
chatgpt_resources="/Applications/ChatGPT.app/Contents/Resources"
node_bin="$chatgpt_resources/cua_node/bin/node"
node_repl="$chatgpt_resources/cua_node/bin/node_repl"
node_modules="$chatgpt_resources/cua_node/lib/node_modules"
service_app="$codex_home/computer-use/Codex Computer Use.app"
marketplace_root="$codex_home/.tmp/bundled-marketplaces/openai-bundled/plugins/unified-computer-use"
launcher="$marketplace_root/scripts/launch.mjs"

if [[ ! -f "$launcher" ]]; then
  launchers=("$codex_home"/plugins/cache/openai-bundled/unified-computer-use/*/scripts/launch.mjs(N))
  (( ${#launchers} > 0 )) || {
    print -u2 "cua_repl: unified-computer-use launcher is missing"
    exit 1
  }
  launcher="${launchers[-1]}"
fi

[[ -x "$node_bin" ]] || { print -u2 "cua_repl: ChatGPT CUA node is missing"; exit 1; }
[[ -x "$node_repl" ]] || { print -u2 "cua_repl: ChatGPT node_repl is missing"; exit 1; }
[[ -d "$service_app" ]] || { print -u2 "cua_repl: Codex Computer Use app is missing"; exit 1; }

if [[ "${1:-}" == "--check" ]]; then
  print -r -- "node=$node_bin"
  print -r -- "node_repl=$node_repl"
  print -r -- "launcher=$launcher"
  print -r -- "service=$service_app"
  exit 0
fi

export CODEX_HOME="$codex_home"
export NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS="1000"
export NODE_REPL_NODE_MODULE_DIRS="$node_modules"
export NODE_REPL_NODE_PATH="$node_bin"
export NODE_REPL_TRUSTED_CODE_PATHS="$codex_home:$node_modules"
export NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE="Control desktop apps on macOS through Computer Use."
export SKY_CUA_SERVICE_PATH="$service_app"
export CUA_REPL_NODE_REPL_PATH="$node_repl"
export CUA_REPL_ENABLED_SURFACES="computer"

exec "$node_bin" "$launcher"
