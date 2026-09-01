import SwiftUI

// Visual structure follows Exyte/Chat's recording and playback controls.
struct AudioMessageView: View {
    let clip: VoiceClip
    let isCurrentUser: Bool
    @ObservedObject var playback: AudioPlaybackCenter

    private var isPlaying: Bool { playback.isPlaying(clip) }
    private var shownProgress: Double { playback.isActive(clip) ? playback.progress : 0 }
    private var shownSeconds: TimeInterval {
        playback.isActive(clip) ? playback.secondsLeft : clip.duration
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                playback.toggle(clip)
            } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 32, height: 32)
                    .background(.primary.opacity(0.1), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isPlaying ? "음성 일시정지" : "음성 재생")

            WaveformView(
                samples: clip.waveformSamples,
                progress: shownProgress,
                activeColor: isCurrentUser ? .white : .primary,
                inactiveColor: isCurrentUser ? .white.opacity(0.42) : .secondary.opacity(0.45),
                onSeek: { playback.seek(clip, to: $0) }
            )
            .frame(height: 28)
            .accessibilityHidden(true)

            Text(DisplayFormatter.duration(shownSeconds))
                .font(.caption2.monospacedDigit())
                .opacity(0.72)
                .frame(minWidth: 34, alignment: .trailing)
        }
        .foregroundStyle(isCurrentUser ? Color.white : Color.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(minWidth: 210)
    }
}

struct WaveformView: View {
    let samples: [Float]
    var progress: Double = 0
    var activeColor: Color = .primary
    var inactiveColor: Color = .secondary.opacity(0.45)
    var onSeek: ((Double) -> Void)?

    init(
        samples: [Float],
        progress: Double = 0,
        activeColor: Color = .primary,
        inactiveColor: Color = .secondary.opacity(0.45),
        onSeek: ((Double) -> Void)? = nil
    ) {
        self.samples = samples
        self.progress = progress
        self.activeColor = activeColor
        self.inactiveColor = inactiveColor
        self.onSeek = onSeek
    }

    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                let prepared = downsample(samples.isEmpty ? Array(repeating: 0.35, count: 32) : samples, count: 40)
                let spacing = size.width / CGFloat(max(prepared.count, 1))
                let completedWidth = size.width * progress

                for (index, sample) in prepared.enumerated() {
                    let x = CGFloat(index) * spacing + spacing / 2
                    let height = max(3, size.height * CGFloat(max(0.08, min(sample, 1))))
                    var path = Path()
                    path.move(to: CGPoint(x: x, y: (size.height - height) / 2))
                    path.addLine(to: CGPoint(x: x, y: (size.height + height) / 2))
                    let shade = x <= completedWidth ? activeColor : inactiveColor
                    context.stroke(path, with: .color(shade), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onEnded { value in
                        guard let onSeek, geometry.size.width > 0 else { return }
                        onSeek(min(max(value.location.x / geometry.size.width, 0), 1))
                    }
            )
        }
    }

    private func downsample(_ source: [Float], count: Int) -> [Float] {
        guard source.count > count else { return source }
        let step = Double(source.count) / Double(count)
        return (0..<count).map { index in
            let start = Int(Double(index) * step)
            let end = min(source.count, Int(Double(index + 1) * step))
            return source[start..<max(start + 1, end)].max() ?? 0.1
        }
    }
}
