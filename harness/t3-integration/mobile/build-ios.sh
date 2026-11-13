#!/usr/bin/env bash
# Builds the Rubato iPhone app from the pinned T3 apps/mobile plus this overlay.
#
#   build-ios.sh --simulator     Release build for the iOS simulator (no signing), installed
#                                on a booted simulator when one is running
#   build-ios.sh --testflight    signed archive, uploaded to App Store Connect for TestFlight
#
# It builds in its own tree ($RUBATO_T3_MOBILE, default ~/.rubato/t3-mobile): a git worktree
# of the desktop's T3 checkout at the pin. The desktop's ~/.rubato/t3-source is never touched.
# Upload signs in with the App Store Connect API key in ASC_KEY_ID / ASC_ISSUER_ID /
# ASC_KEY_PATH (a .p8 that stays on this Mac).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INTEGRATION="$(dirname "$HERE")"
T3_SOURCE="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_MOBILE="${RUBATO_T3_MOBILE:-$HOME/.rubato/t3-mobile}"
TEAM_ID=5WGZKZGPQS
MODE="${1:-}"
case "$MODE" in --simulator|--testflight) ;; *)
  printf '%s\n' 'usage: build-ios.sh --simulator | --testflight' >&2; exit 2 ;;
esac
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 EXPO_NO_GIT_STATUS=1 APP_VARIANT=production LANG=en_US.UTF-8

pin="$(node -p "require('$INTEGRATION/upstream.json').upstreamCommit")"
if [ ! -d "$T3_MOBILE/.git" ] && [ ! -f "$T3_MOBILE/.git" ]; then
  git -C "$T3_SOURCE" worktree add --detach "$T3_MOBILE" "$pin"
fi
[ "$(git -C "$T3_MOBILE" rev-parse HEAD)" = "$pin" ] || git -C "$T3_MOBILE" checkout --detach "$pin"
node "$INTEGRATION/apply.mjs" --t3 "$T3_MOBILE" >/dev/null

cd "$T3_MOBILE"
stamp=node_modules/.rubato-mobile-lock
want="$(shasum -a 256 pnpm-lock.yaml | cut -d' ' -f1)"
if [ "$(cat "$stamp" 2>/dev/null || true)" != "$want" ]; then
  corepack pnpm install --frozen-lockfile --prefer-offline --config.confirm-modules-purge=false \
    --cpu="$(node -p process.arch)" --os=darwin
  printf '%s\n' "$want" > "$stamp"
fi

cd apps/mobile
# The app icon must be square and opaque: the inner tile of the desktop icon, flattened.
mkdir -p assets/rubato
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
sips -c 720 720 "$INTEGRATION/assets/Rubato.png" --out "$work/tile.png" >/dev/null
sips -z 1024 1024 -s format jpeg "$work/tile.png" --out "$work/tile.jpg" >/dev/null
sips -s format png "$work/tile.jpg" --out assets/rubato/icon.png >/dev/null
# The desktop overlay replaces T3's theme palettes; the phone's style sheets follow them.
corepack pnpm run generate >/dev/null
corepack pnpm exec expo prebuild --clean --platform ios --no-install >/dev/null
(cd ios && pod install)

build_number="$(date -u +%Y%m%d%H%M)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" ios/Rubato/Info.plist
out="$HOME/.rubato/t3-mobile-build"
mkdir -p "$out"

if [ "$MODE" = --simulator ]; then
  xcodebuild -workspace ios/Rubato.xcworkspace -scheme Rubato -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$out/sim" ARCHS=arm64 CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- \
    DEVELOPMENT_TEAM="$TEAM_ID" build | grep -E 'error:|BUILD' | tail -20
  # T3's vendored GhosttyKit carries no x86_64 simulator slice, hence ARCHS=arm64. The ad-hoc
  # signature keeps the entitlements: without its keychain group, saved Macs cannot be read.
  app="$out/sim/Build/Products/Release-iphonesimulator/Rubato.app"
  if xcrun simctl list devices booted | grep -q Booted; then
    xcrun simctl install booted "$app"
    xcrun simctl launch booted com.keepitmello.rubato
  fi
  printf 'simulator app: %s\n' "$app"
  exit 0
fi

: "${ASC_KEY_ID:?set ASC_KEY_ID}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}" "${ASC_KEY_PATH:?set ASC_KEY_PATH}"
auth=(-allowProvisioningUpdates -authenticationKeyPath "${ASC_KEY_PATH/#\~/$HOME}"
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
archive="$out/Rubato-$build_number.xcarchive"
xcodebuild -workspace ios/Rubato.xcworkspace -scheme Rubato -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic "${auth[@]}" archive | grep -E 'error:|ARCHIVE' | tail -20
cat > "$work/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><false/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$work/export.plist" \
  -exportPath "$out/export-$build_number" "${auth[@]}" | grep -E 'error|EXPORT|Upload|upload' | tail -20
printf 'uploaded build %s\n' "$build_number"
