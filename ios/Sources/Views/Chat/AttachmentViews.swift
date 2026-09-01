import SwiftUI
import UIKit

// The attachment width and spacing follow Exyte/Chat's default message layout.
struct MessageAttachmentGrid: View {
    let attachments: [ChatAttachment]
    let isCurrentUser: Bool
    let onOpen: (ChatAttachment) -> Void

    private let mediaWidth: CGFloat = 204

    var body: some View {
        if attachments.count == 1, let attachment = attachments.first {
            attachmentView(attachment)
                .frame(maxWidth: attachment.kind == .image ? mediaWidth : nil)
        } else if !attachments.isEmpty {
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)],
                spacing: 2
            ) {
                ForEach(attachments) { attachment in
                    attachmentView(attachment)
                }
            }
            .frame(width: mediaWidth)
        }
    }

    @ViewBuilder
    private func attachmentView(_ attachment: ChatAttachment) -> some View {
        Button {
            onOpen(attachment)
        } label: {
            switch attachment.kind {
            case .image:
                LocalAttachmentImage(url: attachment.localURL)
                    .frame(minHeight: 132, maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

            case .file:
                HStack(spacing: 10) {
                    Image(systemName: "doc.fill")
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(attachment.displayName)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        if let byteCount = attachment.byteCount {
                            Text(DisplayFormatter.bytes.string(fromByteCount: byteCount))
                                .font(.caption2)
                                .opacity(0.72)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.right")
                        .font(.caption.weight(.semibold))
                        .opacity(0.7)
                }
                .padding(12)
                .foregroundStyle(isCurrentUser ? Color.white : Color.primary)
                .background(.primary.opacity(isCurrentUser ? 0.12 : 0.06), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("첨부파일 \(attachment.displayName) 열기")
    }
}

struct DraftAttachmentStrip: View {
    let attachments: [ChatAttachment]
    let onRemove: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if attachment.kind == .image {
                                LocalAttachmentImage(url: attachment.localURL)
                            } else {
                                VStack(spacing: 6) {
                                    Image(systemName: "doc.fill")
                                        .font(.title2)
                                    Text(attachment.displayName)
                                        .font(.caption2)
                                        .lineLimit(2)
                                }
                                .padding(8)
                                .background(.secondary.opacity(0.1))
                            }
                        }
                        .frame(width: 72, height: 72)
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                        Button {
                            onRemove(attachment.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 20, height: 20)
                                .background(.black.opacity(0.68), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .offset(x: 5, y: -5)
                        .accessibilityLabel("\(attachment.displayName) 첨부 취소")
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
        }
    }
}

private struct LocalAttachmentImage: View {
    let url: URL

    var body: some View {
        if let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                Rectangle().fill(.secondary.opacity(0.12))
                Image(systemName: "photo")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
