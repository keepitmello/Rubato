import SwiftUI

struct NewSessionView: View {
    var projects: [ProjectChoiceItem]
    var onCreate: (String, String) -> Void
    var onBrowse: () -> Void

    @State private var selectedPath = ""
    @State private var customPath = ""
    @State private var thinkingLevel = "high"

    private var chosenPath: String {
        let custom = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !custom.isEmpty { return custom }
        return selectedPath
    }

    private var canCreate: Bool {
        !chosenPath.isEmpty
    }

    var body: some View {
        Form {
            Section {
                hostCard
            } header: {
                Text("Mac")
            } footer: {
                Text("세션은 이 Mac에서 계속 실행돼요.")
            }

            Section {
                if projects.isEmpty {
                    ContentUnavailableView(
                        "최근 폴더가 없어요",
                        systemImage: "folder",
                        description: Text("경로를 직접 입력하거나 찾아보세요.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(projects) { project in
                        Button {
                            selectedPath = project.path
                            customPath = ""
                        } label: {
                            projectRow(project)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(projectAccessibility(project))
                        .accessibilityAddTraits(selectedPath == project.path ? .isSelected : [])
                    }
                }

                TextField("다른 폴더 경로", text: $customPath, prompt: Text("~/Projects/my-project"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: customPath) { _, value in
                        if !value.isEmpty { selectedPath = "" }
                    }
                    .accessibilityLabel("다른 폴더 경로")

                Button {
                    onBrowse()
                } label: {
                    Label("폴더 찾아보기", systemImage: "folder.badge.plus")
                }
                .accessibilityLabel("폴더 찾아보기")
            } header: {
                Text("작업 폴더")
            }

            Section {
                Picker("추론 강도", selection: $thinkingLevel) {
                    Text("낮음").tag("low")
                    Text("보통").tag("medium")
                    Text("높음").tag("high")
                }
                .accessibilityLabel("추론 강도")
            } header: {
                Text("세션 설정")
            } footer: {
                Text("모델은 Mac 기본값을 쓰고, 추론만 여기서 고를 수 있어요.")
            }

            Section {
                Button {
                    onCreate(chosenPath, thinkingLevel)
                } label: {
                    Label("세션 시작", systemImage: "sparkles")
                        .frame(maxWidth: .infinity)
                }
                .disabled(!canCreate)
                .accessibilityLabel("세션 시작")
                .accessibilityHint(canCreate ? "선택한 폴더에서 새 세션을 만들어요" : "폴더를 먼저 고르세요")
            }
        }
        .navigationTitle("새 세션")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var hostCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.title2)
                .frame(width: 36, height: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("이 Mac")
                    .font(.body.weight(.semibold))
                Text(HostSettings.origin)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("이 Mac, \(HostSettings.origin), 선택됨")
    }

    private func projectRow(_ project: ProjectChoiceItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "folder")
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.label)
                    .foregroundStyle(.primary)
                Text(ConversationMapping.shortPath(project.path))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(project.source == "favorite" ? "즐겨찾기" : "최근 사용")
                .font(.caption)
                .foregroundStyle(.secondary)
            if selectedPath == project.path {
                Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        }
    }

    private func projectAccessibility(_ project: ProjectChoiceItem) -> String {
        let source = project.source == "favorite" ? "즐겨찾기" : "최근 사용"
        let selected = selectedPath == project.path ? ", 선택됨" : ""
        return "\(project.label), \(source)\(selected)"
    }
}
