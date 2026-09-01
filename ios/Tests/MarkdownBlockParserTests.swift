import XCTest
@testable import RubatoChatDemo

final class MarkdownBlockParserTests: XCTestCase {
    func testParsesTextAndCodeFenceInOrder() {
        let source = """
        설명이에요.

        ```swift
        print("hello")
        ```

        끝이에요.
        """

        let blocks = MarkdownBlockParser.parse(source)
        XCTAssertEqual(blocks.count, 3)

        guard case let .text(_, first) = blocks[0],
              case let .code(_, language, code) = blocks[1],
              case let .text(_, last) = blocks[2] else {
            return XCTFail("블록 순서가 달라요")
        }

        XCTAssertEqual(first, "설명이에요.")
        XCTAssertEqual(language, "swift")
        XCTAssertEqual(code, "print(\"hello\")")
        XCTAssertEqual(last, "끝이에요.")
    }

    func testPlainTextStaysSingleBlock() {
        let blocks = MarkdownBlockParser.parse("그냥 텍스트")
        XCTAssertEqual(blocks.count, 1)
    }
}
