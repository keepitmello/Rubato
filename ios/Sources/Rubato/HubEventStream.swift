import Foundation

final class HubEventStream: @unchecked Sendable {
    private let client: HubClient
    private let sessionID: String
    private let lastSeq: @Sendable () async -> Int
    private let onEvent: @Sendable (HubEvent) -> Void
    private let onSnapshotRequired: @Sendable () -> Void
    private let onState: @Sendable (String) -> Void

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var stopped = false
    private var attempt = 0

    init(
        client: HubClient,
        sessionID: String,
        lastSeq: @escaping @Sendable () async -> Int,
        onEvent: @escaping @Sendable (HubEvent) -> Void,
        onSnapshotRequired: @escaping @Sendable () -> Void,
        onState: @escaping @Sendable (String) -> Void
    ) {
        self.client = client
        self.sessionID = sessionID
        self.lastSeq = lastSeq
        self.onEvent = onEvent
        self.onSnapshotRequired = onSnapshotRequired
        self.onState = onState
    }

    func start() {
        stopped = false
        Task { await connect() }
    }

    func stop() {
        stopped = true
        receiveTask?.cancel()
        reconnectTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func connect() async {
        guard !stopped else { return }
        onState("connecting")
        do {
            let ticket = try await client.eventTicket()
            let request = try await client.websocketRequest(ticket: ticket, terminal: false)
            let task = URLSession.shared.webSocketTask(with: request)
            socket = task
            task.resume()
            let seq = await lastSeq()
            let resume: [String: Any] = [
                "type": "client.resume",
                "sessions": [
                    ["liveSessionId": sessionID, "lastSeq": seq],
                ],
            ]
            let payload = try JSONSerialization.data(withJSONObject: resume)
            guard let text = String(data: payload, encoding: .utf8) else { throw HubClientError.invalidJSON }
            try await task.send(.string(text))
            attempt = 0
            onState("online")
            receiveTask?.cancel()
            receiveTask = Task { await self.receive(task) }
        } catch {
            scheduleReconnect()
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) async {
        while !stopped {
            do {
                let message = try await task.receive()
                let text: String
                switch message {
                case let .string(value):
                    text = value
                case let .data(data):
                    guard let value = String(data: data, encoding: .utf8) else { continue }
                    text = value
                @unknown default:
                    continue
                }
                guard let data = text.data(using: .utf8) else { continue }
                let json = try JSONObject.parseObject(data)
                if json.string("type") == "snapshot.required" {
                    onSnapshotRequired()
                    continue
                }
                if let event = ConversationReducer.parseEvent(json) {
                    onEvent(event)
                }
            } catch {
                if !stopped { scheduleReconnect() }
                return
            }
        }
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        onState("connecting")
        let delay = min(30.0, 0.5 * pow(2.0, Double(attempt)))
        attempt += 1
        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(for: .seconds(delay))
            guard !stopped else { return }
            await connect()
        }
    }
}
