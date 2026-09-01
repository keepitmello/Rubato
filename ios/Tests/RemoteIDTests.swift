import XCTest
@testable import RubatoChatDemo

final class RemoteIDTests: XCTestCase {
    func testUUIDStringsPassThrough() {
        let remote = "018F0C7B-2F3B-7C4D-9E5F-1234567890AB"
        XCTAssertEqual(RemoteID.uuid(from: remote), UUID(uuidString: remote))
    }

    func testOpaqueIdsAreStable() {
        XCTAssertEqual(RemoteID.uuid(from: "pi-message-1"), RemoteID.uuid(from: "pi-message-1"))
        XCTAssertNotEqual(RemoteID.uuid(from: "pi-message-1"), RemoteID.uuid(from: "pi-message-2"))
    }
}
