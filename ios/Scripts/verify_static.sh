#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v swiftc >/dev/null 2>&1 || {
  echo "swiftc를 찾을 수 없어요." >&2
  exit 1
}

SWIFT_FILES="$(find Sources Tests -type f -name '*.swift' | sort)"
# iOS 전용 모듈을 가져오는 파일도 파서 단계에서는 점검할 수 있다.
swiftc -parse $SWIFT_FILES

# Linux/macOS 양쪽에서 가능한 핵심 자료형·통신 경계를 실제로 형 검사한다.
swiftc -swift-version 6 -strict-concurrency=complete -typecheck \
  Sources/Models/ChatModels.swift \
  Sources/Services/ChatTransport.swift \
  Sources/Services/ChatSessionProvider.swift \
  Sources/Services/MockChatSessionProvider.swift \
  Sources/Services/MockRubatoTransport.swift \
  Sources/Support/SampleData.swift

# UI 프레임워크만 최소 선언으로 바꿔 저장소/AppModel의 동시성·형 오류를 점검한다.
swiftc -swift-version 6 -strict-concurrency=complete -typecheck \
  Sources/Models/ChatModels.swift \
  Sources/Services/ChatTransport.swift \
  Sources/Services/ChatSessionProvider.swift \
  Sources/Services/MockChatSessionProvider.swift \
  Sources/Services/MockRubatoTransport.swift \
  Sources/Support/SampleData.swift \
  Scripts/store_typecheck_stubs.swift \
  Sources/Store/ChatRoomStore.swift \
  Sources/App/AppModel.swift

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# XCTest 자동 클로저에 가려지는 비동기 형 오류도 Xcode 전에 잡는다.
python3 - "$ROOT" "$TMP_DIR" <<'PY_TEST'
from pathlib import Path
import sys

root = Path(sys.argv[1])
tmp = Path(sys.argv[2])
source = (root / "Tests/ChatRoomStoreTests.swift").read_text()
(tmp / "ChatRoomStoreTests.swift").write_text(
    source.replace("@testable import RubatoChatDemo\n", "")
)
PY_TEST
swiftc -swift-version 6 -strict-concurrency=complete -typecheck \
  Sources/Models/ChatModels.swift \
  Sources/Services/ChatTransport.swift \
  Scripts/store_typecheck_stubs.swift \
  Sources/Store/ChatRoomStore.swift \
  "$TMP_DIR/ChatRoomStoreTests.swift"

# 가짜 Rubato 통신 구현의 스트리밍·저장·세션 수명 주기를 실행한다.
swiftc -parse-as-library -swift-version 6 \
  Sources/Models/ChatModels.swift \
  Sources/Services/ChatTransport.swift \
  Sources/Services/ChatSessionProvider.swift \
  Sources/Services/MockChatSessionProvider.swift \
  Sources/Services/MockRubatoTransport.swift \
  Scripts/mock_transport_smoke.swift \
  -o "$TMP_DIR/mock-transport-smoke"
"$TMP_DIR/mock-transport-smoke"

# 저장소 상태 전이도 가짜 화면 의존성으로 실제 실행한다.
swiftc -parse-as-library -swift-version 6 \
  Sources/Models/ChatModels.swift \
  Sources/Services/ChatTransport.swift \
  Scripts/store_typecheck_stubs.swift \
  Sources/Store/ChatRoomStore.swift \
  Scripts/store_runtime_smoke.swift \
  -o "$TMP_DIR/store-runtime-smoke"
"$TMP_DIR/store-runtime-smoke"

# 마크다운 파서는 iOS 화면 코드와 분리해 실제 입력을 실행해 본다.
python3 - "$ROOT" "$TMP_DIR" <<'PY_MARKDOWN'
from pathlib import Path
import sys

root = Path(sys.argv[1])
tmp = Path(sys.argv[2])
source = (root / "Sources/Views/Shared/MarkdownBlocks.swift").read_text()
logic = source[: source.index("struct AgentMarkdownView")]
logic = logic.replace("import SwiftUI\nimport UIKit\n", "import Foundation\n")
smoke = logic + r'''

@main
struct MarkdownParserSmoke {
    static func main() {
        let blocks = MarkdownBlockParser.parse("""
        설명이에요.

        ```swift
        print("hello")
        ```

        끝이에요.
        """)
        precondition(blocks.count == 3)
        guard case let .code(_, language, code) = blocks[1] else {
            preconditionFailure("코드 블록을 찾지 못했어요")
        }
        precondition(language == "swift")
        precondition(code == "print(\"hello\")")

        let unfinished = MarkdownBlockParser.parse("앞\n```swift\nlet x = 1")
        precondition(unfinished.count == 2)
        print("markdown parser smoke: OK")
    }
}
'''
(tmp / "markdown-parser-smoke.swift").write_text(smoke)
PY_MARKDOWN
swiftc -parse-as-library -swift-version 6 \
  "$TMP_DIR/markdown-parser-smoke.swift" \
  -o "$TMP_DIR/markdown-parser-smoke"
"$TMP_DIR/markdown-parser-smoke"

python3 Scripts/regenerate_xcodeproj.py >/dev/null
if command -v plutil >/dev/null 2>&1; then
  plutil -lint RubatoChatDemo.xcodeproj/project.pbxproj
fi

grep -q 'cf01193e9d20d448d0005f563063924c667e4496' \
  RubatoChatDemo.xcodeproj/project.pbxproj

# 공유 스킴 XML과 고정된 앱/테스트 대상 참조가 유효한지 확인한다.
python3 - <<'PY_SCHEME'
from pathlib import Path
import xml.etree.ElementTree as ET

scheme = Path('RubatoChatDemo.xcodeproj/xcshareddata/xcschemes/RubatoChatDemo.xcscheme')
root = ET.parse(scheme).getroot()
assert root.tag == 'Scheme'
blueprint_ids = {node.attrib.get('BlueprintIdentifier') for node in root.iter('BuildableReference')}
assert 'F75109BEB4DD8800DA6B45F8' in blueprint_ids
assert 'C062A5A4A7F4F37DD90F54CB' in blueprint_ids
print(f'{scheme}: XML OK')
PY_SCHEME

echo "static verification: OK"
