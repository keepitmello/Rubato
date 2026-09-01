import XCTest
@testable import RubatoChatDemo

final class ConversationReducerTests: XCTestCase {
    func testIncrementalDeltaAndCommit() {
        let session = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab"
        var state = ConversationState()
        let start = event(type: "message.start", seq: 1, session: session, payload: [
            "messageId": "a1",
            "role": "assistant",
            "text": "",
        ])
        let (afterStart, started) = ConversationReducer.reduce(state, event: start)
        guard case .responseStarted(let message)? = started else {
            return XCTFail("expected start")
        }
        XCTAssertEqual(message.id, RemoteID.uuid(from: "a1"))
        state = afterStart

        let delta = event(type: "message.delta", seq: 2, session: session, payload: [
            "messageId": "a1",
            "delta": "안녕",
        ])
        let (afterDelta, deltaEvent) = ConversationReducer.reduce(state, event: delta)
        guard case .responseDelta(let id, let text)? = deltaEvent else {
            return XCTFail("expected delta")
        }
        XCTAssertEqual(id, RemoteID.uuid(from: "a1"))
        XCTAssertEqual(text, "안녕")
        state = afterDelta

        let commit = event(type: "message.commit", seq: 3, session: session, payload: [
            "messageId": "a1",
            "text": "안녕",
            "phase": "final",
        ])
        let (afterCommit, completed) = ConversationReducer.reduce(state, event: commit)
        guard case .responseCompleted(let completedID)? = completed else {
            return XCTFail("expected commit")
        }
        XCTAssertEqual(completedID, RemoteID.uuid(from: "a1"))
        XCTAssertEqual(afterCommit.entries.last?.streaming, false)
    }

    func testToolAndUiRequest() {
        let session = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab"
        var state = ConversationState()
        let start = event(type: "tool.start", seq: 1, session: session, payload: [
            "messageId": "t1",
            "name": "bash",
            "summary": "실행 중",
        ])
        let (afterTool, _) = ConversationReducer.reduce(state, event: start)
        XCTAssertEqual(afterTool.entries.last?.kind, .tool)
        state = afterTool

        let request = event(type: "ui.request", seq: 2, session: session, payload: [
            "requestId": "r1",
            "kind": "confirm",
            "title": "이 패치를 적용할까요?",
        ])
        let (afterRequest, _) = ConversationReducer.reduce(state, event: request)
        XCTAssertEqual(afterRequest.uiRequest?.requestId, "r1")
        XCTAssertEqual(afterRequest.uiRequest?.kind, "confirm")
    }

    func testParseSnapshotReadsHubHttpShape() throws {
        let data = """
        {
          "summary": { "liveSessionId": "018f0c7b-2f3b-7c4d-9e5f-1234567890ab", "title": "TX Flex", "cwd": "/tmp/app", "execution": "idle", "lifecycle": "ready" },
          "revision": 911,
          "lastSeq": 903,
          "entries": [
            { "id": "t1", "kind": "tool", "name": "bash", "summary": "done", "status": "done" },
            { "id": "m1", "kind": "message", "role": "user", "text": "계획 ㄱㄱ", "at": "2026-08-31T18:35:54.579Z" },
            { "id": "m2", "kind": "message", "role": "assistant", "text": "READY 상태입니다.", "at": "2026-08-31T19:13:50.041Z" }
          ]
        }
        """.data(using: .utf8)!
        let snapshot = ConversationReducer.parseSnapshot(try JSONObject.parseObject(data))
        XCTAssertEqual(snapshot.lastSeq, 903)
        XCTAssertEqual(snapshot.revision, 911)
        let messages = ConversationMapping.chatMessages(sessionID: RemoteID.uuid(from: snapshot.liveSessionId), entries: snapshot.entries)
        XCTAssertEqual(messages.map(\.text), ["계획 ㄱㄱ", "READY 상태입니다."])
        XCTAssertEqual(messages.first?.role, .user)
        XCTAssertEqual(messages.last?.role, .assistant)
    }

    func testNegotiatedProtocolVersionPrefersHostNegotiation() throws {
        let data = """
        {"protocol":{"min":1,"max":1},"negotiation":{"compatible":true,"version":1}}
        """.data(using: .utf8)!
        XCTAssertEqual(RubatoProtocol.negotiatedVersion(from: try JSONObject.parseObject(data)), 1)
    }

    func testJSONObjectIntReadsNSNumber() throws {
        let data = "{\"seq\": 4206, \"lastSeq\": 0}".data(using: .utf8)!
        let json = try JSONObject.parseObject(data)
        XCTAssertEqual(json.int("seq"), 4206)
        XCTAssertEqual(json.int("lastSeq"), 0)
    }

    func testChatMessageMappingSkipsTools() {
        let sessionID = UUID()
        let entries = [
            ConversationEntry(id: "m1", kind: .message, role: "user", text: "hi", streaming: false),
            ConversationEntry(id: "t1", kind: .tool, role: nil, text: "run", streaming: false, name: "bash", summary: "done", status: "done"),
            ConversationEntry(id: "m2", kind: .message, role: "assistant", text: "ok", streaming: false),
        ]
        let messages = ConversationMapping.chatMessages(sessionID: sessionID, entries: entries)
        XCTAssertEqual(messages.map(\.text), ["hi", "ok"])
    }

    private func event(type: String, seq: Int, session: String, payload: [String: Any]) -> HubEvent {
        HubEvent(
            type: type,
            liveSessionId: session,
            seq: seq,
            at: "2026-08-31T01:00:00.000Z",
            payload: JSONObject(payload),
            messageId: payload["messageId"] as? String
        )
    }
}
