// The input layout and recording gesture are adapted from Exyte/Chat's InputView.
// See ThirdPartyNotices/ExyteChat-LICENSE.txt.

import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct MessageComposerView: View {
    @ObservedObject var store: ChatRoomStore
    var onActiveDelivery: ((String, String) -> Void)? = nil
    @ObservedObject private var recorder: AudioRecordingController
    @ObservedObject private var playback: AudioPlaybackCenter

    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showsFileImporter = false
    @State private var dragStartedAt: Date?
    @State private var holdTask: Task<Void, Never>?
    @State private var gestureResolved = false
    @State private var delivery = "input.followUp"

    init(store: ChatRoomStore, onActiveDelivery: ((String, String) -> Void)? = nil) {
        self.store = store
        self.onActiveDelivery = onActiveDelivery
        _recorder = ObservedObject(wrappedValue: store.audioRecorder)
        _playback = ObservedObject(wrappedValue: store.audioPlayer)
    }

    private var canSend: Bool {
        !store.draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !store.draftAttachments.isEmpty
            || store.draftVoiceClip != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            if store.isResponseActive {
                deliveryToggle
            }

            if !store.draftAttachments.isEmpty {
                DraftAttachmentStrip(
                    attachments: store.draftAttachments,
                    onRemove: store.removeDraftAttachment
                )
            }

            if let reply = store.replyingTo {
                replyBar(reply)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            HStack(alignment: .bottom, spacing: 10) {
                HStack(alignment: .bottom, spacing: 0) {
                    leadingInputContent
                    middleContent
                    trailingInputContent
                }
                .frame(minHeight: ExyteMetrics.inputMinimumHeight)
                .rubatoGlass(
                    in: RoundedRectangle(cornerRadius: ExyteMetrics.inputCornerRadius),
                    interactive: true
                )

                outsideButton
                    .frame(width: 48, height: 48)
            }
            .padding(.horizontal, ExyteMetrics.horizontalScreenEdgePadding)
            .padding(.vertical, 8)
        }
        .background(.clear)
        .animation(.easeInOut(duration: 0.2), value: store.replyingTo)
        .fileImporter(
            isPresented: $showsFileImporter,
            allowedContentTypes: [.item, .data, .pdf, .plainText, .image, .zip],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                store.addFiles(urls)
            case let .failure(error):
                store.transientError = "파일을 선택하지 못했어요: \(error.localizedDescription)"
            }
        }
        .onChange(of: recorder.state) { _, state in
            if case let .failed(reason) = state {
                store.transientError = reason
            }
        }
        .onChange(of: selectedPhotos) { _, newItems in
            guard !newItems.isEmpty else { return }
            Task {
                for item in newItems {
                    do {
                        guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                        let fileExtension = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                        store.addPhotoData(data, suggestedExtension: fileExtension)
                    } catch {
                        store.transientError = "사진을 불러오지 못했어요: \(error.localizedDescription)"
                    }
                }
                selectedPhotos = []
            }
        }
        .onDisappear {
            holdTask?.cancel()
            holdTask = nil
            if recorder.state.isRecording || recorder.state == .requestingPermission {
                store.cancelRecording()
            }
        }
    }

    @ViewBuilder
    private var leadingInputContent: some View {
        if recorder.state.isRecording || recorder.state == .requestingPermission {
            Button(role: .destructive) {
                store.cancelRecording()
                Haptics.impact(.medium)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 42, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("녹음 취소")
        } else if store.draftVoiceClip != nil {
            Button(role: .destructive) {
                store.removeDraftVoiceClip()
                Haptics.impact()
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 42, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("음성 첨부 삭제")
        } else {
            attachmentMenu
        }
    }

    @ViewBuilder
    private var middleContent: some View {
        switch recorder.state {
        case .recordingHold:
            HStack {
                Spacer()
                Label("왼쪽으로 밀어 취소", systemImage: "chevron.left")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(minHeight: 48)

        case .recordingLocked, .requestingPermission:
            HStack(spacing: 8) {
                Circle()
                    .fill(.red)
                    .frame(width: 7, height: 7)
                Text(recorder.state == .requestingPermission ? "마이크 권한 확인 중" : "녹음 중")
                    .font(.footnote)
                Spacer()
            }
            .padding(.leading, 12)
            .frame(minHeight: 48)

        case .ready:
            if let clip = store.draftVoiceClip {
                DraftVoicePreview(clip: clip, playback: playback)
                    .padding(.horizontal, 8)
            } else {
                textInput
            }

        case .idle, .failed:
            if let clip = store.draftVoiceClip {
                DraftVoicePreview(clip: clip, playback: playback)
                    .padding(.horizontal, 8)
            } else {
                textInput
            }
        }
    }

    private var textInput: some View {
        TextField("메시지", text: $store.draftText, axis: .vertical)
            .lineLimit(1...6)
            .font(.body)
            .padding(.vertical, 12)
            .padding(.leading, 4)
            .submitLabel(.send)
            .onSubmit {
                submitDraft()
            }
            .accessibilityLabel("메시지 입력")
    }

    @ViewBuilder
    private var trailingInputContent: some View {
        if recorder.state.isRecording || recorder.state == .requestingPermission {
            HStack(spacing: 5) {
                Circle().fill(.red).frame(width: 6, height: 6)
                Text(DisplayFormatter.duration(recorder.duration))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.trailing, 12)
        } else if !store.draftText.isEmpty {
            Button {
                store.draftText = ""
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
                    .frame(width: 40, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("입력한 글 지우기")
        }
    }

    @ViewBuilder
    private var outsideButton: some View {
        if store.isResponseActive, canSend {
            Button {
                submitDraft()
                Haptics.impact()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Color.accentColor, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(delivery == "input.steer" ? "즉시 반영할 지시 보내기" : "다음 차례에 보내기")

        } else if store.isResponseActive {
            Button {
                store.cancelActiveResponse()
                Haptics.impact(.medium)
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .rubatoGlass(in: Circle(), interactive: true)
            .accessibilityLabel("응답 중단")

        } else if recorder.state == .recordingLocked {
            Button {
                store.finishRecording(sendImmediately: false)
                Haptics.impact()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .rubatoGlass(in: Circle(), interactive: true)
            .accessibilityLabel("녹음 마치기")

        } else if canSend {
            Button {
                store.sendCurrentDraft()
                Haptics.impact()
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Color.accentColor, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("메시지 보내기")

        } else {
            Image(systemName: "mic.fill")
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 48, height: 48)
                .rubatoGlass(in: Circle(), interactive: true)
                .contentShape(Circle())
                .gesture(recordingGesture)
                .accessibilityLabel("음성 녹음")
                .accessibilityHint("짧게 누르면 잠금 녹음, 길게 누르면 누르는 동안 녹음해요")
        }
    }

    private var attachmentMenu: some View {
        Menu {
            PhotosPicker(selection: $selectedPhotos, maxSelectionCount: 6, matching: .images) {
                Label("사진", systemImage: "photo.on.rectangle")
            }
            Button {
                showsFileImporter = true
            } label: {
                Label("파일", systemImage: "doc")
            }
            if store.draftVoiceClip != nil {
                Button(role: .destructive) {
                    store.removeDraftVoiceClip()
                } label: {
                    Label("음성 첨부 삭제", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 42, height: 48)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("첨부 추가")
    }

    private var recordingGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                if dragStartedAt == nil {
                    dragStartedAt = .now
                    gestureResolved = false
                    holdTask?.cancel()
                    holdTask = Task {
                        try? await Task.sleep(for: .milliseconds(200))
                        guard !Task.isCancelled else { return }
                        await MainActor.run {
                            playback.stop()
                            recorder.beginHoldRecording()
                            Haptics.impact()
                        }
                    }
                }

                if value.translation.width < -95, recorder.state.isRecording {
                    gestureResolved = true
                    holdTask?.cancel()
                    store.cancelRecording()
                    Haptics.impact(.medium)
                } else if value.translation.height < -75, recorder.state == .recordingHold {
                    gestureResolved = true
                    recorder.lockRecording()
                    Haptics.impact(.medium)
                }
            }
            .onEnded { _ in
                let elapsed = dragStartedAt.map { Date.now.timeIntervalSince($0) } ?? 0
                holdTask?.cancel()
                holdTask = nil

                defer {
                    dragStartedAt = nil
                    gestureResolved = false
                }

                guard !gestureResolved else { return }
                if elapsed < 0.2 {
                    playback.stop()
                    recorder.beginTapRecording()
                    Haptics.impact()
                } else {
                    store.finishRecording(sendImmediately: true)
                }
            }
    }

    private var deliveryToggle: some View {
        HStack(spacing: 8) {
            deliveryChip(
                title: "다음 차례",
                detail: "현재 작업 뒤에 시작",
                action: "input.followUp"
            )
            deliveryChip(
                title: "현재 작업에 반영",
                detail: "다음 판단부터 반영",
                action: "input.steer"
            )
            if canSend {
                Button {
                    store.cancelActiveResponse()
                    Haptics.impact(.medium)
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .rubatoGlass(in: Circle(), interactive: true)
                .accessibilityLabel("응답 중단")
            }
        }
        .padding(.horizontal, ExyteMetrics.horizontalScreenEdgePadding)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("보내는 방식")
    }

    private func deliveryChip(title: String, detail: String, action: String) -> some View {
        let selected = delivery == action
        return Button {
            delivery = action
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .rubatoGlass(in: RoundedRectangle(cornerRadius: 14), interactive: true)
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(selected ? Color.accentColor : .clear, lineWidth: 1.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(selected ? "선택됨" : "선택 안 됨")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func submitDraft() {
        guard canSend else { return }
        if store.isResponseActive {
            store.sendCurrentDraft(delivery: delivery == "input.steer" ? .steer : .followUp)
            return
        }
        store.sendCurrentDraft()
    }

    private func replyBar(_ reply: ReplyReference) -> some View {
        VStack(spacing: 7) {
            Divider()
            HStack(spacing: 10) {
                Image(systemName: "arrowshape.turn.up.left")
                    .foregroundStyle(.tint)
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: 2, height: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(reply.authorName)에게 답장")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(reply.preview)
                        .font(.caption2)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    store.clearReply()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("답장 취소")
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 2)
        }
    }
}

private struct DraftVoicePreview: View {
    let clip: VoiceClip
    @ObservedObject var playback: AudioPlaybackCenter

    var body: some View {
        HStack(spacing: 8) {
            Button {
                playback.toggle(clip)
            } label: {
                Image(systemName: playback.isPlaying(clip) ? "pause.fill" : "play.fill")
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)

            WaveformView(
                samples: clip.waveformSamples,
                progress: playback.isActive(clip) ? playback.progress : 0,
                onSeek: { playback.seek(clip, to: $0) }
            )
            .frame(height: 26)

            Text(DisplayFormatter.duration(clip.duration))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .frame(minHeight: 48)
    }
}
