import SwiftUI
import UIKit

enum MarkdownBlock: Identifiable, Equatable {
    case text(id: Int, value: String)
    case code(id: Int, language: String?, value: String)

    var id: Int {
        switch self {
        case let .text(id, _), let .code(id, _, _): id
        }
    }
}

enum MarkdownBlockParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        guard source.contains("```") else {
            return source.isEmpty ? [] : [.text(id: 0, value: source)]
        }

        var blocks: [MarkdownBlock] = []
        var textBuffer: [String] = []
        var codeBuffer: [String] = []
        var currentLanguage: String?
        var insideCode = false

        func flushText() {
            let value = textBuffer.joined(separator: "\n")
                .trimmingCharacters(in: .newlines)
            if !value.isEmpty {
                blocks.append(.text(id: blocks.count, value: value))
            }
            textBuffer.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            let value = codeBuffer.joined(separator: "\n")
            blocks.append(.code(id: blocks.count, language: currentLanguage, value: value))
            codeBuffer.removeAll(keepingCapacity: true)
            currentLanguage = nil
        }

        for line in source.components(separatedBy: .newlines) {
            if line.hasPrefix("```") {
                if insideCode {
                    flushCode()
                } else {
                    flushText()
                    let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    currentLanguage = language.isEmpty ? nil : language
                }
                insideCode.toggle()
                continue
            }

            if insideCode {
                codeBuffer.append(line)
            } else {
                textBuffer.append(line)
            }
        }

        if insideCode {
            textBuffer.append("```\(currentLanguage ?? "")")
            textBuffer.append(contentsOf: codeBuffer)
        }
        flushText()
        return blocks
    }
}

struct AgentMarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(MarkdownBlockParser.parse(text)) { block in
                switch block {
                case let .text(_, value):
                    Text(markdown(value))
                        .font(.body)
                        .multilineTextAlignment(.leading)
                        .lineLimit(nil)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)

                case let .code(_, language, value):
                    CodeBlockView(language: language, code: value)
                }
            }
        }
    }

    private func markdown(_ source: String) -> AttributedString {
        (try? AttributedString(
            markdown: source,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(source)
    }
}

private struct CodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language?.isEmpty == false ? language! : "코드")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    Haptics.impact()
                } label: {
                    Label("복사", systemImage: "doc.on.doc")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("코드 복사")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)

            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .background(.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(uiColor: .separator).opacity(0.45), lineWidth: 0.5)
        }
    }
}
