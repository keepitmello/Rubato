import Foundation

actor RubatoSessionProvider: ChatSessionProvider {
    private let client: HubClient

    init(client: HubClient) {
        self.client = client
    }

    func loadSessions() async throws -> [ChatSession] {
        _ = try await client.ensureHost()
        let pinned = await MainActor.run { HostSettings.pinnedIDs }
        return try await client.inventory().compactMap { ConversationMapping.session(from: $0, pinned: pinned) }
    }

    func createSession() async throws -> ChatSession {
        throw HubClientError.http(status: 400, code: "invalid_action", message: "작업 폴더를 먼저 골라 주세요.")
    }

    func createSession(cwd: String, name: String?, thinkingLevel: String?) async throws -> ChatSession {
        let id = try await client.createLive(cwd: cwd, name: name, thinkingLevel: thinkingLevel)
        return ChatSession(
            id: RemoteID.uuid(from: id),
            title: name?.isEmpty == false ? name! : ConversationMapping.shortPath(cwd),
            subtitle: ConversationMapping.shortPath(cwd),
            updatedAt: .now,
            state: .running
        )
    }

    func deleteSession(sessionID: UUID) async throws {
        try await client.terminate(liveSessionId: sessionID.uuidString.lowercased(), force: false)
    }

    func setPinned(sessionID: UUID, isPinned: Bool) async throws {
        await MainActor.run {
            var pinned = HostSettings.pinnedIDs
            if isPinned {
                pinned.insert(sessionID)
            } else {
                pinned.remove(sessionID)
            }
            HostSettings.pinnedIDs = pinned
        }
    }
}
