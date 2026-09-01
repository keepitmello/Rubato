import Foundation

protocol ChatSessionProvider: Sendable {
    func loadSessions() async throws -> [ChatSession]
    func createSession() async throws -> ChatSession
    func createSession(cwd: String, name: String?, thinkingLevel: String?) async throws -> ChatSession
    func deleteSession(sessionID: UUID) async throws
    func setPinned(sessionID: UUID, isPinned: Bool) async throws
}

extension ChatSessionProvider {
    func createSession(cwd: String, name: String?, thinkingLevel: String?) async throws -> ChatSession {
        try await createSession()
    }
}
