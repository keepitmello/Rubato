import SwiftUI

struct ChatRoomScreen: View {
    @ObservedObject var store: ChatRoomStore
    @ObservedObject var extrasHolder: RubatoSessionExtras
    var isRemote = false
    var gitView: GitView? = nil
    var onRemoteAction: ((String, [String: Any]) -> Void)? = nil
    var onReloadArtifacts: (() -> Void)? = nil
    var terminalOutput: Binding<String>? = nil
    var onTerminalInput: ((String) -> Void)? = nil
    var onTerminalResize: ((Int, Int) -> Void)? = nil
    var onTerminalClose: (() -> Void)? = nil
    var onTerminalOpen: (() -> Void)? = nil

    private var extras: RubatoSessionExtras.Snapshot? {
        isRemote ? extrasHolder.snapshot(for: store.sessionID) : nil
    }

    @State private var presented: RemoteSurface?
    @State private var localTerminalOutput = ""

    private var showsRemoteChrome: Bool { extras != nil }

    private var terminalText: Binding<String> {
        terminalOutput ?? $localTerminalOutput
    }

    var body: some View {
        ChatCollectionContainer(store: store)
            .ignoresSafeArea(.keyboard, edges: .bottom)
            .navigationTitle(store.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            Task { await store.loadPrevious() }
                        } label: {
                            Label("이전 메시지 불러오기", systemImage: "clock.arrow.circlepath")
                        }
                        .disabled(!store.canLoadPrevious || store.isLoadingPrevious)

                        if showsRemoteChrome {
                            Button {
                                presented = .controls
                            } label: {
                                Label("세션 제어", systemImage: "slider.horizontal.3")
                            }
                            .accessibilityLabel("세션 제어")

                            Button {
                                presented = .artifacts
                            } label: {
                                Label("파일과 변경점", systemImage: "doc.text.magnifyingglass")
                            }
                            .accessibilityLabel("파일과 변경점")

                            Button {
                                presented = .terminal
                            } label: {
                                Label("비상 터미널", systemImage: "terminal")
                            }
                            .accessibilityLabel("비상 터미널")
                        }

                        if store.isResponseActive {
                            Button(role: .destructive) {
                                abortActive()
                            } label: {
                                Label("응답 중단", systemImage: "stop.fill")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("대화 메뉴")
                }
            }
            .overlay(alignment: .top) {
                if let extras, extras.uiRequest == nil, !store.isLoadingInitial, extras.isTerminalOnly {
                    Button {
                        presented = .terminal
                        onTerminalOpen?()
                    } label: {
                        Text("이 세션은 아직 채팅이 안 붙었어요. 여기를 눌러 비상 터미널로 입력하세요.")
                            .font(.footnote)
                            .multilineTextAlignment(.center)
                            .padding(12)
                            .frame(maxWidth: .infinity)
                            .rubatoGlass(in: RoundedRectangle(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("비상 터미널 열기")
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
            }
            .overlay {
                if store.isLoadingInitial {
                    ProgressView("대화를 불러오고 있어요")
                        .padding(18)
                        .rubatoGlass(in: RoundedRectangle(cornerRadius: 18))
                } else if let request = extras?.uiRequest {
                    ZStack {
                        Color.black.opacity(0.38)
                            .ignoresSafeArea()
                            .accessibilityHidden(true)
                        ApprovalCard(request: request) { value in
                            onRemoteAction?("ui.respond", [
                                "requestId": request.requestId,
                                "value": value
                            ])
                        }
                        .padding(20)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("확인이 끝날 때까지 메시지를 보낼 수 없어요")
                }
            }
            .sheet(item: $presented) { surface in
                remoteSheet(surface)
            }
            .task {
                await store.loadInitialIfNeeded()
                if isRemote {
                    store.listenForLiveUpdates()
                    if let prompt = ProcessInfo.processInfo.environment["RUBATO_INJECT_PROMPT"],
                       !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    {
                        store.draftText = prompt
                        store.sendCurrentDraft()
                    }
                    if ProcessInfo.processInfo.environment["RUBATO_OPEN_SHEET"] == "artifacts" {
                        presented = .artifacts
                        onReloadArtifacts?()
                    }
                }
            }
            .alert(
                "문제가 생겼어요",
                isPresented: Binding(
                    get: { store.transientError != nil },
                    set: { if !$0 { store.transientError = nil } }
                )
            ) {
                Button("확인", role: .cancel) {
                    store.transientError = nil
                }
            } message: {
                Text(store.transientError ?? "다시 시도해 주세요.")
            }
    }

    @ViewBuilder
    private func remoteSheet(_ surface: RemoteSurface) -> some View {
        switch surface {
        case .controls:
            SessionControlsSheet(
                sessionTitle: store.title,
                extras: extras ?? RubatoSessionExtras.Snapshot(),
                onAction: { action, payload in
                    onRemoteAction?(action, payload)
                }
            )
            .presentationDetents([.medium, .large])

        case .artifacts:
            ArtifactsSheet(
                git: gitView ?? GitView(files: [], summary: "이 허브 빌드에는 git HTTP가 없어요. 상태와 차이를 불러올 수 없습니다.", diffText: ""),
                images: extras?.images ?? [],
                onReload: { onReloadArtifacts?() }
            )
            .presentationDetents([.medium, .large])

        case .terminal:
            EmergencyTerminalView(
                output: terminalText,
                onInput: { onTerminalInput?($0) },
                onResize: { cols, rows in onTerminalResize?(cols, rows) },
                onClose: {
                    presented = nil
                    onTerminalClose?()
                }
            )
            .onAppear { onTerminalOpen?() }
            .presentationDetents([.large])
        }
    }

    private func abortActive() {
        if let onRemoteAction {
            onRemoteAction("agent.abort", [:])
        } else {
            store.cancelActiveResponse()
        }
    }
}

private enum RemoteSurface: String, Identifiable {
    case controls
    case artifacts
    case terminal

    var id: String { rawValue }
}
