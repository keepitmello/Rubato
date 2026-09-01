import Foundation
#if canImport(Combine)
import Combine
#endif

@MainActor
final class ChatRoomStore: ObservableObject {
    struct SessionSummary: Sendable {
        var sessionID: UUID
        var preview: String
        var updatedAt: Date
        var state: ChatSessionState
    }

    let sessionID: UUID
    let title: String
    let audioRecorder = AudioRecordingController()
    let audioPlayer = AudioPlaybackCenter()

    @Published private(set) var messages: [ChatMessage] = []
    @Published var draftText: String = ""
    @Published private(set) var draftAttachments: [ChatAttachment] = []
    @Published private(set) var draftVoiceClip: VoiceClip?
    @Published private(set) var replyingTo: ReplyReference?
    @Published private(set) var isLoadingInitial = false
    @Published private(set) var isLoadingPrevious = false
    @Published private(set) var canLoadPrevious = true
    @Published private(set) var isResponseActive = false
    @Published private(set) var activeResponseMessageID: UUID?
    @Published private(set) var extendedLayoutAnchorMessageID: UUID?
    @Published var transientError: String?

    private let transport: any ChatTransport
    private let attachmentFileStore = AttachmentFileStore()
    private let summaryHandler: @MainActor (SessionSummary) -> Void
    private var responseTask: Task<Void, Never>?
    private var deltaFlushTask: Task<Void, Never>?
    private var pendingDeltas: [UUID: String] = [:]
    private var didLoadInitialMessages = false

    init(
        session: ChatSession,
        transport: any ChatTransport,
        summaryHandler: @escaping @MainActor (SessionSummary) -> Void
    ) {
        sessionID = session.id
        title = session.title
        self.transport = transport
        self.summaryHandler = summaryHandler
    }

    deinit {
        responseTask?.cancel()
        deltaFlushTask?.cancel()
    }

    func loadInitialIfNeeded() async {
        guard !didLoadInitialMessages, !isLoadingInitial else { return }
        isLoadingInitial = true
        defer { isLoadingInitial = false }

        do {
            messages = try await transport.loadInitialMessages(sessionID: sessionID, limit: 60)
                .sorted { $0.createdAt < $1.createdAt }
            didLoadInitialMessages = true
            canLoadPrevious = true
        } catch {
            transientError = error.localizedDescription
        }
    }

    func listenForLiveUpdates() {
        guard responseTask == nil else { return }
        responseTask = Task { [weak self] in
            guard let self else { return }
            let stream = await transport.streamAssistantResponse(
                sessionID: sessionID,
                respondingTo: ChatMessage(sessionID: sessionID, role: .user, text: "")
            )
            do {
                for try await event in stream {
                    guard !Task.isCancelled else { return }
                    consume(event)
                }
            } catch {
                guard !Task.isCancelled else { return }
                if isResponseActive {
                    markResponseFailed(error.localizedDescription)
                }
            }
        }
    }

    func loadPrevious() async {
        guard didLoadInitialMessages, canLoadPrevious, !isLoadingPrevious else { return }
        guard let firstDate = messages.first?.createdAt else {
            canLoadPrevious = false
            return
        }

        isLoadingPrevious = true
        defer { isLoadingPrevious = false }

        do {
            let previous = try await transport.loadPreviousMessages(
                sessionID: sessionID,
                before: firstDate,
                limit: 30
            )
            let knownIDs = Set(messages.map(\.id))
            let uniquePrevious = previous.filter { !knownIDs.contains($0.id) }
            if uniquePrevious.isEmpty {
                canLoadPrevious = false
            } else {
                messages.insert(contentsOf: uniquePrevious.sorted { $0.createdAt < $1.createdAt }, at: 0)
            }
        } catch {
            transientError = error.localizedDescription
        }
    }

    func sendCurrentDraft(delivery: UserInputDelivery = .submit) {
        let draft = MessageDraft(
            text: draftText,
            attachments: draftAttachments,
            voiceClip: draftVoiceClip,
            replyTo: replyingTo
        )
        let steering = isResponseActive && (delivery == .steer || delivery == .followUp)
        guard !draft.isEmpty, !isResponseActive || steering else { return }

        draftText = ""
        draftAttachments = []
        draftVoiceClip = nil
        replyingTo = nil
        audioPlayer.stop()
        audioRecorder.reset()
        send(draft, delivery: delivery, startResponse: !steering)
    }

    func finishRecording(sendImmediately: Bool) {
        Task { [weak self] in
            guard let self, let clip = await audioRecorder.finish() else { return }
            if sendImmediately {
                send(MessageDraft(voiceClip: clip, replyTo: replyingTo))
                replyingTo = nil
                _ = audioRecorder.consumePreparedClip()
            } else {
                draftVoiceClip = clip
            }
        }
    }

