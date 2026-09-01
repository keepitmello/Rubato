import SwiftUI

struct ToolStatusBar: View {
    let tools: [RemoteTool]

    var body: some View {
        if !tools.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(tools) { tool in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: iconName(for: tool.status))
                            .foregroundStyle(color(for: tool.status))
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.name)
                                .font(.subheadline.weight(.semibold))
                            Text(tool.summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }

                        Spacer(minLength: 8)

                        Text(statusLabel(tool.status))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(color(for: tool.status))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("도구 \(tool.name), \(statusLabel(tool.status)), \(tool.summary)")
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .rubatoGlass(in: RoundedRectangle(cornerRadius: 16))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("도구 상태")
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "running": "실행 중"
        case "ok", "done", "completed", "success": "완료"
        case "error", "failed": "실패"
        default: status
        }
    }

    private func iconName(for status: String) -> String {
        switch status {
        case "running": "gearshape.2"
        case "ok", "done", "completed", "success": "checkmark.circle.fill"
        case "error", "failed": "xmark.circle.fill"
        default: "wrench.and.screwdriver"
        }
    }

    private func color(for status: String) -> Color {
        switch status {
        case "running": .orange
        case "ok", "done", "completed", "success": .green
        case "error", "failed": .red
        default: .secondary
        }
    }
}
