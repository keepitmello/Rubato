import Foundation

struct ConversationState: Sendable {
    var entries: [ConversationEntry] = []
    var lastSeq: Int = 0
    var uiRequest: RemoteUiRequest?
    var execution: String = "idle"
    var requiresSnapshot = false
}

enum ConversationReducer {
    static func applySnapshot(_ snapshot: SessionSnapshot, previous: ConversationState?) -> ConversationState {
        if let previous, previous.lastSeq > snapshot.lastSeq, previous.requiresSnapshot == false {
            return previous
        }
        return ConversationState(
            entries: snapshot.entries,
            lastSeq: snapshot.lastSeq,
            uiRequest: snapshot.uiRequest,
            execution: snapshot.execution,
            requiresSnapshot: false
        )
    }

    static func reduce(_ state: ConversationState, event: HubEvent) -> (ConversationState, ChatStreamEvent?) {
        if event.seq <= state.lastSeq {
            return (state, nil)
        }
        if event.seq != state.lastSeq + 1 && state.lastSeq != 0 {
            var next = state
            next.requiresSnapshot = true
            return (next, nil)
        }

        var next = state
        next.lastSeq = event.seq
        let payload = event.payload
        let nested = payload.object("event")?.object("message")
        let hidden = nested?.bool("display") == false || nested?.string("role") == "custom"
        let id = payload.string("ephemeralMessageId")
            ?? payload.string("messageId")
            ?? nested.flatMap { message in
                if let timestamp = message.int("timestamp") { return "pi-message-\(timestamp)" }
                if let timestamp = message.double("timestamp") { return "pi-message-\(Int(timestamp))" }
                return nil
            }
            ?? event.messageId
            ?? "event-\(event.seq)"

        switch event.type {
        case "message.start":
            guard !hidden else { return (next, nil) }
            let role = nested?.string("role") ?? payload.string("role") ?? "assistant"
            let startedText = nested.flatMap(Self.messageContent) ?? payload.string("text") ?? ""
            upsertMessage(&next.entries, id: id, role: role, text: startedText, streaming: true, at: ISO8601Dates.parse(event.at))
            if role != "user" {
                let message = chatMessage(id: id, sessionID: RemoteID.uuid(from: event.liveSessionId), role: .assistant, text: startedText)
                return (next, .responseStarted(message))
            }
            return (next, nil)

        case "message.delta":
            guard !hidden else { return (next, nil) }
            let nestedText = nested.map(Self.messageContent)
            let incremental = payload.string("delta") ?? ""
            let index = next.entries.firstIndex { $0.id == id && $0.kind == .message }
            let previousText = index.map { next.entries[$0].text } ?? ""
            let nextText: String
            let delta: String
            if let nestedText {
                nextText = nestedText
                delta = nestedText.hasPrefix(previousText) ? String(nestedText.dropFirst(previousText.count)) : nestedText
            } else {
                delta = incremental
                nextText = previousText + incremental
            }
            upsertMessage(&next.entries, id: id, role: "assistant", text: nextText, streaming: true, at: ISO8601Dates.parse(event.at))
            if !delta.isEmpty {
                return (next, .responseDelta(messageID: RemoteID.uuid(from: id), text: delta))
            }
            return (next, nil)

        case "message.commit":
            guard !hidden else { return (next, nil) }
            let committed = nested.map(Self.messageContent) ?? payload.string("text")
            let role = nested?.string("role") ?? payload.string("role") ?? "assistant"
            upsertMessage(&next.entries, id: id, role: role, text: committed ?? "", streaming: false, at: ISO8601Dates.parse(event.at))
            if role != "user" {
                return (next, .responseCompleted(messageID: RemoteID.uuid(from: id)))
            }
            return (next, nil)

        case "tool.start":
            next.entries.append(
                ConversationEntry(
                    id: id,
                    kind: .tool,
                    role: nil,
                    text: payload.string("summary") ?? "실행 중",
                    streaming: true,
                    at: ISO8601Dates.parse(event.at),
                    name: payload.string("name") ?? "도구",
                    summary: payload.string("summary") ?? "실행 중",
                    status: "running",
                    requestRunId: payload.string("requestRunId")
                )
            )
            return (next, nil)

        case "tool.update", "tool.end":
            if let index = next.entries.firstIndex(where: { $0.id == id && $0.kind == .tool }) {
                next.entries[index].summary = payload.string("summary") ?? next.entries[index].summary
                next.entries[index].output = payload.string("output") ?? next.entries[index].output
                next.entries[index].artifactId = payload.string("artifactId") ?? next.entries[index].artifactId
                next.entries[index].status = event.type == "tool.end"
                    ? (payload.bool("failed") == true ? "failed" : "done")
                    : next.entries[index].status
                next.entries[index].streaming = event.type != "tool.end"
            }
            return (next, nil)

        case "ui.request":
            next.uiRequest = ConversationMapping.uiRequest(from: payload)
            return (next, nil)

        case "ui.dismiss":
            next.uiRequest = nil
            return (next, nil)

        case "agent.state":
            next.execution = payload.string("execution") ?? next.execution
            return (next, nil)

        case "compaction.start":
            next.entries.append(
                ConversationEntry(id: id, kind: .notice, role: nil, text: "대화를 정리하고 있어요.", streaming: false)
            )
            return (next, nil)

        case "compaction.end":
            next.entries.append(
                ConversationEntry(id: id, kind: .notice, role: nil, text: "대화 정리가 끝났어요.", streaming: false)
            )
            return (next, nil)

        case "snapshot.required":
            next.requiresSnapshot = true
            return (next, nil)

        default:
            return (next, nil)
        }
    }