    func cancelRecording() {
        audioPlayer.stop()
        audioRecorder.cancel()
        if let clip = draftVoiceClip {
            try? FileManager.default.removeItem(at: clip.localURL)
        }
        draftVoiceClip = nil
    }

    func addPhotoData(_ data: Data, suggestedExtension: String = "jpg") {
        do {
            draftAttachments.append(
                try attachmentFileStore.savePhotoData(data, suggestedExtension: suggestedExtension)
            )
        } catch {
            transientError = "사진을 첨부하지 못했어요: \(error.localizedDescription)"
        }
    }

    func addFiles(_ urls: [URL]) {
        do {
            draftAttachments.append(contentsOf: try attachmentFileStore.importFiles(urls))
        } catch {
            transientError = "파일을 첨부하지 못했어요: \(error.localizedDescription)"
        }
    }

    func removeDraftAttachment(id: UUID) {
        guard let attachment = draftAttachments.first(where: { $0.id == id }) else { return }
        draftAttachments.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: attachment.localURL)
    }

    func removeDraftVoiceClip() {
        audioPlayer.stop()
        if let draftVoiceClip {
            try? FileManager.default.removeItem(at: draftVoiceClip.localURL)
        }
        self.draftVoiceClip = nil
        audioRecorder.reset()
    }

    func setReply(to message: ChatMessage) {
        replyingTo = message.replyReference
    }

    func clearReply() {
        replyingTo = nil
    }

    func toggleReaction(messageID: UUID, emoji: String) {
        mutateMessage(id: messageID) { message in
            if let index = message.reactions.firstIndex(where: { $0.emoji == emoji }) {
                let selected = message.reactions[index].isSelectedByCurrentUser
                message.reactions[index].isSelectedByCurrentUser.toggle()
                message.reactions[index].count += selected ? -1 : 1
                if message.reactions[index].count <= 0 {
                    message.reactions.remove(at: index)
                }
            } else {
                message.reactions.append(
                    MessageReaction(emoji: emoji, count: 1, isSelectedByCurrentUser: true)
                )
            }
        }
    }

    func cancelActiveResponse() {
        guard isResponseActive else { return }
        responseTask?.cancel()
        responseTask = nil
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        flushPendingDeltas()

        let cancelledResponseMessageID = activeResponseMessageID
        if let cancelledResponseMessageID {
            mutateMessage(id: cancelledResponseMessageID) { message in
                message.responseState = .cancelled
            }
        } else {
            messages.append(
                ChatMessage(
                    sessionID: sessionID,
                    role: .assistant,
                    text: "",
                    responseState: .cancelled
                )
            )
        }

        Task { [transport, sessionID, cancelledResponseMessageID] in
            await transport.cancelAssistantResponse(
                sessionID: sessionID,
                messageID: cancelledResponseMessageID
            )
        }

        isResponseActive = false
        activeResponseMessageID = nil
        extendedLayoutAnchorMessageID = nil
        publishSummary(state: .waitingForUser)
    }

    func retryResponse(messageID: UUID) {
        guard let assistantIndex = messages.firstIndex(where: { $0.id == messageID }) else { return }
        guard let userMessage = messages[..<assistantIndex].last(where: { $0.role == .user }) else { return }
        messages.remove(at: assistantIndex)
        beginAssistantResponse(to: userMessage)
    }

    func retrySending(messageID: UUID) {
        guard let message = messages.first(where: { $0.id == messageID && $0.role == .user }) else { return }
        mutateMessage(id: messageID) { $0.deliveryState = .sending }
        publishSummary(preview: message.previewText, state: .running)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await transport.sendUserMessage(message)
                mutateMessage(id: messageID) { $0.deliveryState = .sent }
                beginAssistantResponse(to: message)
            } catch {
                mutateMessage(id: messageID) { $0.deliveryState = .failed(error.localizedDescription) }
                publishSummary(state: .failed)
            }
        }
    }

    func message(withID id: UUID) -> ChatMessage? {
        messages.first { $0.id == id }
    }

    func groupPosition(for messageID: UUID) -> MessageGroupPosition {
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else { return .single }
        let current = messages[index]
        let previousMatches = index > 0 && messages[index - 1].role == current.role
            && current.createdAt.timeIntervalSince(messages[index - 1].createdAt) < 300
        let nextMatches = index < messages.count - 1 && messages[index + 1].role == current.role
            && messages[index + 1].createdAt.timeIntervalSince(current.createdAt) < 300

        switch (previousMatches, nextMatches) {
        case (false, false): return .single
        case (false, true): return .first
        case (true, true): return .middle
        case (true, false): return .last
        }
    }

    func shouldShowDate(before messageID: UUID) -> Bool {
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else { return false }
        guard index > 0 else { return true }
        return !Calendar.current.isDate(messages[index - 1].createdAt, inSameDayAs: messages[index].createdAt)
    }

    private func send(_ draft: MessageDraft, delivery: UserInputDelivery = .submit, startResponse: Bool = true) {
        let userMessage = ChatMessage(
            sessionID: sessionID,
            role: .user,
            text: draft.text.trimmingCharacters(in: .whitespacesAndNewlines),
            attachments: draft.attachments,
            voiceClip: draft.voiceClip,
            replyTo: draft.replyTo,
            deliveryState: .sending,
            delivery: delivery
        )
        messages.append(userMessage)
        publishSummary(preview: userMessage.previewText, state: .running)

        Task { [weak self] in
            guard let self else { return }
            do {
                try await transport.sendUserMessage(userMessage)
                mutateMessage(id: userMessage.id) { $0.deliveryState = .sent }
                if startResponse {
                    if responseTask == nil {
                        beginAssistantResponse(to: userMessage)
                    } else {
                        isResponseActive = true
                        activeResponseMessageID = nil
                        extendedLayoutAnchorMessageID = userMessage.id
                        publishSummary(state: .running)
                    }
                }
            } catch {
                mutateMessage(id: userMessage.id) {
                    $0.deliveryState = .failed(error.localizedDescription)
                }
                publishSummary(state: .failed)
            }
        }
    }

    private func beginAssistantResponse(to userMessage: ChatMessage) {
        responseTask?.cancel()
        isResponseActive = true
        activeResponseMessageID = nil
        extendedLayoutAnchorMessageID = userMessage.id
        publishSummary(state: .running)

        responseTask = Task { [weak self] in
            guard let self else { return }
            let stream = await transport.streamAssistantResponse(
                sessionID: sessionID,
                respondingTo: userMessage
            )

            do {
                for try await event in stream {
                    guard !Task.isCancelled else { return }
                    consume(event)
                }
                guard !Task.isCancelled else { return }
                if isResponseActive {
                    markResponseFailed("응답 연결이 완료 신호 없이 종료됐어요.")
                }
            } catch {
                guard !Task.isCancelled else { return }
                markResponseFailed(error.localizedDescription)
            }
        }
    }

    private func consume(_ event: ChatStreamEvent) {
        switch event {
        case var .responseStarted(message):
            message.responseState = .streaming
            isResponseActive = true
            activeResponseMessageID = message.id
            if let existingIndex = messages.firstIndex(where: { $0.id == message.id }) {
                var updated = messages
                updated[existingIndex] = message
                messages = updated
            } else {
                messages.append(message)
            }

        case let .responseDelta(messageID, text):
            pendingDeltas[messageID, default: ""].append(text)
            scheduleDeltaFlush()

        case let .responseCompleted(messageID):
            deltaFlushTask?.cancel()
            deltaFlushTask = nil
            flushPendingDeltas()
            mutateMessage(id: messageID) { $0.responseState = .completed }
            isResponseActive = false
            activeResponseMessageID = nil
            extendedLayoutAnchorMessageID = nil
            publishSummary(preview: message(withID: messageID)?.previewText, state: .idle)
        }
    }

    private func scheduleDeltaFlush() {
        guard deltaFlushTask == nil else { return }
        deltaFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(40))
            guard !Task.isCancelled, let self else { return }
            flushPendingDeltas()
            deltaFlushTask = nil
        }
    }

    private func flushPendingDeltas() {
        guard !pendingDeltas.isEmpty else { return }
        let deltas = pendingDeltas
        pendingDeltas.removeAll(keepingCapacity: true)

        var updated = messages
        for (messageID, delta) in deltas {
            guard let index = updated.firstIndex(where: { $0.id == messageID }) else { continue }
            updated[index].text.append(delta)
            updated[index].responseState = .streaming
        }
        messages = updated
    }

    private func markResponseFailed(_ description: String) {
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        flushPendingDeltas()

        if let activeResponseMessageID {
            mutateMessage(id: activeResponseMessageID) {
                $0.responseState = .failed(description)
            }
        } else {
            let failure = ChatMessage(
                sessionID: sessionID,
                role: .assistant,
                text: "",
                responseState: .failed(description)
            )
            messages.append(failure)
        }
        isResponseActive = false
        activeResponseMessageID = nil
        extendedLayoutAnchorMessageID = nil
        responseTask = nil
        publishSummary(state: .failed)
    }

    private func mutateMessage(id: UUID, mutation: (inout ChatMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        var updated = messages
        mutation(&updated[index])
        messages = updated
    }

    private func publishSummary(preview: String? = nil, state: ChatSessionState) {
        let fallback = messages.last?.previewText ?? "새 대화를 시작해 보세요."
        summaryHandler(
            SessionSummary(
                sessionID: sessionID,
                preview: preview ?? fallback,
                updatedAt: .now,
                state: state
            )
        )
    }
}
