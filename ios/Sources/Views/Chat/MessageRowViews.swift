// Message spacing, bubble sizing, reply presentation, status, and reaction placement
// are adapted from Exyte/Chat under the MIT License.

import SwiftUI
import UIKit

struct MessageRowView: View {
    let message: ChatMessage
    let groupPosition: MessageGroupPosition
    let showDate: Bool
    @ObservedObject var audioPlayback: AudioPlaybackCenter
    let onReply: (ChatMessage) -> Void
    let onReaction: (UUID, String) -> Void
    let onRetryResponse: (UUID) -> Void
    let onRetrySending: (UUID) -> Void
    let onOpenAttachment: (ChatAttachment) -> Void

    var body: some View {
        VStack(spacing: 0) {
            if showDate {
                DateSeparator(date: message.createdAt)
                    .padding(.vertical, 14)
            }

            Group {
                switch message.role {
                case .user:
                    UserMessageView(
                        message: message,
                        groupPosition: groupPosition,
                        audioPlayback: audioPlayback,
                        onReaction: onReaction,
                        onRetrySending: onRetrySending,
                        onOpenAttachment: onOpenAttachment
                    )
                case .assistant:
                    AgentMessageView(
                        message: message,
                        groupPosition: groupPosition,
                        audioPlayback: audioPlayback,
                        onReaction: onReaction,
                        onRetry: onRetryResponse,
                        onOpenAttachment: onOpenAttachment
                    )
                case .system:
                    SystemMessageView(message: message)
                }
            }
            .contextMenu {
                if !message.text.isEmpty {
                    Button {
                        UIPasteboard.general.string = message.text
                        Haptics.impact()
                    } label: {
                        Label("복사", systemImage: "doc.on.doc")
                    }
                }

                Button {
                    onReply(message)
                } label: {
                    Label("답장", systemImage: "arrowshape.turn.up.left")
                }

                Menu {
                    ForEach(["👍", "❤️", "😂", "‼️", "?"], id: \.self) { emoji in
                        Button(emoji) {
                            onReaction(message.id, emoji)
                        }
                    }
                } label: {
                    Label("반응 달기", systemImage: "face.smiling")
                }

                if message.role == .user, case .failed = message.deliveryState {
                    Button {
                        onRetrySending(message.id)
                    } label: {
                        Label("다시 보내기", systemImage: "arrow.clockwise")
                    }
                }

                if case .failed = message.responseState {
                    Button {
                        onRetryResponse(message.id)
                    } label: {
                        Label("다시 실행", systemImage: "arrow.clockwise")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct DateSeparator: View {
    let date: Date

    var body: some View {
        Text(DisplayFormatter.day.string(from: date))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.secondary.opacity(0.08), in: Capsule())
            .accessibilityLabel("\(DisplayFormatter.day.string(from: date)) 대화")
    }
}

private struct UserMessageView: View {
    let message: ChatMessage
    let groupPosition: MessageGroupPosition
    @ObservedObject var audioPlayback: AudioPlaybackCenter
    let onReaction: (UUID, String) -> Void
    let onRetrySending: (UUID) -> Void
    let onOpenAttachment: (ChatAttachment) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: ExyteMetrics.horizontalSpacing) {
            Spacer(minLength: ExyteMetrics.horizontalBubblePadding)

            VStack(alignment: .trailing, spacing: 2) {
                VStack(alignment: .leading, spacing: 4) {
                    if let reply = message.replyTo {
                        ReplyPreview(reference: reply, isCurrentUser: true)
                    }

                    if !message.attachments.isEmpty {
                        MessageAttachmentGrid(
                            attachments: message.attachments,
                            isCurrentUser: true,
                            onOpen: onOpenAttachment
                        )
                    }

                    if !message.text.isEmpty {
                        Text(message.text)
                            .font(.body)
                            .multilineTextAlignment(.leading)
                            .lineLimit(nil)
                            .textSelection(.enabled)
                            .padding(.horizontal, ExyteMetrics.horizontalTextPadding)
                            .padding(.top, message.attachments.isEmpty ? 8 : 4)
                    }

                    if let clip = message.voiceClip {
                        AudioMessageView(
                            clip: clip,
                            isCurrentUser: true,
                            playback: audioPlayback
                        )
                    }

                    HStack(spacing: 4) {
                        Text(DisplayFormatter.messageTime.string(from: message.createdAt))
                            .font(.caption2)
                            .opacity(0.72)
                        UserDeliveryIndicator(
                            state: message.deliveryState,
                            onRetry: { onRetrySending(message.id) }
                        )
                    }
                    .padding(.horizontal, ExyteMetrics.horizontalTextPadding)
                    .padding(.bottom, 7)
                    .padding(.top, message.text.isEmpty && message.voiceClip == nil ? 3 : 0)
                }
                .foregroundStyle(.white)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: ExyteMetrics.messageCornerRadius))
                .frame(
                    maxWidth: max(160, UIScreen.main.bounds.width - ExyteMetrics.horizontalScreenEdgePadding * 2 - ExyteMetrics.horizontalBubblePadding),
                    alignment: .trailing
                )

                ReactionStrip(
                    messageID: message.id,
                    reactions: message.reactions,
                    alignment: .trailing,
                    onReaction: onReaction
                )
            }
        }
        .padding(.horizontal, ExyteMetrics.horizontalScreenEdgePadding)
        .padding(.top, groupPosition.isTop ? ExyteMetrics.separatedMessageSpacing : ExyteMetrics.groupedMessageSpacing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        var parts = ["내 메시지", message.previewText]
        if case .failed(let reason) = message.deliveryState {
            parts.append("전송 실패: \(reason)")
        }
        return parts.joined(separator: ", ")
    }
}

private struct AgentMessageView: View {
    let message: ChatMessage
    let groupPosition: MessageGroupPosition
    @ObservedObject var audioPlayback: AudioPlaybackCenter
    let onReaction: (UUID, String) -> Void
    let onRetry: (UUID) -> Void
    let onOpenAttachment: (ChatAttachment) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if groupPosition.isTop {
                HStack(spacing: 8) {
                    ZStack {
                        Circle().fill(.primary)
                        Text("R")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color(uiColor: .systemBackground))
                    }
                    .frame(width: 30, height: 30)
                    .accessibilityHidden(true)

                    Text("Rubato")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                if let reply = message.replyTo {
                    ReplyPreview(reference: reply, isCurrentUser: false)
                }

                if !message.text.isEmpty {
                    AgentMarkdownView(text: message.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if !message.attachments.isEmpty {
                    MessageAttachmentGrid(
                        attachments: message.attachments,
                        isCurrentUser: false,
                        onOpen: onOpenAttachment
                    )
                }

                if let clip = message.voiceClip {
                    AudioMessageView(
                        clip: clip,
                        isCurrentUser: false,
                        playback: audioPlayback
                    )
                    .background(.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                }

                AgentResponseIndicator(message: message, onRetry: onRetry)

                ReactionStrip(
                    messageID: message.id,
                    reactions: message.reactions,
                    alignment: .leading,
                    onReaction: onReaction
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, ExyteMetrics.horizontalScreenEdgePadding)
        .padding(.top, groupPosition.isTop ? 14 : 8)
        .padding(.bottom, groupPosition.isBottom ? 8 : 0)
        .accessibilityLabel("Rubato 응답, \(message.previewText)")
    }
}

private struct SystemMessageView: View {
    let message: ChatMessage

    var body: some View {
        Text(message.text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.vertical, 8)
    }
}

private struct ReplyPreview: View {
    let reference: ReplyReference
    let isCurrentUser: Bool

    var body: some View {
        HStack(spacing: 8) {
            Capsule()
                .fill(isCurrentUser ? Color.white.opacity(0.8) : Color.accentColor)
                .frame(width: 2)

            VStack(alignment: .leading, spacing: 2) {
                Text(reference.authorName)
                    .font(.caption2.weight(.semibold))
                Text(reference.preview)
                    .font(.caption2)
                    .lineLimit(2)
            }
        }
        .foregroundStyle(isCurrentUser ? Color.white : Color.primary)
        .opacity(0.82)
        .padding(.horizontal, ExyteMetrics.horizontalTextPadding)
        .padding(.top, 8)
    }
}

private struct ReactionStrip: View {
    let messageID: UUID
    let reactions: [MessageReaction]
    let alignment: Alignment
    let onReaction: (UUID, String) -> Void

    var body: some View {
        if !reactions.isEmpty {
            HStack(spacing: 4) {
                ForEach(reactions) { reaction in
                    Button {
                        onReaction(messageID, reaction.emoji)
                        Haptics.impact()
                    } label: {
                        HStack(spacing: 3) {
                            Text(reaction.emoji)
                            if reaction.count > 1 {
                                Text("\(reaction.count)")
                                    .font(.caption2)
                            }
                        }
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(
                            reaction.isSelectedByCurrentUser
                                ? Color.accentColor.opacity(0.18)
                                : Color(uiColor: .secondarySystemBackground),
                            in: Capsule()
                        )
                        .overlay {
                            Capsule().stroke(Color(uiColor: .separator).opacity(0.4), lineWidth: 0.5)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(reaction.emoji) 반응 \(reaction.count)개")
                    .accessibilityHint(reaction.isSelectedByCurrentUser ? "두 번 탭하면 반응을 취소해요" : "두 번 탭하면 같은 반응을 달아요")
                }
            }
            .frame(maxWidth: .infinity, alignment: alignment)
            .offset(y: -3)
        }
    }
}

private struct UserDeliveryIndicator: View {
    let state: MessageDeliveryState
    let onRetry: () -> Void

    var body: some View {
        switch state {
        case .queued, .sending:
            ProgressView()
                .controlSize(.mini)
                .tint(.white)
        case .sent:
            Image(systemName: "checkmark")
                .font(.caption2.weight(.bold))
        case let .failed(reason):
            Button {
                onRetry()
                Haptics.impact()
            } label: {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.caption2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("전송 실패")
            .accessibilityValue(reason)
            .accessibilityHint("두 번 탭하면 다시 보내요")
        }
    }
}

private struct AgentResponseIndicator: View {
    let message: ChatMessage
    let onRetry: (UUID) -> Void

    var body: some View {
        switch message.responseState {
        case .waiting:
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("응답을 기다리고 있어요")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

        case .streaming:
            HStack(spacing: 7) {
                ProgressView().controlSize(.small)
                Text("응답 중")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

        case .cancelled:
            Label("응답을 중단했어요", systemImage: "stop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)

        case let .failed(reason):
            VStack(alignment: .leading, spacing: 8) {
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                Button("다시 실행") {
                    onRetry(message.id)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

        case .completed:
            Text(DisplayFormatter.messageTime.string(from: message.createdAt))
                .font(.caption2)
                .foregroundStyle(.tertiary)

        case .none:
            EmptyView()
        }
    }
}
