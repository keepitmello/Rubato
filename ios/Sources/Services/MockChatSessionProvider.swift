import Foundation

actor MockChatSessionProvider: ChatSessionProvider {
    private var sessions: [ChatSession]

    init(seed: [ChatSession]) {
        sessions = seed
    }

    func loadSessions() async throws -> [ChatSession] {
        sortedSessions()
    }

    func createSession() async throws -> ChatSession {
        let session = ChatSession(
            title: "새 Rubato 세션",
            subtitle: "새 대화를 시작해 보세요.",
            updatedAt: .now,
            state: .idle
        )
        sessions.append(session)
        return session
    }

    func deleteSession(sessionID: UUID) async throws {
        sessions.removeAll { $0.id == sessionID }
    }

    func setPinned(sessionID: UUID, isPinned: Bool) async throws {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].isPinned = isPinned
    }

    private func sortedSessions() -> [ChatSession] {
        sessions.sorted {
            if $0.isPinned != $1.isPinned { return $0.isPinned }
            return $0.updatedAt > $1.updatedAt
        }
    }
}
