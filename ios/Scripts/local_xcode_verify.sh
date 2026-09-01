#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v xcodebuild >/dev/null 2>&1 || {
  echo "Xcode 명령줄 도구가 필요해요." >&2
  exit 1
}

: "${DESTINATION:?DESTINATION을 설치된 iOS 26 시뮬레이터로 지정해 주세요. 예: platform=iOS Simulator,name=iPhone 17 Pro}"

./Scripts/verify_static.sh

xcodebuild \
  -resolvePackageDependencies \
  -project RubatoChatDemo.xcodeproj \
  -scheme RubatoChatDemo

xcodebuild \
  -project RubatoChatDemo.xcodeproj \
  -scheme RubatoChatDemo \
  -configuration Debug \
  -destination "$DESTINATION" \
  CODE_SIGNING_ALLOWED=NO \
  clean build

xcodebuild \
  -project RubatoChatDemo.xcodeproj \
  -scheme RubatoChatDemo \
  -configuration Debug \
  -destination "$DESTINATION" \
  CODE_SIGNING_ALLOWED=NO \
  test
