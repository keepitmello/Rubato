import SwiftUI

struct ArtifactsSheet: View {
    var git: GitView
    var images: [RemoteImage]
    var onReload: () -> Void

    @State private var tab = ArtifactTab.diff

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("작업 결과", selection: $tab) {
                    Text("변경점").tag(ArtifactTab.diff)
                    Text("파일").tag(ArtifactTab.files)
                    Text("이미지").tag(ArtifactTab.images)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 12)
                .accessibilityLabel("작업 결과")

                switch tab {
                case .diff:
                    diffTab
                case .files:
                    filesTab
                case .images:
                    imagesTab
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("파일과 변경점")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("다시 불러오기", action: onReload)
                        .accessibilityLabel("변경점 다시 불러오기")
                }
            }
        }
    }

    private var diffTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !git.summary.isEmpty {
                    Text(git.summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if git.diffText.isEmpty {
                    ContentUnavailableView(
                        "Git HTTP가 없어요",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text(gitEmptyDescription)
                    )
                    .padding(.top, 40)
                } else {
                    Text(git.diffText)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
        }
        .accessibilityLabel("변경점")
    }

    private var filesTab: some View {
        Group {
            if git.files.isEmpty {
                ContentUnavailableView(
                    "Git HTTP가 없어요",
                    systemImage: "doc",
                    description: Text(gitEmptyDescription)
                )
            } else {
                List(git.files) { file in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(fileName(file.path))
                            .font(.body.weight(.semibold))
                        Text("\(parentPath(file.path)) · \(fileStatus(file.status))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(fileName(file.path)), \(fileStatus(file.status))")
                }
                .listStyle(.plain)
            }
        }
        .accessibilityLabel("파일 목록")
    }

    private var imagesTab: some View {
        Group {
            if images.isEmpty {
                ContentUnavailableView(
                    "이 세션에 이미지가 없어요",
                    systemImage: "photo",
                    description: Text("생성된 이미지가 여기 모여요.")
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(images) { image in
                            VStack(alignment: .leading, spacing: 8) {
                                if let url = URL(string: image.url) {
                                    AsyncImage(url: url) { phase in
                                        switch phase {
                                        case let .success(loaded):
                                            loaded
                                                .resizable()
                                                .scaledToFit()
                                                .clipShape(RoundedRectangle(cornerRadius: 12))
                                        case .failure:
                                            Label("이미지를 불러오지 못했어요", systemImage: "photo.badge.exclamationmark")
                                                .foregroundStyle(.secondary)
                                        default:
                                            ProgressView()
                                                .frame(maxWidth: .infinity, minHeight: 80)
                                        }
                                    }
                                    .accessibilityLabel(image.alt.isEmpty ? "세션 이미지" : image.alt)
                                }
                                if !image.alt.isEmpty {
                                    Text(image.alt)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .padding()
                }
            }
        }
        .accessibilityLabel("이미지")
    }

    private var gitEmptyDescription: String {
        let summary = git.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !summary.isEmpty {
            return summary
        }
        return "이 허브 빌드에는 git HTTP가 없어요. 상태와 차이를 불러올 수 없습니다."
    }

    private func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func parentPath(_ path: String) -> String {
        let parts = path.split(separator: "/").dropLast()
        return parts.isEmpty ? "/" : parts.joined(separator: "/")
    }

    private func fileStatus(_ status: String) -> String {
        switch status {
        case "modified", "M": "수정"
        case "added", "A": "추가"
        case "deleted", "D": "삭제"
        case "renamed", "R": "이름 변경"
        default: status
        }
    }

    private enum ArtifactTab: Hashable {
        case diff
        case files
        case images
    }
}
