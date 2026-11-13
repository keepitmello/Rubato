import AVFoundation
import CallKit
import PushKit
import UIKit

/// The phone side of companion calls: one PushKit registry and one CallKit provider for the app's life.
///
/// A companion's call reaches a locked phone as a VoIP push (sent by the Mac through the Rubato push
/// relay, payload `{ rubato: { kind, callId, uuid, companion, title, reason, ringUntil } }`). Apple
/// ends an app that does not report every VoIP push to CallKit, so it is reported here, natively and
/// at once, before any JavaScript could answer. What the person then does (answer, end, mute) goes to
/// JavaScript as events, which talks to the Mac and carries the audio over LiveKit
/// (src/features/companions/callStore.ts). Events that happen before JavaScript listens wait in order.
final class RubatoCallCenter: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = RubatoCallCenter()

  private var registry: PKPushRegistry?
  private let provider: CXProvider
  private let controller = CXCallController()
  private(set) var voipToken: String?
  /// What CallKit shows now, by CallKit UUID: the push's fields plus `uuid` and `state`.
  private var calls: [UUID: [String: Any]] = [:]
  private var waiting: [(String, [String: Any])] = []
  var emit: ((String, [String: Any]) -> Void)? {
    didSet {
      guard let emit else { return }
      let held = waiting
      waiting.removeAll()
      for (name, body) in held { emit(name, body) }
    }
  }

  override init() {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = true
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  func start() {
    guard registry == nil else { return }
    let registry = PKPushRegistry(queue: .main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    self.registry = registry
  }

  private func send(_ name: String, _ body: [String: Any]) {
    DispatchQueue.main.async {
      if let emit = self.emit { emit(name, body) } else { self.waiting.append((name, body)) }
    }
  }

  // MARK: PushKit

  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    let token = credentials.token.map { String(format: "%02x", $0) }.joined()
    voipToken = token
    send("voipToken", ["token": token])
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    voipToken = nil
    send("voipToken", ["token": NSNull()])
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    var ring = payload.dictionaryPayload["rubato"] as? [String: Any] ?? [:]
    let uuid = (ring["uuid"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
    ring["uuid"] = uuid.uuidString.lowercased()
    let ringUntil = (ring["ringUntil"] as? NSNumber)?.doubleValue
    let late = ringUntil.map { $0 / 1000 <= Date().timeIntervalSince1970 } ?? false
    reportIncoming(uuid: uuid, info: ring) { [weak self] reported in
      // A push that arrives after the ring was over still has to be reported; it ends at once.
      if reported && late { self?.endCall(uuid: uuid, reason: .unanswered) }
      completion()
    }
  }

  // MARK: Calls

  /// Shows a companion's call on the phone. `done(true)` once CallKit shows it, also when it already did.
  func reportIncoming(uuid: UUID, info: [String: Any], done: ((Bool) -> Void)? = nil) {
    let title = (info["title"] as? String) ?? (info["companion"] as? String) ?? "Rubato"
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: (info["companion"] as? String) ?? title)
    update.localizedCallerName = title
    update.hasVideo = false
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    var call = info
    call["uuid"] = uuid.uuidString.lowercased()
    call["state"] = "ringing"
    let known = calls[uuid] != nil
    if !known { calls[uuid] = call }
    provider.reportNewIncomingCall(with: uuid, update: update) { error in
      DispatchQueue.main.async {
        let already = (error as? CXErrorCodeIncomingCallError)?.code == .callUUIDAlreadyExists
        if let error, !already {
          if !known { self.calls[uuid] = nil }
          self.send("error", ["uuid": call["uuid"] ?? "", "message": error.localizedDescription])
          done?(false)
          return
        }
        if !known && !already {
          self.send("incoming", call)
          self.stopRinging(uuid: uuid, at: (call["ringUntil"] as? NSNumber)?.doubleValue)
        }
        done?(true)
      }
    }
  }

  /// A ring nobody answered stops when the Mac counts it missed, even if JavaScript never runs.
  private func stopRinging(uuid: UUID, at ringUntil: Double?) {
    let seconds = ringUntil.map { $0 / 1000 - Date().timeIntervalSince1970 } ?? 45
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, seconds) + 1) {
      if self.calls[uuid]?["state"] as? String == "ringing" { self.endCall(uuid: uuid, reason: .unanswered) }
    }
  }

  /// The person calls a companion: CallKit shows it as an outgoing call and takes the audio.
  func startOutgoing(uuid: UUID, info: [String: Any], done: @escaping (Error?) -> Void) {
    let title = (info["title"] as? String) ?? (info["companion"] as? String) ?? "Rubato"
    var call = info
    call["uuid"] = uuid.uuidString.lowercased()
    call["state"] = "connecting"
    calls[uuid] = call
    let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: (info["companion"] as? String) ?? title))
    action.contactIdentifier = title
    controller.request(CXTransaction(action: action)) { error in
      DispatchQueue.main.async {
        if error != nil { self.calls[uuid] = nil }
        else {
          let update = CXCallUpdate()
          update.localizedCallerName = title
          update.remoteHandle = action.handle
          self.provider.reportCall(with: uuid, updated: update)
        }
        done(error)
      }
    }
  }

  func reportConnected(uuid: UUID) {
    guard var call = calls[uuid] else { return }
    if (call["direction"] as? String) == "outgoing" || call["state"] as? String == "connecting" {
      provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }
    call["state"] = "active"
    calls[uuid] = call
  }

  /// Ends a call CallKit shows because of something that happened elsewhere (the Mac or LiveKit).
  func endCall(uuid: UUID, reason: CXCallEndedReason) {
    guard calls[uuid] != nil else { return }
    calls[uuid] = nil
    provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
  }

  /// Hangs up from inside the app: the same as the person pressing end on the system's call screen.
  func requestEnd(uuid: UUID) {
    guard calls[uuid] != nil else { return }
    controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { error in
      if error != nil { DispatchQueue.main.async { self.endCall(uuid: uuid, reason: .remoteEnded) } }
    }
  }

  func requestMute(uuid: UUID, muted: Bool) {
    guard calls[uuid] != nil else { return }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
  }

  func activeCalls() -> [[String: Any]] { Array(calls.values) }

  /// Sends call audio to the loudspeaker or back to the receiver.
  func setSpeaker(_ on: Bool) {
    try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
  }

  // MARK: CallKit

  func providerDidReset(_ provider: CXProvider) {
    for uuid in calls.keys { send("end", ["uuid": uuid.uuidString.lowercased(), "by": "system"]) }
    calls.removeAll()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    configure(AVAudioSession.sharedInstance())
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard var call = calls[action.callUUID] else { action.fail(); return }
    configure(AVAudioSession.sharedInstance())
    call["state"] = "answering"
    calls[action.callUUID] = call
    action.fulfill()
    send("answer", call)
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    let call = calls.removeValue(forKey: action.callUUID) ?? ["uuid": action.callUUID.uuidString.lowercased()]
    action.fulfill()
    var body = call
    body["by"] = "person"
    send("end", body)
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    action.fulfill()
    send("mute", ["uuid": action.callUUID.uuidString.lowercased(), "muted": action.isMuted])
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    action.fail()
  }

  // LiveKit's audio engine configures and activates the session itself; CallKit's own activation
  // only has to reach WebRTC (LiveKit react-native README, "Background Processing").
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    webRTCAudioSession()?.perform(NSSelectorFromString("audioSessionDidActivate:"), with: audioSession)
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    webRTCAudioSession()?.perform(NSSelectorFromString("audioSessionDidDeactivate:"), with: audioSession)
  }

  // MARK: Audio

  private func configure(_ session: AVAudioSession) {
    try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP])
  }

  /// WebRTC's shared audio session, found by name so this module does not link WebRTC itself.
  /// LiveKit's WebRTC build names it LKRTCAudioSession; a plain WebRTC build, RTCAudioSession.
  private func webRTCAudioSession() -> NSObject? {
    for name in ["LKRTCAudioSession", "RTCAudioSession"] {
      guard let type = NSClassFromString(name) as? NSObject.Type else { continue }
      let selector = NSSelectorFromString("sharedInstance")
      guard type.responds(to: selector) else { continue }
      return type.perform(selector)?.takeUnretainedValue() as? NSObject
    }
    return nil
  }
}

extension CXCallEndedReason {
  init(name: String) {
    switch name {
    case "answeredElsewhere": self = .answeredElsewhere
    case "declinedElsewhere": self = .declinedElsewhere
    case "unanswered": self = .unanswered
    case "failed": self = .failed
    default: self = .remoteEnded
    }
  }
}
