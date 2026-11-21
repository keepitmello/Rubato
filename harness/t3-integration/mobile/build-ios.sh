#!/usr/bin/env bash
# Builds the Rubato iPhone app from the pinned T3 apps/mobile plus this overlay.
#
#   build-ios.sh --simulator     Release build for the iOS simulator (no signing), installed
#                                on a booted simulator when one is running
#   build-ios.sh --archive       signed archive for a device, kept in ~/.rubato/t3-mobile-build;
#                                nothing is uploaded
#   build-ios.sh --upload ARCHIVE
#                                uploads an archive made by --archive to App Store Connect
#   build-ios.sh --testflight    --archive, then --upload of that archive
#
# It builds in its own tree ($RUBATO_T3_MOBILE, default ~/.rubato/t3-mobile): a git worktree
# of the desktop's T3 checkout at the pin. The desktop's ~/.rubato/t3-source is never touched.
# Signing and upload sign in with the App Store Connect API key in ASC_KEY_ID / ASC_ISSUER_ID /
# ASC_KEY_PATH (a .p8 that stays on this Mac).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INTEGRATION="$(dirname "$HERE")"
T3_SOURCE="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_MOBILE="${RUBATO_T3_MOBILE:-$HOME/.rubato/t3-mobile}"
out="$HOME/.rubato/t3-mobile-build"
TEAM_ID=5WGZKZGPQS
MODE="${1:-}"
usage='usage: build-ios.sh --simulator | --archive | --testflight | --upload ARCHIVE'
case "$MODE" in --simulator|--archive|--testflight) ;; --upload) [ -n "${2:-}" ] || { printf '%s\n' "$usage" >&2; exit 2; } ;; *)
  printf '%s\n' "$usage" >&2; exit 2 ;;
esac
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 EXPO_NO_GIT_STATUS=1 APP_VARIANT=production LANG=en_US.UTF-8

asc_auth() {
  : "${ASC_KEY_ID:?set ASC_KEY_ID}" "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}" "${ASC_KEY_PATH:?set ASC_KEY_PATH}"
  auth=(-allowProvisioningUpdates -authenticationKeyPath "${ASC_KEY_PATH/#\~/$HOME}"
    -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
}

# Exports the archive for App Store Connect and uploads it; the export folder is not kept.
upload() {
  local archive="$1" version build plist
  plist="$archive/Info.plist"
  build="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' "$plist")"
  version="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$plist")"
  asc_auth
  local tmp; tmp="$(mktemp -d)"
  cat > "$tmp/export.plist" <<PLIST
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
  mkdir -p "$out"
  xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$tmp/export.plist" \
    -exportPath "$tmp/export" "${auth[@]}" > "$out/export.log" 2>&1 \
    || { rm -rf "$tmp"; grep -iE 'error|EXPORT FAILED' "$out/export.log" | tail -20; exit 1; }
  rm -rf "$tmp"
  printf 'uploaded %s (%s)\n' "$version" "$build"
}

if [ "$MODE" = --upload ]; then
  archive="$(cd "$2" && pwd -P)"
  [ -f "$archive/Info.plist" ] || { printf 'not an archive: %s\n' "$2" >&2; exit 1; }
  upload "$archive"
  exit 0
fi

pin="$(node -p "require('$INTEGRATION/upstream.json').upstreamCommit")"
if [ ! -d "$T3_MOBILE/.git" ] && [ ! -f "$T3_MOBILE/.git" ]; then
  git -C "$T3_SOURCE" worktree add --detach "$T3_MOBILE" "$pin"
