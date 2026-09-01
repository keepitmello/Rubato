import Foundation
#if canImport(Combine)
import Combine
#endif

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var sessions: [ChatSession]
    @Published private(set) var isLoadingSessions = false
    @Published var transientError: String?
    @Published var projects: [ProjectChoiceItem] = []
    @Published var gitBySession: [UUID: GitView] = [:]
    @Published var terminalOutput: [UUID: String] = [:]
    @Published var connectionText = "허브에 연결하세요"

    let extras: RubatoSessionExtras
    let isRemote: Bool

    private let transport: any ChatTransport
    private let sessionProvider: any ChatSessionProvider
    private let client: HubClient?
    private let remoteTransport: RubatoChatTransport?
    private var roomStores: [UUID: ChatRoomStore] = [:]
    private var terminals: [UUID: HubTerminal] = [:]
    private var didLoadSessions = false

    init(
        sessions: [ChatSession] = SampleData.sessions,
        transport: any ChatTransport = MockRubatoTransport(seed: SampleData.messagesBySession),
        sessionProvider: any ChatSessionProvider = MockChatSessionProvider(seed: SampleData.sessions),
        extras: RubatoSessionExtras = RubatoSessionExtras(),
        isRemote: Bool = false,
        client: HubClient? = nil,
        remoteTransport: RubatoChatTransport? = nil
    ) {
        self.sessions = Self.sorted(sessions)
        self.transport = transport
        self.sessionProvider = sessionProvider
        self.extras = extras
        self.isRemote = isRemote
        self.client = client
        self.remoteTransport = remoteTransport
        if isRemote {
            connectionText = "연결 중…"
        }
    }

    static func connectedToHub() -> AppModel {
        let extras = RubatoSessionExtras()
        let client = HubClient()
        let transport = RubatoChatTransport(client: client, extras: extras)
        let provider = RubatoSessionProvider(client: client)
        return AppModel(
            sessions: [],
            transport: transport,
            sessionProvider: provider,
            extras: extras,
            isRemote: true,
            client: client,
            remoteTransport: transport
        )
    }

    func loadSessionsIfNeeded() async {
        guard !didLoadSessions, !isLoadingSessions else { return }
        isLoadingSessions = true
        defer { isLoadingSessions = false }

        do {
            if let client, isRemote {
                let host = try await client.ensureHost()
                connectionText = "\(host.displayName) · 온라인"
                projects = (try? await client.projects()) ?? []
            }
            sessions = Self.sorted(try await sessionProvider.loadSessions())
            didLoadSessions = true
        } catch {
            connectionText = "연결 실패"
            transientError = "세션 목록을 불러오지 못했어요: \(error.localizedDescription)"
        }
    }

    func reloadSessions() async {
        didLoadSessions = false
        await loadSessionsIfNeeded()
    }

    func saveHost(urlString: String) async {
        guard let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme, scheme == "https" || scheme == "http"
        else {
            transientError = "호스트 주소가 올바르지 않아요."
            return
        }
        HostSettings.baseURL = url
        await client?.setBaseURL(url)
        connectionText = "연결 중…"
        await reloadSessions()
    }

    func session(id: UUID) -> ChatSession? {
        sessions.first { $0.id == id }
    }

    func roomStore(for session: ChatSession) -> ChatRoomStore {
        if let store = roomStores[session.id] {
            return store
        }

        let store = ChatRoomStore(session: session, transport: transport) { [weak self] summary in
            self?.apply(summary: summary)
        }
        roomStores[session.id] = store
        markRead(sessionID: session.id)
        return store
    }

    func createSession() async -> ChatRoomStore? {
        do {
            let session = try await sessionProvider.createSession()
            sessions.insert(session, at: 0)
            sessions = Self.sorted(sessions)
            return roomStore(for: session)
        } catch {
            transientError = "새 세션을 만들지 못했어요: \(error.localizedDescription)"
            return nil
        }
    }

    func createSession(cwd: String, thinkingLevel: String?) async -> ChatRoomStore? {
        do {
            let session = try await sessionProvider.createSession(
                cwd: cwd,
                name: ConversationMapping.shortPath(cwd),
                thinkingLevel: thinkingLevel
            )
            sessions.insert(session, at: 0)
            sessions = Self.sorted(sessions)
            return roomStore(for: session)
        } catch {
            transientError = "새 세션을 만들지 못했어요: \(error.localizedDescription)"
            return nil
        }
    }

    func togglePin(sessionID: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        let previousValue = sessions[index].isPinned
        sessions[index].isPinned.toggle()
        let nextValue = sessions[index].isPinned
        sessions = Self.sorted(sessions)

        Task { [weak self, sessionProvider] in
            do {
                try await sessionProvider.setPinned(sessionID: sessionID, isPinned: nextValue)
            } catch {
                guard let self else { return }
                if let currentIndex = sessions.firstIndex(where: { $0.id == sessionID }) {
                    sessions[currentIndex].isPinned = previousValue
                    sessions = Self.sorted(sessions)
                }
                transientError = "고정 상태를 바꾸지 못했어요: \(error.localizedDescription)"
            }
        }
    }

    func deleteSession(sessionID: UUID) {
        guard let removed = sessions.first(where: { $0.id == sessionID }) else { return }
        sessions.removeAll { $0.id == sessionID }
        let removedStore = roomStores.removeValue(forKey: sessionID)
        terminals[sessionID]?.close()
        terminals[sessionID] = nil

        Task { [weak self, sessionProvider] in
            do {
                try await sessionProvider.deleteSession(sessionID: sessionID)
            } catch {
                guard let self else { return }
                sessions.append(removed)
                sessions = Self.sorted(sessions)
                if let removedStore {
                    roomStores[sessionID] = removedStore
                }
                transientError = "세션을 삭제하지 못했어요: \(error.localizedDescription)"
            }
        }
    }

    func fire(sessionID: UUID, action: String, payload: [String: Any]) {
        Task {
            do {
                try await remoteTransport?.fire(sessionID: sessionID, action: action, payload: JSONObject(payload))
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func reloadArtifacts(sessionID: UUID) {
        Task {
            do {
                gitBySession[sessionID] = try await remoteTransport?.gitView(sessionID: sessionID)
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func connectTerminal(sessionID: UUID) {
        Task {
            do {
                let sessionID = sessionID
                terminals[sessionID] = try await remoteTransport?.connectTerminal(
                    sessionID: sessionID,
                    onOutput: { chunk in
                        Task { @MainActor in
                            self.terminalOutput[sessionID, default: ""].append(chunk)
                        }
                    },
                    onExit: {
                        Task { @MainActor in
                            self.terminalOutput[sessionID, default: ""].append("\n[종료됨]\n")
                        }
                    },
                    onError: { message in
                        Task { @MainActor in
                            self.transientError = message
                        }
                    }
                )
            } catch {
                transientError = error.localizedDescription
            }
        }
    }

    func sendTerminal(sessionID: UUID, text: String) {
        terminals[sessionID]?.sendInput(text)
    }

    func resizeTerminal(sessionID: UUID, cols: Int, rows: Int) {
        terminals[sessionID]?.resize(cols, rows)
    }

    func closeTerminal(sessionID: UUID) {
        terminals[sessionID]?.close()
        terminals[sessionID] = nil
    }

    func browse(path: String?) async {
        guard let client else { return }
        do {
            let json = try await client.browse(path: path)
            let directories = json.objects("directories").compactMap { entry -> ProjectChoiceItem? in
                guard let path = entry.string("path"), let name = entry.string("name") else { return nil }
                return ProjectChoiceItem(path: path, label: name, source: "browse")
            }
            projects = directories
        } catch {
            transientError = error.localizedDescription
        }
    }

    private func markRead(sessionID: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].unreadCount = 0
    }

    private func apply(summary: ChatRoomStore.SessionSummary) {
        guard let index = sessions.firstIndex(where: { $0.id == summary.sessionID }) else { return }
        sessions[index].subtitle = summary.preview
        sessions[index].updatedAt = summary.updatedAt
        sessions[index].state = summary.state
        sessions = Self.sorted(sessions)
    }

    private static func sorted(_ sessions: [ChatSession]) -> [ChatSession] {
        sessions.sorted {
            if $0.isPinned != $1.isPinned { return $0.isPinned }
            return $0.updatedAt > $1.updatedAt
        }
    }
}
