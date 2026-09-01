import SwiftUI

struct ApprovalCard: View {
    let request: RemoteUiRequest
    var onRespond: (Any) -> Void

    @State private var inputText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("확인이 필요해요", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
                .accessibilityAddTraits(.isHeader)

            Text(request.title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)

            if let message = request.message, !message.isEmpty {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .rubatoGlass(in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("확인 요청, \(request.title). 답할 때까지 메시지를 보낼 수 없어요")
        .onAppear {
            inputText = ""
        }
        .onChange(of: request.requestId) { _, _ in
            inputText = ""
        }
    }

    @ViewBuilder
    private var content: some View {
        switch request.kind {
        case "select":
            VStack(alignment: .leading, spacing: 8) {
                ForEach(request.options) { option in
                    Button {
                        onRespond(option.value)
                    } label: {
                        Text(option.label)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(option.label)
                }
            }

        case "confirm":
            HStack(spacing: 10) {
                Button(role: .cancel) {
                    onRespond(false)
                } label: {
                    Text("아니요")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("아니요")

                Button {
                    onRespond(true)
                } label: {
                    Text("적용")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("적용")
            }

        default:
            VStack(alignment: .leading, spacing: 10) {
                TextField(request.placeholder ?? "응답", text: $inputText, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(request.placeholder ?? "응답 입력")

                Button {
                    let value = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !value.isEmpty else { return }
                    onRespond(value)
                } label: {
                    Text("응답 보내기")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("응답 보내기")
            }
        }
    }
}
