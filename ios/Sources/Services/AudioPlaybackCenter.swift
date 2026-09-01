// Adapted from Exyte/Chat's RecordingPlayer.swift under the MIT License.
// See ThirdPartyNotices/ExyteChat-LICENSE.txt.

@preconcurrency import AVFoundation
import Foundation
#if canImport(Combine)
import Combine
#endif

@MainActor
final class AudioPlaybackCenter: ObservableObject {
    @Published private(set) var activeClipID: UUID?
    @Published private(set) var isPlaying = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var secondsLeft: TimeInterval = 0

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var activeClip: VoiceClip?

    isolated deinit {
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
    }

    func isActive(_ clip: VoiceClip) -> Bool {
        activeClipID == clip.id
    }

    func isPlaying(_ clip: VoiceClip) -> Bool {
        activeClipID == clip.id && isPlaying
    }

    func toggle(_ clip: VoiceClip) {
        if activeClip?.id != clip.id {
            configure(for: clip)
        }

        guard let player else { return }
        if isPlaying(clip) {
            player.pause()
            isPlaying = false
        } else {
            activatePlaybackSession()
            player.play()
            activeClipID = clip.id
            isPlaying = true
        }
    }

    func seek(_ clip: VoiceClip, to progress: Double) {
        if activeClip?.id != clip.id {
            configure(for: clip)
        }
        let clamped = min(max(progress, 0), 1)
        player?.seek(to: CMTime(seconds: clip.duration * clamped, preferredTimescale: 600))
        activatePlaybackSession()
        player?.play()
        activeClipID = clip.id
        isPlaying = true
    }

    func stop() {
        player?.pause()
        player?.seek(to: .zero)
        activeClipID = nil
        isPlaying = false
        progress = 0
        secondsLeft = activeClip?.duration ?? 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func configure(for clip: VoiceClip) {
        player?.pause()
        isPlaying = false
        if let timeObserver {
            player?.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }

        activeClip = clip
        activeClipID = clip.id
        progress = 0
        secondsLeft = clip.duration

        let item = AVPlayerItem(url: clip.localURL)
        let player = AVPlayer(playerItem: item)
        self.player = player

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.1, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                guard let self, let clip = self.activeClip, clip.duration > 0 else { return }
                let value = min(max(time.seconds / clip.duration, 0), 1)
                self.progress = value.isFinite ? value : 0
                self.secondsLeft = max(0, clip.duration - time.seconds)
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.isPlaying = false
                self.progress = 0
                self.secondsLeft = clip.duration
                self.player?.seek(to: .zero)
            }
        }
    }

    private func activatePlaybackSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}