    static func parseEvent(_ json: JSONObject) -> HubEvent? {
        let type = json.string("type") ?? ""
        let payload = json.object("payload") ?? JSONObject()
        return HubEvent(
            type: type,
            liveSessionId: json.string("liveSessionId") ?? "",
            seq: json.int("seq") ?? 0,
            at: json.string("at") ?? "",
            payload: payload,
            messageId: payload.string("ephemeralMessageId") ?? payload.string("messageId")
        )
    }

    static func parseSnapshot(_ json: JSONObject) -> SessionSnapshot {
        let summary = json.object("summary") ?? json
        let nested = json.object("state") ?? json.object("snapshot")?.object("state")
        let rawEntries = json.array("entries")
        let entries = ConversationMapping.entries(
            from: rawEntries.isEmpty ? (nested?.array("entries") ?? json.object("snapshot")?.array("entries") ?? []) : rawEntries
        )
        let liveSessionId = json.string("liveSessionId") ?? summary.string("liveSessionId") ?? ""
        return SessionSnapshot(
            liveSessionId: liveSessionId,
            hostId: summary.string("hostId") ?? "",
            revision: json.int("revision") ?? 0,
            lastSeq: json.int("lastSeq") ?? 0,
            title: summary.string("title") ?? ConversationMapping.shortPath(summary.string("cwd") ?? liveSessionId),
            cwd: summary.string("cwd") ?? "",
            execution: summary.string("execution") ?? "idle",
            lifecycle: summary.string("lifecycle") ?? "ready",
            modelLabel: summary.object("model")?.string("label") ?? "",
            thinkingLevel: summary.object("model")?.string("thinkingLevel"),
            backgroundLabels: summary.object("background")?.strings("labels") ?? [],
            entries: entries,
            tree: json.objects("tree").compactMap { entry in
                guard let id = entry.string("id") else { return nil }
                return RemoteTreeEntry(id: id, label: entry.string("label") ?? id, current: entry.bool("current") ?? false)
            },
            commands: json.objects("commands").compactMap { command in
                guard let name = command.string("name") else { return nil }
                return RemoteCommand(
                    name: name,
                    description: command.string("description") ?? "",
                    category: command.string("category") ?? "builtin",
                    remoteMode: command.string("remoteMode") ?? "direct"
                )
            },
            uiRequest: ConversationMapping.uiRequest(from: json.object("uiRequest")),
            tools: ConversationMapping.tools(from: entries),
            images: ConversationMapping.images(from: entries),
            capabilities: summary.strings("capabilities")
        )
    }

    private static func messageContent(_ message: JSONObject) -> String {
        if let text = message.string("content") { return text }
        let parts = message.array("content")
        return parts.compactMap { JSONObject(value: $0) }
            .filter { $0.string("type") == "text" }
            .compactMap { $0.string("text") }
            .joined(separator: "\n")
    }

    private static func upsertMessage(
        _ entries: inout [ConversationEntry],
        id: String,
        role: String,
        text: String,
        streaming: Bool,
        at: Date
    ) {
        if let index = entries.firstIndex(where: { $0.id == id && $0.kind == .message }) {
            if !text.isEmpty { entries[index].text = text }
            entries[index].streaming = streaming
            entries[index].role = role
        } else {
            entries.append(
                ConversationEntry(
                    id: id,
                    kind: .message,
                    role: role,
                    text: text,
                    streaming: streaming,
                    at: at
                )
            )
        }
    }

    private static func chatMessage(id: String, sessionID: UUID, role: ChatRole, text: String) -> ChatMessage {
        ChatMessage(
            id: RemoteID.uuid(from: id),
            sessionID: sessionID,
            role: role,
            text: text,
            deliveryState: .sent,
            responseState: role == .assistant ? .streaming : .none
        )
    }
}
