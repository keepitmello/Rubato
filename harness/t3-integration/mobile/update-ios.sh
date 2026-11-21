#!/usr/bin/env bash
# Sends the Rubato iPhone app's JavaScript over the air (EAS Update), in a minute or two instead of a
# TestFlight build. Phones running a build whose native side matches (expo-updates' fingerprint
# runtime version) pick it up on their next launch, or when the app comes back after two minutes
# (T3's update check, features/updates/app-updates.ts), and ask before restarting into it. A change to native code
# (Swift, a new native package, app.config) changes the fingerprint: such an update reaches no
# phone, and build-ios.sh --testflight is the way.
#
#   update-ios.sh ["message"]     the integration as committed, onto the production channel
#
# Signs in with EXPO_TOKEN (an Expo access token). Uses the same tree as build-ios.sh
# ($RUBATO_T3_MOBILE, default ~/.rubato/t3-mobile); nothing native is generated.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INTEGRATION="$(dirname "$HERE")"
T3_SOURCE="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_MOBILE="${RUBATO_T3_MOBILE:-$HOME/.rubato/t3-mobile}"
: "${EXPO_TOKEN:?set EXPO_TOKEN to an Expo access token}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 EXPO_NO_GIT_STATUS=1 APP_VARIANT=production LANG=en_US.UTF-8

pin="$(node -p "require('$INTEGRATION/upstream.json').upstreamCommit")"
if [ ! -d "$T3_MOBILE/.git" ] && [ ! -f "$T3_MOBILE/.git" ]; then
  git -C "$T3_SOURCE" worktree add --detach "$T3_MOBILE" "$pin"
fi
[ "$(git -C "$T3_MOBILE" rev-parse HEAD)" = "$pin" ] || git -C "$T3_MOBILE" checkout --detach "$pin"
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT
# The integration as committed, as build-ios.sh takes it; RUBATO_MOBILE_WORKTREE=1 sends the working tree.
source_dir="$INTEGRATION"
if [ "${RUBATO_MOBILE_WORKTREE:-}" != 1 ]; then
  source_dir="$work/integration"; mkdir -p "$source_dir"
  prefix="$(git -C "$INTEGRATION" rev-parse --show-prefix | sed 's#/$##')"
  git -C "$(git -C "$INTEGRATION" rev-parse --show-toplevel)" archive "HEAD:$prefix" | tar -x -C "$source_dir"
fi
applied="$(node "$source_dir/apply.mjs" --t3 "$T3_MOBILE")"
case "$applied" in
  *'"compatible": true'*) ;;
  *) printf 'apply.mjs did not apply the integration:\n%s\n' "$applied" >&2; exit 1 ;;
esac

cd "$T3_MOBILE"
stamp=node_modules/.rubato-mobile-lock
want="$(shasum -a 256 pnpm-lock.yaml | cut -d' ' -f1)"
if [ "$(cat "$stamp" 2>/dev/null || true)" != "$want" ]; then
  corepack pnpm install --frozen-lockfile --prefer-offline --config.confirm-modules-purge=false \
    --cpu="$(node -p process.arch)" --os=darwin
  printf '%s\n' "$want" > "$stamp"
fi
cd apps/mobile
corepack pnpm run generate >/dev/null
message="${1:-$(git -C "$INTEGRATION" log -1 --format=%s | cut -c1-120)}"
npx -y eas-cli@27 update --branch production --environment production --platform ios --message "$message" --non-interactive
