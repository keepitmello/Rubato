import SwiftUI

struct HostSettingsView: View {
    @Binding var baseURL: String
    var connectionText: String
    var onSave: () -> Void

    var body: some View {
        Form {
            Section {
                hostCard
            } header: {
                Text("이 Mac")
            } footer: {
                Text("이 앱은 한 대의 Mac만 연결해요. 허브 주소만 바꾸면 됩니다.")
            }

            Section {
                TextField("허브 URL", text: $baseURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityLabel("허브 URL")

                LabeledContent("연결") {
                    Text(connectionText)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("연결 상태, \(connectionText)")

                Button("주소 저장", action: onSave)
                    .accessibilityLabel("허브 주소 저장")
            } header: {
                Text("허브")
            } footer: {
                Text("기본 주소는 \(HostSettings.defaultBaseURL.absoluteString) 이에요.")
            }

            Section {
                LabeledContent("알림") {
                    Text("지원 안 함")
                        .foregroundStyle(.secondary)
                }
                Text("iOS에는 웹 푸시(VAPID)가 없어요. 작업 완료·확인 요청 알림은 이 앱에서 등록하지 않아요.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("푸시 알림은 iOS에서 지원하지 않아요")
            } header: {
                Text("알림")
            }

            Section {
                LabeledContent("모양") {
                    Text("시스템 설정")
                        .foregroundStyle(.secondary)
                }
                Text("밝은 화면과 어두운 화면은 iPhone 설정을 따르고, 유리 효과는 시스템 투명도를 사용해요.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } header: {
                Text("화면")
            }
        }
        .navigationTitle("설정")
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
                    .textSelection(.enabled)
            }

            Spacer()

            Text("하나")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("연결된 Mac, 이 Mac, \(HostSettings.origin)")
    }
}
