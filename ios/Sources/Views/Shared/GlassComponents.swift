import SwiftUI
import UIKit

// Values are carried over from Exyte/Chat's default MessageView/InputView layout.
enum ExyteMetrics {
    static let horizontalScreenEdgePadding: CGFloat = 12
    static let horizontalBubblePadding: CGFloat = 70
    static let horizontalTextPadding: CGFloat = 12
    static let horizontalSpacing: CGFloat = 6
    static let inputMinimumHeight: CGFloat = 48
    static let inputCornerRadius: CGFloat = 18
    static let messageCornerRadius: CGFloat = 20
    static let groupedMessageSpacing: CGFloat = 4
    static let separatedMessageSpacing: CGFloat = 8
}

extension View {
    @ViewBuilder
    func rubatoGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        if interactive {
            glassEffect(.regular.interactive(true), in: shape)
        } else {
            glassEffect(.regular, in: shape)
        }
    }
}

struct GlassIconButton: View {
    let systemName: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 38, height: 38)
        }
        .buttonStyle(.plain)
        .rubatoGlass(in: Circle(), interactive: true)
        .accessibilityLabel(accessibilityLabel)
    }
}

@MainActor
enum DisplayFormatter {
    static let relativeDate: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = Locale(identifier: "ko_KR")
        return formatter
    }()

    static let messageTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "a h:mm"
        return formatter
    }()

    static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M월 d일 EEEE"
        return formatter
    }()

    static let bytes: ByteCountFormatter = {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter
    }()

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

@MainActor
enum Haptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }
}
