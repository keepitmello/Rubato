// Adapted from Exyte/Chat's Recorder.swift under the MIT License.
// See ThirdPartyNotices/ExyteChat-LICENSE.txt.

@preconcurrency import AVFoundation
import Foundation
#if canImport(Combine)
import Combine
#endif

struct AudioRecorderSettings: Hashable, Sendable {
    var audioFormatID: AudioFormatID = kAudioFormatMPEG4AAC
    var sampleRate: Double = 12_000
    var numberOfChannels: Int = 1
    var encoderBitRate: Int = 64_000
}

actor AudioRecorder {
    typealias ProgressHandler = @Sendable (TimeInterval, [Float]) -> Void

    private let audioSession = AVAudioSession.sharedInstance()
    private var audioRecorder: AVAudioRecorder?
    private var meteringTask: Task<Void, Never>?
    private var waveformSamples: [Float] = []
    private let settings: AudioRecorderSettings

    init(settings: AudioRecorderSettings = .init()) {
        self.settings = settings
    }

    func start(progress: @escaping ProgressHandler) async -> URL? {
        let permission = AVAudioApplication.shared.recordPermission
        if permission != .granted {
            let granted = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
            guard granted else { return nil }
        }

        return startInternal(progress: progress)
    }

    func stop(deleteFile: Bool = false) -> (url: URL?, duration: TimeInterval, samples: [Float]) {
        let url = audioRecorder?.url
        let duration = audioRecorder?.currentTime ?? 0
        audioRecorder?.stop()
        audioRecorder = nil
        meteringTask?.cancel()
        meteringTask = nil

        if deleteFile, let url {
            try? FileManager.default.removeItem(at: url)
        }

        let resultURL = deleteFile ? nil : url
        let samples = waveformSamples
        waveformSamples = []
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        return (resultURL, duration, samples)
    }

    private func startInternal(progress: @escaping ProgressHandler) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("rubato-recording-\(UUID().uuidString)")
            .appendingPathExtension("m4a")

        let recorderSettings: [String: Any] = [
            AVFormatIDKey: Int(settings.audioFormatID),
            AVSampleRateKey: settings.sampleRate,
            AVNumberOfChannelsKey: settings.numberOfChannels,
            AVEncoderBitRateKey: settings.encoderBitRate,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        do {
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetoothHFP]
            )
            try audioSession.setAllowHapticsAndSystemSoundsDuringRecording(true)
            try audioSession.setActive(true)

            let recorder = try AVAudioRecorder(url: url, settings: recorderSettings)
            recorder.isMeteringEnabled = true
            guard recorder.prepareToRecord(), recorder.record() else {
                try? FileManager.default.removeItem(at: url)
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                return nil
            }

            audioRecorder = recorder
            waveformSamples = []
            progress(0, [])

            meteringTask?.cancel()
            meteringTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(50))
                    guard !Task.isCancelled else { break }
                    await self?.sample(progress: progress)
                }
            }
            return url
        } catch {
            _ = stop(deleteFile: true)
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    private func sample(progress: @escaping ProgressHandler) {
        guard let audioRecorder else { return }
        audioRecorder.updateMeters()
        let power = audioRecorder.averagePower(forChannel: 0)
        let normalized = max(0.04, min(1, 1 - abs(max(power, -60)) / 60))
        waveformSamples.append(normalized)
        if waveformSamples.count > 1_200 {
            waveformSamples.removeFirst(waveformSamples.count - 1_200)
        }
        progress(audioRecorder.currentTime, waveformSamples)
    }
}

@MainActor
final class AudioRecordingController: ObservableObject {
    enum State: Equatable {
        case idle
        case requestingPermission
        case recordingHold
        case recordingLocked
        case ready
        case failed(String)

        var isRecording: Bool {
            switch self {
            case .recordingHold, .recordingLocked: true
            default: false
            }
        }
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var waveformSamples: [Float] = []
    @Published private(set) var preparedClip: VoiceClip?

    private let recorder = AudioRecorder()
    private var startTask: Task<Void, Never>?

    func beginHoldRecording() {
        switch state {
        case .idle:
            break
        case .failed:
            reset()
        default:
            return
        }

        state = .requestingPermission
        startTask?.cancel()
        startTask = Task { [weak self] in
            guard let self else { return }
            let url = await recorder.start { duration, samples in
                Task { @MainActor [weak self] in
                    self?.duration = duration
                    self?.waveformSamples = samples
                }
            }

            guard !Task.isCancelled else {
                _ = await recorder.stop(deleteFile: true)
                return
            }

            guard url != nil else {
                state = .failed("마이크 권한을 허용해야 음성을 녹음할 수 있어요.")
                return
            }
            state = .recordingHold
        }
    }

    func beginTapRecording() {
        beginHoldRecording()
        Task { @MainActor [weak self] in
            guard let self else { return }
            await startTask?.value
            if state == .recordingHold {
                state = .recordingLocked
            }
        }
    }

    func lockRecording() {
        guard state == .recordingHold else { return }
        state = .recordingLocked
    }

    func finish() async -> VoiceClip? {
        await startTask?.value
        guard state.isRecording else { return preparedClip }

        let result = await recorder.stop()
        guard let url = result.url, result.duration > 0.1 else {
            if let url = result.url {
                try? FileManager.default.removeItem(at: url)
            }
            reset()
            return nil
        }

        let clip = VoiceClip(
            localURL: url,
            duration: result.duration,
            waveformSamples: result.samples
        )
        preparedClip = clip
        duration = result.duration
        waveformSamples = result.samples
        state = .ready
        return clip
    }

    func cancel() {
        startTask?.cancel()
        startTask = nil
        Task { [recorder] in
            _ = await recorder.stop(deleteFile: true)
        }
        reset()
    }

    func consumePreparedClip() -> VoiceClip? {
        let clip = preparedClip
        reset()
        return clip
    }

    func reset() {
        state = .idle
        duration = 0
        waveformSamples = []
        preparedClip = nil
    }
}
