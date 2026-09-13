#!/bin/bash
# /Applications/Rubato.app 을 만들어 Dock/Finder에서 더블클릭으로 켠다.
#
# 이 번들은 얇은 껍데기다. 실제로 Dock 에 뜨는 것은 T3 런처가 만드는
# .electron-runtime/Rubato.app 이고, 껍데기는 LSUIElement 로 숨는다.
# 껍데기에는 start-gui.sh 경로 말고 아무 상태도 굽지 않는다 — 예전에 검증용
# /private/tmp 경로가 여기 박힌 채 남아서, tmp 가 비워진 뒤로 앱이 조용히
# 안 켜졌다. 나머지 경로는 실행할 때 start-gui.sh 가 정한다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${RUBATO_T3_APP:-/Applications/Rubato.app}"
T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_HOME="${RUBATO_T3_HOME:-$HOME/.rubato/t3-home}"
AGENT_DIR="${RUBATO_PI_CODING_AGENT_DIR:-$HOME/.rubato-pi/agent}"

# 기본값이 아닌 것만 굽는다. 기본값은 start-gui.sh 가 $HOME 에서 다시 만든다.
launch_env() {
  [ "$T3_DIR" = "$HOME/.rubato/t3-source" ] || printf 'export RUBATO_T3_SOURCE=%q\n' "$T3_DIR"
  [ "$T3_HOME" = "$HOME/.rubato/t3-home" ] || printf 'export RUBATO_T3_HOME=%q\n' "$T3_HOME"
  [ "$AGENT_DIR" = "$HOME/.rubato-pi/agent" ] || printf 'export RUBATO_PI_CODING_AGENT_DIR=%q\n' "$AGENT_DIR"
}

LAUNCHER="$(printf '#!/bin/bash\n%sexec /bin/bash %q\n' "$(launch_env)" "$HERE/start-gui.sh")"

read -r -d '' PLIST <<'PLIST' || true
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Rubato</string>
  <key>CFBundleDisplayName</key><string>Rubato</string>
  <key>CFBundleIdentifier</key><string>app.rubato.t3.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Rubato</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

ICON=""
for candidate in \
  "$HERE/../../rubato-codex/macos/Rubato.icns" \
  "$T3_DIR/apps/desktop/.electron-runtime/icon-prod.icns"
do
  [ -f "$candidate" ] && ICON="$candidate" && break
done

# 같은 내용이면 손대지 않는다. 매번 지웠다 만들면 Dock 에 고정해둔 아이콘이
# 업데이트마다 끊긴다.
fresh=0
[ -f "$MACOS/Rubato" ] && [ "$(cat "$MACOS/Rubato")" = "$LAUNCHER" ] || fresh=1
[ -f "$CONTENTS/Info.plist" ] && [ "$(cat "$CONTENTS/Info.plist")" = "$PLIST" ] || fresh=1
[ -z "$ICON" ] || [ -f "$RES/AppIcon.icns" ] || fresh=1

if [ "$fresh" = 1 ]; then
  rm -rf "$APP"
  mkdir -p "$MACOS" "$RES"
  [ -z "$ICON" ] || cp "$ICON" "$RES/AppIcon.icns"
  printf '%s\n' "$LAUNCHER" > "$MACOS/Rubato"
  chmod +x "$MACOS/Rubato"
  printf '%s\n' "$PLIST" > "$CONTENTS/Info.plist"
fi

if [ -d "/Applications/T3 Code.app" ]; then
  rm -rf "/Applications/T3 Code.app"
fi

printf '%s\n' "$APP"
