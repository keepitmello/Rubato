import SwiftUI

struct SessionControlsSheet: View {
    var sessionTitle: String
    var extras: RubatoSessionExtras.Snapshot
    var onAction: (String, [String: Any]) -> Void

    @State private var renameDraft = ""
    @State private var compactInstructions = ""

    var body: some View {
        NavigationStack {
            Form {
                renameSection
                modelSection
                thinkingSection
                compactSection
                treeSection
                commandsSection
                teamSection
                actionsSection
            }
            .navigationTitle("세션 제어")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                if renameDraft.isEmpty {
                    renameDraft = sessionTitle
                }
            }
        }
    }

    private var renameSection: some View {
        Section {
            TextField("세션 이름", text: $renameDraft)
                .accessibilityLabel("세션 이름")
            Button("이름 저장") {
                let name = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                onAction("session.rename", ["name": name])
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("이름 저장")
        } header: {
            Text("이름 바꾸기")
        } footer: {
            Text(extras.cwd.isEmpty ? "목록에 보일 이름이에요." : ConversationMapping.shortPath(extras.cwd))
        }
    }

    private var modelSection: some View {
        Section {
            ForEach(Self.modelChoices, id: \.modelId) { choice in
                Button {
                    onAction("model.set", [
                        "provider": choice.provider,
                        "modelId": choice.modelId
                    ])
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(choice.label)
                            Text(choice.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if extras.modelLabel == choice.label {
                            Text("현재")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityLabel(extras.modelLabel == choice.label ? "\(choice.label), 현재 선택" : choice.label)
            }
        } header: {
            Text("모델")
        }
    }

    private var thinkingSection: some View {
        Section {
            ForEach(Self.thinkingChoices, id: \.level) { choice in
                Button {
                    onAction("thinking.set", ["level": choice.level])
                } label: {
                    HStack {
                        Text(choice.label)
                        Spacer()
                        if extras.thinkingLevel == choice.level {
                            Text("현재")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityLabel(extras.thinkingLevel == choice.level ? "\(choice.label), 현재 선택" : choice.label)
            }
        } header: {
            Text("추론 강도")
        }
    }

    private var compactSection: some View {
        Section {
            TextField("정리 지시 (선택)", text: $compactInstructions, axis: .vertical)
                .lineLimit(1...4)
                .accessibilityLabel("대화 정리 지시")
            Button("대화 정리") {
                let instructions = compactInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
                if instructions.isEmpty {
                    onAction("session.compact", [:])
                } else {
                    onAction("session.compact", ["instructions": instructions])
                }
            }
            .accessibilityLabel("대화 정리")
        } header: {
            Text("대화 정리")
        } footer: {
            Text("문맥 공간을 확보해요. 지시는 비워도 됩니다.")
        }
    }

    @ViewBuilder
    private var treeSection: some View {
        if extras.tree.isEmpty {
            EmptyView()
        } else {
            Section {
                ForEach(extras.tree) { node in
                    Button {
                        onAction("session.navigate", ["targetEntryId": node.id])
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(node.label)
                                Text(node.current ? "현재 위치" : "이 위치에서 이어가기")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if node.current {
                                Text("현재")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityLabel(node.current ? "\(node.label), 현재 위치" : "\(node.label)로 이동")
                }
            } header: {
                Text("대화 가지")
            }
        }
    }

    @ViewBuilder
    private var commandsSection: some View {
        if extras.commands.isEmpty {
            EmptyView()
        } else {
            Section {
                ForEach(extras.commands) { command in
                    Button {
                        fire(command)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(commandLabel(command))
                            if !command.description.isEmpty {
                                Text(command.description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityLabel(commandLabel(command))
                }
            } header: {
                Text("스킬과 명령")
            }
        }
    }

    private var teamSection: some View {
        Section {
            if extras.backgroundLabels.isEmpty {
                Text("표시할 하위 작업이 없어요.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(extras.backgroundLabels, id: \.self) { label in
                    Label(backgroundTitle(label), systemImage: "person.2")
                        .accessibilityLabel(backgroundTitle(label))
                }
            }
        } header: {
            Text("하위 작업")
        } footer: {
            Text("주 작업과 별도로 진행되는 팀·백그라운드 상태예요.")
        }
    }

    private var actionsSection: some View {
        Section {
            Button("다시 불러오기") {
                onAction("session.reload", [:])
            }
            .accessibilityLabel("세션 다시 불러오기")

            Button("작업 중단", role: .destructive) {
                onAction("agent.abort", [:])
            }
            .accessibilityLabel("작업 중단")
        } header: {
            Text("실행")
        }
    }

    private func fire(_ command: RemoteCommand) {
        if command.name == "abort" {
            onAction("agent.abort", [:])
        } else {
            onAction(command.name, [:])
        }
    }

    private func commandLabel(_ command: RemoteCommand) -> String {
        switch command.name {
        case "abort": "작업 중단"
        case "compact": "대화 정리"
        default: command.name
        }
    }

    private func backgroundTitle(_ label: String) -> String {
        switch label {
        case "tests": "테스트 실행"
        case "indexing": "파일 인덱싱"
        default: label
        }
    }

    private struct ModelChoice {
        var provider: String
        var modelId: String
        var label: String
        var description: String
    }

    private static let modelChoices: [ModelChoice] = [
        .init(provider: "openai-codex", modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "Codex 기본 경로"),
        .init(provider: "kiro", modelId: "claude-opus-5", label: "Claude", description: "긴 글과 코드 작업"),
        .init(provider: "cursor", modelId: "cursor-grok-4.6", label: "Grok 4.6", description: "Cursor Grok Fast")
    ]

    private static let thinkingChoices: [(level: String, label: String)] = [
        ("low", "낮음"),
        ("medium", "보통"),
        ("high", "높음")
    ]
}