fi
[ "$(git -C "$T3_MOBILE" rev-parse HEAD)" = "$pin" ] || git -C "$T3_MOBILE" checkout --detach "$pin"
# The integration as committed, not the shared working tree: other sessions' unfinished
# edits there can stop apply.mjs. RUBATO_MOBILE_WORKTREE=1 builds the working tree instead.
# The real path: apply.mjs runs its command line only when argv[1] resolves to its own
# file URL, and mktemp's /var/folders is /private/var/folders underneath.
work="$(cd "$(mktemp -d)" && pwd -P)"
# This Mac has little disk, so every run, finished or failed, leaves only the logs, the
# simulator app and the last two archives. expo prebuild --clean rewrites ios/ and pod install
# downloads Pods again (its cache is cleared below) on every run, so the native tree (Pods
# alone are about 3 GB) and Xcode's intermediates are never reused.
cleanup() {
  rm -rf "$work" "$T3_MOBILE/apps/mobile/ios" "$out/sim" "$out/device" "$out"/export-*
}
trap cleanup EXIT
source_dir="$INTEGRATION"
if [ "${RUBATO_MOBILE_WORKTREE:-}" != 1 ]; then
  source_dir="$work/integration"; mkdir -p "$source_dir"
  # From the repository root: run inside a subfolder, git archive keeps only that subfolder's
  # paths of the tree it is given, and here that is nothing.
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
# The app icon must be square and opaque: the inner tile of the desktop icon, flattened.
mkdir -p assets/rubato
sips -c 720 720 "$source_dir/assets/Rubato.png" --out "$work/tile.png" >/dev/null
sips -z 1024 1024 -s format jpeg "$work/tile.png" --out "$work/tile.jpg" >/dev/null
sips -s format png "$work/tile.jpg" --out assets/rubato/icon.png >/dev/null
# The desktop overlay replaces T3's theme palettes; the phone's style sheets follow them.
corepack pnpm run generate >/dev/null
# Over-the-air updates (update-ios.sh) reach a build only when both carry the same runtime version,
# the fingerprint of this tree before prebuild. Left to Xcode, it is taken after prebuild and also
# hashes ios/ with this build's number, so no update would ever match; pin it to the update's value.
rm -rf ios
EXPO_UPDATES_FINGERPRINT_OVERRIDE="$(corepack pnpm exec expo-updates fingerprint:generate --platform ios \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hash))')"
export EXPO_UPDATES_FINGERPRINT_OVERRIDE
corepack pnpm exec expo prebuild --clean --platform ios --no-install >/dev/null
# This Mac has little disk: CocoaPods' download cache regrows to several GB per install, so it
# lives in this run's folder, which cleanup removes. The shared ~/Library/Caches/CocoaPods is not
# used: another build installing pods at the same time read a cache this one was deleting.
(cd ios && CP_CACHE_DIR="$work/cocoapods-cache" pod install)

build_number="$(date -u +%Y%m%d%H%M)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" ios/Rubato/Info.plist
mkdir -p "$out"

if [ "$MODE" = --simulator ]; then
  xcodebuild -workspace ios/Rubato.xcworkspace -scheme Rubato -configuration Release \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$out/sim" ARCHS=arm64 CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- \
    DEVELOPMENT_TEAM="$TEAM_ID" build > "$out/sim.log" 2>&1 \
    || { grep -E ' error: |^error:|BUILD FAILED' "$out/sim.log" | tail -20; exit 1; }
  # T3's vendored GhosttyKit carries no x86_64 simulator slice, hence ARCHS=arm64. The ad-hoc
  # signature keeps the entitlements: without its keychain group, saved Macs cannot be read.
  # The app moves out of the derived data, which cleanup removes.
  app="$out/Rubato-simulator.app"
  rm -rf "$app"
  ditto "$out/sim/Build/Products/Release-iphonesimulator/Rubato.app" "$app"
  if xcrun simctl list devices booted | grep -q Booted; then
    xcrun simctl install booted "$app"
    xcrun simctl launch booted com.keepitmello.rubato
  fi
  printf 'simulator app: %s\n' "$app"
  exit 0
fi

# An archive needs about 8 GB on top of the tree; stop before it fails halfway.
free_kb="$(df -k "$out" | awk 'NR==2 {print $4}')"
if [ "$free_kb" -lt $((8 * 1024 * 1024)) ]; then
  printf 'only %s GB free; an archive needs about 8 GB. Free space first.\n' "$((free_kb / 1024 / 1024))" >&2
  exit 1
fi
asc_auth
archive="$out/Rubato-$build_number.xcarchive"
xcodebuild -workspace ios/Rubato.xcworkspace -scheme Rubato -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$archive" -derivedDataPath "$out/device" \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic "${auth[@]}" archive > "$out/archive.log" 2>&1 \
  || { grep -E ' error: |^error:|ARCHIVE FAILED' "$out/archive.log" | tail -20; exit 1; }
# Keep the archive (symbols for crash reports) of the last two builds only; cleanup removes
# the intermediates.
ls -1dt "$out"/Rubato-*.xcarchive | tail -n +3 | while read -r old; do rm -rf "$old"; done
printf 'archive: %s\n' "$archive"
[ "$MODE" = --archive ] && exit 0
upload "$archive"
