#!/bin/bash
# /Applications/Rubato.app 을 만들어 Dock/Finder에서 더블클릭으로 켠다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${RUBATO_T3_APP:-/Applications/Rubato.app}"
T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_HOME="${RUBATO_T3_HOME:-$HOME/.rubato/t3-home}"
AGENT_DIR="${RUBATO_PI_CODING_AGENT_DIR:-$HOME/.rubato-pi/agent}"

find_node24() {
  local bin ver major
  for bin in "${HOME}/.nvm/versions/node"/*/bin/node /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -n "$bin" ] && [ -x "$bin" ] || continue
    ver="$("$bin" -v 2>/dev/null || true)"; major="${ver#v}"; major="${major%%.*}"
    [ -n "$major" ] || continue
    if [ "$major" -ge 24 ] 2>/dev/null; then printf '%s' "$bin"; return 0; fi
  done
  return 1
}

NODE="$(find_node24)" || { printf 'Node 24+ 가 없다\n' >&2; exit 1; }

CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES"

ICON=""
for candidate in \
  "$HERE/../../rubato-codex/macos/Rubato.icns" \
  "$T3_DIR/apps/desktop/.electron-runtime/icon-prod.icns"
do
  [ -f "$candidate" ] && ICON="$candidate" && break
done
if [ -n "$ICON" ]; then
  cp "$ICON" "$RES/AppIcon.icns"
fi

cat > "$MACOS/Rubato" <<EOF
#!/bin/bash
export PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
export RUBATO_T3_SOURCE=$(printf '%q' "$T3_DIR")
export RUBATO_T3_HOME=$(printf '%q' "$T3_HOME")
export RUBATO_PI_CODING_AGENT_DIR=$(printf '%q' "$AGENT_DIR")
exec /bin/bash $(printf '%q' "$HERE/start-gui.sh")
EOF
chmod +x "$MACOS/Rubato"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Rubato</string>
  <key>CFBundleDisplayName</key><string>Rubato</string>
  <key>CFBundleIdentifier</key><string>app.rubato.t3</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Rubato</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [ -d "/Applications/T3 Code.app" ]; then
  rm -rf "/Applications/T3 Code.app"
fi

printf '%s\n' "$APP"
