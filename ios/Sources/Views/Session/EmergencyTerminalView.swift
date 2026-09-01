import SwiftUI

struct EmergencyTerminalView: View {
    @Binding var output: String
    var onInput: (String) -> Void
    var onResize: (Int, Int) -> Void
    var onClose: () -> Void

    @State private var command = ""
    @State private var lastCols = 0
    @State private var lastRows = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Text("지원되지 않는 설정 화면이나 복구 작업에만 쓰세요. 닫아도 Rubato 작업은 계속돼요.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .padding(.bottom, 6)

                ScrollViewReader { proxy in
                    ScrollView {
                        Text(output.isEmpty ? " " : output)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .id("terminal-end")
                    }
                    .background(Color.black.opacity(0.88))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)
                    .onChange(of: output) { _, _ in
                        proxy.scrollTo("terminal-end", anchor: .bottom)
                    }
                }
                .background {
                    GeometryReader { geo in
                        Color.clear
                            .onAppear { reportResize(geo.size) }
                            .onChange(of: geo.size) { _, size in
                                reportResize(size)
                            }
                    }
                }
                .accessibilityLabel("터미널 화면")

                helperKeys

                HStack(spacing: 8) {
                    TextField("명령 입력", text: $command)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .submitLabel(.send)
                        .onSubmit(sendCommand)
                        .accessibilityLabel("터미널 입력")

                    Button("보내기", action: sendCommand)
                        .disabled(command.isEmpty)
                        .accessibilityLabel("터미널 입력 보내기")
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
            }
            .navigationTitle("비상 터미널")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") {
                        onClose()
                    }
                    .accessibilityLabel("터미널 닫기")
                }
            }
        }
    }

    private var helperKeys: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                key("Esc", "\u{001B}")
                key("Ctrl-C", "\u{0003}")
                key("Tab", "\t")
                key("↑", "\u{001B}[A", label: "위쪽 화살표")
                key("↓", "\u{001B}[B", label: "아래쪽 화살표")
                key("←", "\u{001B}[D", label: "왼쪽 화살표")
                key("→", "\u{001B}[C", label: "오른쪽 화살표")
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .accessibilityLabel("터미널 보조 키")
    }

    private func key(_ title: String, _ value: String, label: String? = nil) -> some View {
        Button(title) {
            onInput(value)
        }
        .buttonStyle(.bordered)
        .font(.caption.monospaced())
        .accessibilityLabel(label ?? title)
    }

    private func sendCommand() {
        let line = command
        guard !line.isEmpty else { return }
        onInput(line.hasSuffix("\n") ? line : line + "\n")
        command = ""
    }

    private func reportResize(_ size: CGSize) {
        let cols = max(20, Int(size.width / 7.2))
        let rows = max(8, Int(size.height / 16))
        guard cols != lastCols || rows != lastRows else { return }
        lastCols = cols
        lastRows = rows
        onResize(cols, rows)
    }
}
