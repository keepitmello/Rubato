#!/bin/bash
# T3 런타임 번들을 더블클릭으로도 켜지게 만들고, /Applications 에 그 번들로 가는
# 이름을 건다.
#
# 앱을 켜면 Dock 에 뜨는 것은 T3 런처가 만드는 .electron-runtime/Rubato.app 이다.
# 사용자가 고정하는 것도 그것이다. 예전에는 이 자리에 얇은 껍데기 번들을 따로
# 두었는데, 껍데기와 실행 중인 번들이 서로 다른 앱(번들 id 가 둘)이라 Dock 에
# 아이콘이 둘 뜨고, 정작 실행 중인 번들은 인자 없이 켜면 맨 Electron 안내 화면이
# 떴다. 그래서 껍데기를 없애고 런타임 번들 하나로 합친다.
#
# 합치는 방법은 Electron 규약이다. 인자 없이 켜면 Electron 은 번들 안
# Contents/Resources/app 을 앱으로 삼는다. 거기에 T3 본체를 부르는 진입점만 넣는다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${RUBATO_T3_APP:-/Applications/Rubato.app}"
T3_DIR="${RUBATO_T3_SOURCE:-$HOME/.rubato/t3-source}"
T3_HOME="${RUBATO_T3_HOME:-$HOME/.rubato/t3-home}"
DESKTOP="$T3_DIR/apps/desktop"
BUNDLE="$DESKTOP/.electron-runtime/Rubato.app"

. "$HERE/../scripts/find-node.sh"
NODE="$(rubato_find_node)" || { printf 'Node 24+ 가 없다\n' >&2; exit 1; }

# 번들은 T3 런처가 만든다. 여기서 직접 만들면 서명·헬퍼 번들 이름이 갈라진다.
# 이 호출은 앱을 띄우지 않고 번들만 최신으로 맞춘다.
(cd "$DESKTOP" && "$NODE" -e \
  'import("./scripts/electron-launcher.mjs").then((m) => m.resolveElectronLaunchCommand([]))') >/dev/null

[ -d "$BUNDLE" ] || { printf '런타임 번들을 못 만들었다: %s\n' "$BUNDLE" >&2; exit 1; }

# 기본값이 아닌 홈만 굽는다. 기본값은 진입점이 $HOME 에서 다시 만든다.
if [ "$T3_HOME" = "$HOME/.rubato/t3-home" ]; then
  HOME_LINE='process.env.T3CODE_HOME ||= path.join(os.homedir(), ".rubato", "t3-home");'
else
  HOME_JSON="$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$T3_HOME")"
  HOME_LINE="process.env.T3CODE_HOME ||= $HOME_JSON;"
fi

ENTRY="$BUNDLE/Contents/Resources/app"
mkdir -p "$ENTRY"
cat > "$ENTRY/package.json" <<'JSON'
{ "name": "rubato", "productName": "Rubato", "main": "index.js" }
JSON
# 경로를 굽지 않는다. 이 파일은 항상 <desktop>/.electron-runtime/Rubato.app 안에
# 있으므로 다섯 단계 위가 데스크톱 디렉터리다. 예전에 검증용 /private/tmp 경로가
# 런처에 박힌 채 남아서, tmp 가 비워진 뒤로 앱이 조용히 안 켜졌다.
cat > "$ENTRY/index.js" <<JS
// Dock/Finder 로 켤 때의 진입점. 터미널 경로(start-gui.sh)는 main.cjs 를 직접
// 넘기므로 이 파일을 지나지 않는다.
const path = require("node:path");
const os = require("node:os");
const desktopDir = path.resolve(__dirname, "..", "..", "..", "..", "..");
$HOME_LINE
process.chdir(desktopDir);
require(path.join(desktopDir, "dist-electron", "main.cjs"));
JS

# Resources 에 파일을 넣으면 런처가 걸어둔 애드혹 서명이 깨진다. 같은 인자로 다시 건다.
codesign --force --deep --sign - --timestamp=none "$BUNDLE" >/dev/null 2>&1 || true

# /Applications 이름은 Finder·Spotlight 용이다. 복사본이 아니라 링크라서
# 업데이트로 번들이 바뀌어도 따라간다. Dock 고정은 실행 중 뜨는 아이콘으로 한다
# — 링크를 고정하면 macOS 가 실행 중인 번들과 같은 앱으로 못 알아보고 둘로 띄운다.
if [ ! -L "$APP" ] || [ "$(readlink "$APP")" != "$BUNDLE" ]; then
  rm -rf "$APP"
  ln -s "$BUNDLE" "$APP"
fi

if [ -d "/Applications/T3 Code.app" ]; then
  rm -rf "/Applications/T3 Code.app"
fi

printf '%s\n' "$BUNDLE"
