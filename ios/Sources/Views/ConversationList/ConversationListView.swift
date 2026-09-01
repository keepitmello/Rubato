import SwiftUI

struct ConversationListView: View {
    @ObservedObject var appModel: AppModel
    @State private var path: [UUID] = []
    @State private var query = ""
    @State private var showsSettings = false
    @State private var showsNewSession = false
    @State private var hubURL = HostSettings.baseURL.absoluteString

    private var filteredSessions: [ChatSession] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return appModel.sessions
        }
        return appModel.sessions.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.subtitle.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(filteredSessions) { session in
                    Button {
                        path = [session.id]
                    } label: {
                        ConversationRow(session: session)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button {
                            appModel.togglePin(sessionID: session.id)
                        } label: {
                            Label(session.isPinned ? "고정 해제" : "고정", systemImage: session.isPinned ? "pin.slash" : "pin")
                        }
                        .tint(.orange)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            appModel.deleteSession(sessionID: session.id)
                        } label: {
                            Label("삭제", systemImage: "trash")
                        }
                    }
                }
                .onDelete { offsets in
                    for offset in offsets {
                        guard filteredSessions.indices.contains(offset) else { continue }
                        appModel.deleteSession(sessionID: filteredSessions[offset].id)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("메시지")
            .searchable(text: $query, prompt: "세션 검색")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("설정")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showsNewSession = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("새 세션")
                }
            }
            .navigationDestination(for: UUID.self) { sessionID in
                if let session = appModel.session(id: sessionID) {
                    ChatRoomScreen(
                        store: appModel.roomStore(for: session),
                        extrasHolder: appModel.extras,
                        isRemote: appModel.isRemote,
                        gitView: appModel.gitBySession[session.id],
                        onRemoteAction: { action, payload in
                            appModel.fire(sessionID: session.id, action: action, payload: payload)
                        },
                        onReloadArtifacts: {
                            appModel.reloadArtifacts(sessionID: session.id)
                        },
                        terminalOutput: Binding(
                            get: { appModel.terminalOutput[session.id] ?? "" },
                            set: { appModel.terminalOutput[session.id] = $0 }
                        ),
                        onTerminalInput: { appModel.sendTerminal(sessionID: session.id, text: $0) },
                        onTerminalResize: { cols, rows in
                            appModel.resizeTerminal(sessionID: session.id, cols: cols, rows: rows)
                        },
                        onTerminalClose: { appModel.closeTerminal(sessionID: session.id) },
                        onTerminalOpen: { appModel.connectTerminal(sessionID: session.id) }
                    )
                    .id(session.id)
                    .onAppear {
                        if appModel.isRemote {
                            appModel.reloadArtifacts(sessionID: session.id)
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "세션을 찾을 수 없어요",
                        systemImage: "bubble.left.and.exclamationmark.bubble.right"
                    )
                }
            }
            .navigationDestination(isPresented: $showsNewSession) {
                NewSessionView(
                    projects: appModel.projects,
                    onCreate: { cwd, thinkingLevel in
                        Task {
                            if let store = await appModel.createSession(cwd: cwd, thinkingLevel: thinkingLevel) {
                                showsNewSession = false
                                path.append(store.sessionID)
                            }
                        }
                    },
                    onBrowse: {
                        Task { await appModel.browse(path: nil) }
                    }
                )
            }
            .sheet(isPresented: $showsSettings) {
                NavigationStack {
                    HostSettingsView(baseURL: $hubURL, connectionText: appModel.connectionText, onSave: saveHubURL)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("닫기") {
                                    showsSettings = false
                                }
                                .accessibilityLabel("설정 닫기")
                            }
                        }
                }
            }
            .overlay {
                if appModel.isLoadingSessions, appModel.sessions.isEmpty {
                    ProgressView("세션을 불러오고 있어요")
                        .padding(18)
                        .rubatoGlass(in: RoundedRectangle(cornerRadius: 18))
                } else if filteredSessions.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .task {
                await appModel.loadSessionsIfNeeded()
                if path.isEmpty,
                   let raw = ProcessInfo.processInfo.environment["RUBATO_OPEN_SESSION"] {
                    let id = UUID(uuidString: raw) ?? RemoteID.uuid(from: raw)
                    if appModel.session(id: id) != nil {
                        path = [id]
                    }
                }
            }
            .alert(
                "문제가 생겼어요",
                isPresented: Binding(
                    get: { appModel.transientError != nil },
                    set: { if !$0 { appModel.transientError = nil } }
                )
            ) {
                Button("확인", role: .cancel) {
                    appModel.transientError = nil
                }
            } message: {
                Text(appModel.transientError ?? "다시 시도해 주세요.")
            }
        }
    }

    private func saveHubURL() {
        Task {
            await appModel.saveHost(urlString: hubURL)
            hubURL = HostSettings.baseURL.absoluteString
        }
    }
}

private struct ConversationRow: View {
    let session: ChatSession

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                Circle()
                    .fill(.primary)
                    .frame(width: 50, height: 50)
                    .overlay {
                        Text("R")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(Color(uiColor: .systemBackground))
                    }

                Circle()
                    .fill(stateColor)
                    .frame(width: 13, height: 13)
                    .overlay { Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2) }
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if session.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text(session.title)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Spacer()
                    Text(DisplayFormatter.relativeDate.localizedString(for: session.updatedAt, relativeTo: .now))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }

                HStack(alignment: .top, spacing: 8) {
                    Text(session.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if session.unreadCount > 0 {
                        Text("\(session.unreadCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(Color.accentColor, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(session.title), \(session.subtitle), \(session.state.displayName)")
        .accessibilityValue(session.unreadCount > 0 ? "읽지 않은 메시지 \(session.unreadCount)개" : "")
    }

    private var stateColor: Color {
        switch session.state {
        case .idle: .secondary
        case .running: .green
        case .waitingForUser: .orange
        case .failed: .red
        }
    }
}
