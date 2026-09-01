import SwiftUI
import UIKit

enum MarkdownBlock: Identifiable, Equatable {
    case paragraph(id: Int, value: String)
    case heading(id: Int, level: Int, value: String)
    case list(id: Int, ordered: Bool, items: [String])
    case quote(id: Int, value: String)
    case code(id: Int, language: String?, value: String)
    case rule(id: Int)

    var id: Int {
        switch self {
        case let .paragraph(id, _),
             let .heading(id, _, _),
             let .list(id, _, _),
             let .quote(id, _),
             let .code(id, _, _),
             let .rule(id):
            id
        }
    }
}

enum MarkdownBlockParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var index = 0

        func nextID() -> Int { blocks.count }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                index += 1
                continue
            }

            if trimmed.hasPrefix("```") {
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                index += 1
                var closed = false
                while index < lines.count {
                    if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        closed = true
                        index += 1
                        break
                    }
                    code.append(lines[index])
                    index += 1
                }
                if closed {
                    let label = normalizedLanguage(language)
                    blocks.append(.code(id: nextID(), language: label, value: code.joined(separator: "\n")))
                } else {
                    let leftover = (["```\(language)"] + code).joined(separator: "\n")
                    blocks.append(.paragraph(id: nextID(), value: leftover))
                }
                continue
            }

            if isRule(trimmed) {
                blocks.append(.rule(id: nextID()))
                index += 1
                continue
            }

            if let heading = parseHeading(trimmed) {
                blocks.append(.heading(id: nextID(), level: heading.level, value: heading.text))
                index += 1
                continue
            }

            if let item = unorderedItem(line) {
                var items = [item]
                index += 1
                while index < lines.count, let next = unorderedItem(lines[index]) {
                    items.append(next)
                    index += 1
                }
                blocks.append(.list(id: nextID(), ordered: false, items: items))
                continue
            }

            if let item = orderedItem(line) {
                var items = [item]
                index += 1
                while index < lines.count, let next = orderedItem(lines[index]) {
                    items.append(next)
                    index += 1
                }
                blocks.append(.list(id: nextID(), ordered: true, items: items))
                continue
            }

            if let quoted = quoteLine(line) {
                var quotedLines = [quoted]
                index += 1
                while index < lines.count, let next = quoteLine(lines[index]) {
                    quotedLines.append(next)
                    index += 1
                }
                blocks.append(.quote(id: nextID(), value: quotedLines.joined(separator: "\n")))
                continue
            }

            var paragraph = [line]
            index += 1
            while index < lines.count {
                let next = lines[index]
                let nextTrimmed = next.trimmingCharacters(in: .whitespaces)
                if nextTrimmed.isEmpty { break }
                if nextTrimmed.hasPrefix("```") || isRule(nextTrimmed) || parseHeading(nextTrimmed) != nil {
                    break
                }
                if unorderedItem(next) != nil || orderedItem(next) != nil || quoteLine(next) != nil {
                    break
                }
                paragraph.append(next)
                index += 1
            }
            blocks.append(.paragraph(id: nextID(), value: paragraph.joined(separator: "\n")))
        }

        return blocks
    }

    private static func normalizedLanguage(_ language: String) -> String? {
        let value = language.lowercased()
        if value.isEmpty || value == "text" || value == "plaintext" || value == "txt" {
            return nil
        }
        return language
    }

    private static func isRule(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        return compact.count >= 3
            && (compact.allSatisfy { $0 == "-" } || compact.allSatisfy { $0 == "*" } || compact.allSatisfy { $0 == "_" })
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        guard line.hasPrefix("#") else { return nil }
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard (1...6).contains(level) else { return nil }
        let rest = line.dropFirst(level)
        guard rest.first == " " else { return nil }
        return (level, rest.dropFirst().trimmingCharacters(in: .whitespaces))
    }

    private static func unorderedItem(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else { return nil }
        let marker = trimmed.first
        guard marker == "-" || marker == "*" || marker == "+" else { return nil }
        let rest = trimmed.dropFirst()
        guard rest.first == " " else { return nil }
        return rest.dropFirst().trimmingCharacters(in: .whitespaces)
    }

    private static func orderedItem(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let dot = trimmed.firstIndex(of: ".") else { return nil }
        let number = trimmed[..<dot]
        guard !number.isEmpty, number.allSatisfy(\.isNumber) else { return nil }
        let rest = trimmed[trimmed.index(after: dot)...]
        guard rest.hasPrefix(" ") else { return nil }
        return rest.dropFirst().trimmingCharacters(in: .whitespaces)
    }

    private static func quoteLine(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix(">") else { return nil }
        let rest = trimmed.dropFirst()
        if rest.hasPrefix(" ") { return String(rest.dropFirst()) }
        return String(rest)
    }
}

struct AgentMarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(MarkdownBlockParser.parse(text)) { block in
                switch block {
                case let .paragraph(_, value):
                    markdownText(value)
                        .font(.body)

                case let .heading(_, level, value):
                    markdownText(value)
                        .font(headingFont(level))
                        .fontWeight(.semibold)
                        .padding(.top, level <= 2 ? 6 : 2)

                case let .list(_, ordered, items):
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .top, spacing: 8) {
                                Text(ordered ? "\(index + 1)." : "•")
                                    .font(.body.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                    .frame(width: 22, alignment: .trailing)
                                markdownText(item)
                                    .font(.body)
                            }
                        }
                    }

                case let .quote(_, value):
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(Color.secondary.opacity(0.45))
                            .frame(width: 3)
                        markdownText(value)
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))

                case let .code(_, language, value):
                    CodeBlockView(language: language, code: value)

                case .rule:
                    Divider()
                        .padding(.vertical, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title
        case 2: .title2
        case 3: .title3
        default: .headline
        }
    }

    private func markdownText(_ source: String) -> some View {
        Text(inlineMarkdown(source))
            .multilineTextAlignment(.leading)
            .lineLimit(nil)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inlineMarkdown(_ source: String) -> AttributedString {
        (try? AttributedString(
            markdown: source,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
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
                Text(language ?? "코드")
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
