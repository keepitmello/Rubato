#!/bin/bash
# A throwaway Rubato home for trying a rebuilt T3 server or engine beside the person's own app,
# without touching their app, memory, companions or conversations.
#
#   isolated-home.sh prepare <root> [--memory] [--segno]   make <root>/home (and clone real data)
#   isolated-home.sh check   <root>                        refuse when a live path or low disk shows
#   isolated-home.sh run     <root> <command> [args...]    run a command inside that home
#
# `run` starts from an EMPTY environment (env -i) with HOME pointing inside <root>: every Rubato
# path that is not set explicitly falls back under that HOME. On 2026-11-09 three launches that
# kept the calling shell's environment reached live state: an inherited RUBATO_COMPANIONS_FILE ran a
# keeper on the live Roo home, a cloned Segno woke on its own and triaged a cloned inbox alert, and
# a full copy of the app's 5 GB state database filled the disk. Hence:
#   - the app's state database is never copied: the T3 server starts from an empty <root>/t3home;
#   - real memory and Segno come in as APFS clones (`cp -c`), which take almost no space;
#   - the cloned Segno is switched off (no keeper, heartbeat or greetings) and its inbox, messenger,
#     wake state and followed work are dropped, so nothing in it runs unless a page sends to it;
#   - no credentials are copied: model calls fail with zero tokens unless you add auth yourself.
# Usage notes and the reasons behind them: Rubato memory reference/rubato/t3-isolated-view-server.md.
set -euo pipefail

MIN_FREE_GB=${RUBATO_ISOLATED_MIN_FREE_GB:-3}
LIVE_HOME=${RUBATO_ISOLATED_LIVE_HOME:-$HOME}

die() { echo "isolated-home: $*" >&2; exit 1; }

usage() { sed -n '4,6p' "$0" | sed 's/^# *//' >&2; exit 2; }

[[ $# -ge 2 ]] || usage
command=$1 root=$2; shift 2
[[ $root = /* ]] || die "the root must be an absolute path: $root"
home="$root/home"

# Paths that hold the person's live state. A hit in the environment or a copied config refuses.
forbidden() {
  local live=$LIVE_HOME
  printf '%s|%s|%s|%s|%s' "$live/\.claude" "$live/\.rubato/companion" "$live/\.rubato/memory" "$live/\.rubato-pi" "$live/\.rubato/t3-home"
}

launch_env() {
  printf '%s\n' \
    "HOME=$home" "USER=${USER:-}" "LOGNAME=${LOGNAME:-}" "LANG=${LANG:-en_US.UTF-8}" "TMPDIR=$home/tmp" \
    "PATH=${RUBATO_ISOLATED_PATH:-$(dirname "$(command -v node)"):$LIVE_HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}" \
    "RUBATO_MEMORY_HOME=$home/memory" \
    "RUBATO_COMPANION_HOME=$home/.rubato/companion" \
    "RUBATO_DEFAULT_COMPANION_HOME=$home/.rubato/companion" \
    "RUBATO_COMPANIONS_FILE=$home/.rubato/companions.json" \
    "RUBATO_SCHEDULE_HOME=$home/.rubato/schedule" \
    "RUBATO_PI_CODING_AGENT_DIR=$home/.rubato-pi/agent" \
    "PI_CODING_AGENT_DIR=$home/.rubato-pi/agent"
}

check() {
  [[ -d "$home" ]] || die "no isolated home at $home; run prepare first"
  local pattern; pattern=$(forbidden)
  # The variables that name the live home's own paths may not appear; HOME/PATH under it are allowed.
  if launch_env | grep -v -E '^(PATH|USER|LOGNAME|LANG)=' | grep -E "$pattern"; then die "a live path is in the launch environment"; fi
  local config
  while IFS= read -r config; do
    if grep -E -l "$pattern" "$config" >/dev/null 2>&1; then
      grep -E -n "$pattern" "$config" >&2 || true
      die "a live path is in a copied configuration: $config"
    fi
  done < <(find "$home/.rubato" "$home/.rubato-pi" "$root/t3home" -maxdepth 3 \( -name '*.json' -o -name '*.jsonc' \) -size -1M 2>/dev/null)
  local free_kb; free_kb=$(df -Pk "$root" | awk 'NR==2 {print $4}')
  (( free_kb >= MIN_FREE_GB * 1024 * 1024 )) || die "only $((free_kb / 1024 / 1024)) GB free under $root; need $MIN_FREE_GB GB"
}

prepare() {
  local memory=false segno=false
  for flag in "$@"; do
    case $flag in --memory) memory=true ;; --segno) segno=true ;; *) die "unknown flag $flag" ;; esac
  done
  [[ ! -e "$home" ]] || die "$home already exists; use a fresh root"
  mkdir -p "$home/tmp" "$home/.rubato" "$home/.rubato-pi/agent" "$root/t3home"
  # No other companion profiles: the built-in Segno (cloned below, or a fresh one) is the only one.
  printf '{ "companions": [] }\n' > "$home/.rubato/companions.json"
  if $memory; then
    [[ -d "$LIVE_HOME/.rubato/memory" ]] || die "no live memory to clone"
    cp -c -R "$LIVE_HOME/.rubato/memory" "$home/memory"
  else
    mkdir -p "$home/memory"
  fi
  if $segno; then
    local src="$LIVE_HOME/.rubato/companion" dst="$home/.rubato/companion"
    [[ -d "$src" ]] || die "no live Segno home to clone"
    cp -c -R "$src" "$dst"
    # Drop what would make the clone act on its own: the inbox and messenger, its conversation and
    # wake state, followed work, the side panel's list and the dream's runs.
    rm -rf "$dst/inbox" "$dst/messenger" "$dst/dream" "$dst/tmp" "$dst/.engine-claims"
    rm -f "$dst/state.json" "$dst"/state.json.* "$dst/following.json" "$dst/finished.json" "$dst/panel.json" "$dst/dismissed.json"
    node -e '
      const fs = require("fs"); const file = process.argv[1];
      const settings = JSON.parse(fs.readFileSync(file, "utf8"));
      settings.enabled = false;
      if (settings.heartbeat) settings.heartbeat.enabled = false;
      if (settings.greetings) settings.greetings.enabled = false;
      if (settings.schedule) settings.schedule.sources = [];
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    ' "$dst/settings.json"
  fi
  check
  echo "isolated home ready: $home (T3 base dir: $root/t3home)"
}

case $command in
  prepare) prepare "$@" ;;
  check) check; echo "isolated home clean: $home" ;;
  run)
    [[ $# -ge 1 ]] || usage
    check
    # macOS ships bash 3.2: no mapfile.
    vars=()
    while IFS= read -r line; do vars+=("$line"); done < <(launch_env)
    exec /usr/bin/env -i "${vars[@]}" "$@"
    ;;
  *) usage ;;
esac
