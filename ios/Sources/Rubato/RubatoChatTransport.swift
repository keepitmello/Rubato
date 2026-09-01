import Foundation

actor RubatoChatTransport: ChatTransport {
    private let client: HubClient
    private let extras: RubatoSessionExtras
    private var states: [UUID: ConversationState] = [:]
    private var streams: [UUID: HubEventStream] = [:]
    private var pageCursors: [UUID: String] = [:]
    private var waiters: [UUID: [UUID: AsyncThrowingStream<ChatStreamEvent, Error>.Continuation]] = [:]
    private var terminals: [UUID: HubTerminal] = [:]
    private var terminalBuffers: [UUID: String] = [:]
    private var terminalBaseline: [UUID: Int] = [:]

    init(client: HubClient, extras: RubatoSessionExtras) {
        self.client = client
        self.extras = extras
    }

    func loadInitialMessages(sessionID: UUID, limit: Int) async throws -> [ChatMessage] {
        let liveId = sessionID.uuidString.lowercased()
        let json = try await client.snapshot(liveSessionId: liveId)
        let snapshot = ConversationReducer.parseSnapshot(json)
        let state = ConversationReducer.applySnapshot(snapshot, previous: states[sessionID])
        states[sessionID] = state
        pageCursors[sessionID] = snapshot.entries.first?.id
        await publishExtras(sessionID: sessionID, snapshot: snapshot, state: state, connection: "connecting")
        startStream(sessionID: sessionID, liveId: liveId)
        return Array(ConversationMapping.chatMessages(sessionID: sessionID, entries: state.entries).suffix(limit))
    }

    func loadPreviousMessages(sessionID: UUID, before: Date, limit: Int) async throws -> [ChatMessage] {
        let liveId = sessionID.uuidString.lowercased()
        let cursor = pageCursors[sessionID]
        do {
            let json = try await client.messages(liveSessionId: liveId, before: cursor, limit: limit)
            let entries = ConversationMapping.entries(from: json.array("entries"))
            pageCursors[sessionID] = json.string("nextBefore") ?? entries.first?.id
            if entries.isEmpty { pageCursors[sessionID] = nil }
            return ConversationMapping.chatMessages(sessionID: sessionID, entries: entries)
                .filter { $0.createdAt < before }
        } catch {
            if error.isMissingHubRoute { return [] }
            throw error
        }
    }

    func sendUserMessage(_ message: ChatMessage) async throws {
        if message.voiceClip != nil {
            throw HubClientError.http(status: 400, code: "invalid_action", message: "음성 메시지는 원격 허브에서 아직 보낼 수 없어요.")
        }
        if await extras.snapshot(for: message.sessionID).isTerminalOnly {
            try await sendViaTerminal(message)
            return
        }
        let liveId = message.sessionID.uuidString.lowercased()
        var imageIds: [String] = []
        for attachment in message.attachments {
            guard attachment.kind == .image else {
                throw HubClientError.http(status: 400, code: "invalid_action", message: "일반 파일은 원격으로 올리지 못해요. 이미지만 보낼 수 있어요.")
            }
            let data = try Data(contentsOf: attachment.localURL)
            let mime = mimeType(for: attachment.localURL)
            let imageId = try await client.uploadImage(
                liveSessionId: liveId,
                fileName: attachment.displayName,
                mimeType: mime,
                data: data
            )
            imageIds.append(imageId)
        }
        var payload: [String: Any] = ["text": message.text, "imageIds": imageIds]
        let action: String
        switch message.delivery {
        case .steer: action = "input.steer"
        case .followUp: action = "input.followUp"
        case .submit:
            action = "input.submit"
            payload["delivery"] = "auto"
        }
        let revision = await extras.snapshot(for: message.sessionID).revision
        try await client.action(
            liveSessionId: liveId,
            action: action,
            payload: JSONObject(payload),
            expectedRevision: revision == 0 ? nil : revision
        )
    }

    func streamAssistantResponse(
        sessionID: UUID,
        respondingTo message: ChatMessage
    ) async -> AsyncThrowingStream<ChatStreamEvent, Error> {
        if await extras.snapshot(for: sessionID).isTerminalOnly {
            return streamFromTerminal(sessionID: sessionID)
        }
        let liveId = sessionID.uuidString.lowercased()
        startStream(sessionID: sessionID, liveId: liveId)
        return AsyncThrowingStream { continuation in
            let token = UUID()
            waiters[sessionID, default: [:]][token] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeWaiter(sessionID, token) }
            }
        }
    }

    func cancelAssistantResponse(sessionID: UUID, messageID: UUID?) async {
        let liveId = sessionID.uuidString.lowercased()
        try? await client.action(liveSessionId: liveId, action: "agent.abort", payload: JSONObject())
    }

    func fire(sessionID: UUID, action: String, payload: JSONObject) async throws {
        let liveId = sessionID.uuidString.lowercased()
        let revision = await extras.snapshot(for: sessionID).revision
        try await client.action(
            liveSessionId: liveId,
            action: action,
            payload: payload,
            expectedRevision: revision == 0 ? nil : revision
        )
    }

    private func sendViaTerminal(_ message: ChatMessage) async throws {
        try await ensureTerminal(sessionID: message.sessionID)
        for _ in 0..<40 {
            if !(terminalBuffers[message.sessionID] ?? "").isEmpty { break }
            try await Task.sleep(for: .milliseconds(250))
        }
        terminalBaseline[message.sessionID] = terminalBuffers[message.sessionID, default: ""].count
        terminals[message.sessionID]?.sendInput(message.text + "\n")
    }

    private func ensureTerminal(sessionID: UUID) async throws {
        if terminals[sessionID] != nil { return }
        let sessionID = sessionID
        let terminal = try await connectTerminal(
            sessionID: sessionID,
            onOutput: { chunk in
                Task { await self.appendTerminal(sessionID, chunk) }
            },
            onExit: {},
            onError: { _ in }
        )
        terminals[sessionID] = terminal
        terminal.resize(80, 24)
    }

    private func appendTerminal(_ sessionID: UUID, _ chunk: String) {
        terminalBuffers[sessionID, default: ""].append(chunk)
    }

    private func streamFromTerminal(sessionID: UUID) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let assistantID = UUID()
        return AsyncThrowingStream { continuation in
            let task = Task {
                let started = ChatMessage(
                    id: assistantID,
                    sessionID: sessionID,
                    role: .assistant,
                    text: "",
                    responseState: .streaming
                )
                continuation.yield(.responseStarted(started))
                var last = ""
                var quiet = 0
                for _ in 0..<80 {
                    try? await Task.sleep(for: .milliseconds(250))
                    if Task.isCancelled { break }
                    let raw = await self.terminalSlice(sessionID)
                    let text = Self.readableTerminal(raw)
                    if text.count > last.count {
                        let delta = String(text.dropFirst(last.count))
                        last = text
                        quiet = 0
                        if !delta.isEmpty {
                            continuation.yield(.responseDelta(messageID: assistantID, text: delta))
                        }
                    } else {
                        quiet += 1
                        if quiet >= 16, !last.isEmpty { break }
                    }
                }
                continuation.yield(.responseCompleted(messageID: assistantID))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func terminalSlice(_ sessionID: UUID) -> String {
        let raw = terminalBuffers[sessionID, default: ""]
        let baseline = min(terminalBaseline[sessionID, default: 0], raw.count)
        return String(raw.dropFirst(baseline))
    }

    private static func readableTerminal(_ raw: String) -> String {
        let withoutCSI = raw.replacingOccurrences(
            of: "\u{001B}\\[[0-9;?]*[ -/]*[@-~]",
            with: "",
            options: .regularExpression
        )
        let withoutOSC = withoutCSI.replacingOccurrences(
            of: "\u{001B}\\][^\u{0007}]*\u{0007}",
            with: "",
            options: .regularExpression
        )
        let cleaned = withoutOSC
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "[ \t]+\n", with: "\n", options: .regularExpression)
        let letters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "- _"))
        let replies = cleaned.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { line in
                guard (2...80).contains(line.count) else { return false }
                if line.hasPrefix("•") { return false }
                if line.contains("Working") { return false }
                if line.contains("Settings") { return false }
                if line.contains("Reply with") { return false }
                if line.contains("/") { return false }
                return line.unicodeScalars.allSatisfy { letters.contains($0) }
            }
        return replies.last.map { String($0) } ?? ""
    }

    func gitView(sessionID: UUID) async throws -> GitView {
        do {
            return try await client.gitView(liveSessionId: sessionID.uuidString.lowercased())
        } catch {
            if error.isMissingHubRoute {
                return GitView(files: [], summary: "이 허브 빌드에는 git HTTP가 없어요. 상태와 차이를 불러올 수 없습니다.", diffText: "")
            }
            throw error
        }
    }

    func connectTerminal(
        sessionID: UUID,
        onOutput: @escaping @Sendable (String) -> Void,
        onExit: @escaping @Sendable () -> Void,
        onError: @escaping @Sendable (String) -> Void
    ) async throws -> HubTerminal {
        let liveId = sessionID.uuidString.lowercased()
        let ticket = try await client.terminalTicket(liveSessionId: liveId)
        let request = try await client.websocketRequest(ticket: ticket, terminal: true)
        let socket = URLSession.shared.webSocketTask(with: request)
        socket.resume()
        Task {
            while true {
                do {
                    let message = try await socket.receive()
                    guard case let .data(data) = message, data.count >= 5 else { continue }
                    let type = data[0]
                    let length = data.subdata(in: 1..<5).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
                    let payload = data.dropFirst(5).prefix(Int(length))
                    switch type {
                    case 0x01:
                        onOutput(String(decoding: payload, as: UTF8.self))
                    case 0x04:
                        onExit()
                        return
                    case 0x05:
                        onError(String(decoding: payload, as: UTF8.self))
                    default:
                        break
                    }
                } catch {
                    onError(error.localizedDescription)
                    return
                }
            }
        }
        return HubTerminal(
            sendInput: { text in
                socket.send(.data(Self.terminalFrame(0x02, Data(text.utf8)))) { _ in }
            },
            resize: { cols, rows in
                var payload = Data(count: 4)
                payload.replaceSubrange(0..<2, with: withUnsafeBytes(of: UInt16(cols).bigEndian) { Data($0) })
                payload.replaceSubrange(2..<4, with: withUnsafeBytes(of: UInt16(rows).bigEndian) { Data($0) })
                socket.send(.data(Self.terminalFrame(0x03, payload))) { _ in }
            },
            close: {
                socket.cancel(with: .goingAway, reason: nil)
            }
        )
    }

    private func startStream(sessionID: UUID, liveId: String) {
        guard streams[sessionID] == nil else { return }
        let stream = HubEventStream(
            client: client,
            sessionID: liveId,
            lastSeq: { [weak self] in
                await self?.states[sessionID]?.lastSeq ?? 0
            },
            onEvent: { [weak self] event in
                Task { await self?.handle(event, sessionID: sessionID) }
            },
            onSnapshotRequired: { [weak self] in
                Task { try? await self?.reloadSnapshot(sessionID: sessionID, liveId: liveId) }
            },
            onState: { [weak self] connection in
                Task { await self?.extras.update(sessionID) { $0.connection = connection } }
            }
        )
        streams[sessionID] = stream
        stream.start()
    }

    private func handle(_ event: HubEvent, sessionID: UUID) async {
        let current = states[sessionID] ?? ConversationState()
        let (next, streamEvent) = ConversationReducer.reduce(current, event: event)
        states[sessionID] = next
        if next.requiresSnapshot {
            try? await reloadSnapshot(sessionID: sessionID, liveId: sessionID.uuidString.lowercased())
            return
        }
        await extras.update(sessionID) { snapshot in
            snapshot.lastSeq = next.lastSeq
            snapshot.execution = next.execution
            snapshot.uiRequest = next.uiRequest
            snapshot.tools = ConversationMapping.tools(from: next.entries)
            snapshot.images = ConversationMapping.images(from: next.entries)
        }
        if let streamEvent {
            if let current = waiters[sessionID] {
                for waiter in current.values {
                    waiter.yield(streamEvent)
                }
            }
            if case .responseCompleted = streamEvent {
                let phase = event.payload.string("phase")
                if phase == "final" {
                    finishWaiters(sessionID)
                }
            }
        }
    }

    private func reloadSnapshot(sessionID: UUID, liveId: String) async throws {
        let json = try await client.snapshot(liveSessionId: liveId)
        let snapshot = ConversationReducer.parseSnapshot(json)
        let state = ConversationReducer.applySnapshot(snapshot, previous: nil)
        states[sessionID] = state
        await publishExtras(sessionID: sessionID, snapshot: snapshot, state: state, connection: "online")
    }

    private func publishExtras(
        sessionID: UUID,
        snapshot: SessionSnapshot,
        state: ConversationState,
        connection: String
    ) async {
        await extras.update(sessionID) {
            $0.lastSeq = state.lastSeq
            $0.revision = snapshot.revision
            $0.execution = state.execution
            $0.cwd = snapshot.cwd
            $0.modelLabel = snapshot.modelLabel
            $0.thinkingLevel = snapshot.thinkingLevel
            $0.tools = snapshot.tools
            $0.images = snapshot.images
            $0.uiRequest = state.uiRequest
            $0.tree = snapshot.tree
            $0.commands = snapshot.commands
            $0.backgroundLabels = snapshot.backgroundLabels
            $0.connection = connection
            $0.capabilities = snapshot.capabilities
        }
    }

    private func removeWaiter(_ sessionID: UUID, _ token: UUID) {
        waiters[sessionID]?[token] = nil
    }

    private func finishWaiters(_ sessionID: UUID) {
        if let current = waiters[sessionID] {
            for waiter in current.values {
                waiter.finish()
            }
        }
        waiters[sessionID] = [:]
    }

    private func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "webp": "image/webp"
        case "gif": "image/gif"
        default: "image/jpeg"
        }
    }

    private static func terminalFrame(_ type: UInt8, _ payload: Data) -> Data {
        var frame = Data([type])
        var length = UInt32(payload.count).bigEndian
        frame.append(Data(bytes: &length, count: 4))
        frame.append(payload)
        return frame
    }
}

struct HubTerminal: Sendable {
    let sendInput: @Sendable (String) -> Void
    let resize: @Sendable (Int, Int) -> Void
    let close: @Sendable () -> Void
}
