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

        guard case let .paragraph(_, first) = blocks[0],
              case let .code(_, language, code) = blocks[1],
              case let .paragraph(_, last) = blocks[2] else {
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
        guard case let .paragraph(_, value) = blocks[0] else {
            return XCTFail("문단이어야 해요")
        }
        XCTAssertEqual(value, "그냥 텍스트")
    }

    func testParsesHeadingsListsQuotesAndRules() {
        let source = """
        ## 구현 스텝

        **공통 문구 확정**

        - 문구 고정
        - unread > 0일 때만

        > 로그인/새로고침

        ---

        마지막 문단
        """

        let blocks = MarkdownBlockParser.parse(source)
        XCTAssertEqual(blocks.count, 6)

        guard case let .heading(_, level, heading) = blocks[0] else {
            return XCTFail("제목")
        }
        XCTAssertEqual(level, 2)
        XCTAssertEqual(heading, "구현 스텝")

        guard case let .paragraph(_, paragraph) = blocks[1] else {
            return XCTFail("문단")
        }
        XCTAssertEqual(paragraph, "**공통 문구 확정**")

        guard case let .list(_, ordered, items) = blocks[2] else {
            return XCTFail("목록")
        }
        XCTAssertFalse(ordered)
        XCTAssertEqual(items, ["문구 고정", "unread > 0일 때만"])

        guard case let .quote(_, quote) = blocks[3] else {
            return XCTFail("인용")
        }
        XCTAssertEqual(quote, "로그인/새로고침")

        guard case .rule = blocks[4] else {
            return XCTFail("구분선")
        }

        guard case let .paragraph(_, last) = blocks[5] else {
            return XCTFail("마지막")
        }
        XCTAssertEqual(last, "마지막 문단")
    }

    func testTextFenceHidesLanguageLabel() {
        let blocks = MarkdownBlockParser.parse("```text\nhello\n```")
        guard case let .code(_, language, code) = blocks[0] else {
            return XCTFail("코드")
        }
        XCTAssertNil(language)
        XCTAssertEqual(code, "hello")
    }
}
