// Linux/macOS 공통 swiftc로 저장소 상태 로직을 형 검사하기 위한 최소 대체 선언이다.
// Xcode 앱 대상에는 포함되지 않는다.
import Foundation

protocol ObservableObject: AnyObject {}

@propertyWrapper
struct Published<Value> {
    var wrappedValue: Value
    var projectedValue: Published<Value> { self }

    init(wrappedValue: Value) {
        self.wrappedValue = wrappedValue
    }
}

@MainActor
final class AudioRecordingController: ObservableObject {
    func reset() {}
    func finish() async -> VoiceClip? { nil }
    func consumePreparedClip() -> VoiceClip? { nil }
    func cancel() {}
}

@MainActor
final class AudioPlaybackCenter: ObservableObject {
    func stop() {}
}

struct AttachmentFileStore: Sendable {
    func savePhotoData(_ data: Data, suggestedExtension: String = "jpg") throws -> ChatAttachment {
        fatalError("형 검사 전용 대체 선언")
    }

    func importFiles(_ urls: [URL]) throws -> [ChatAttachment] { [] }
}
