import CallKit
import ExpoModulesCore

/// The JavaScript face of RubatoCallCenter. The push relay's registration reads `getVoipToken` and
/// the `voipToken` event; the companion screens drive the rest (src/features/companions/callStore.ts).
public final class RubatoCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RubatoCall")

    Events("voipToken", "incoming", "answer", "end", "mute", "error")

    OnStartObserving {
      RubatoCallCenter.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
    }

    OnStopObserving {
      RubatoCallCenter.shared.emit = nil
    }

    /// The PushKit VoIP token as hex, or null until iOS has given one.
    Function("getVoipToken") { () -> String? in
      RubatoCallCenter.shared.voipToken
    }

    /// Calls CallKit shows now, e.g. one answered on the lock screen before the app's JavaScript ran.
    Function("activeCalls") { () -> [[String: Any]] in
      RubatoCallCenter.shared.activeCalls()
    }

    AsyncFunction("reportIncomingCall") { (info: [String: Any], promise: Promise) in
      guard let uuid = (info["uuid"] as? String).flatMap(UUID.init(uuidString:)) else {
        promise.reject("ERR_RUBATO_CALL_UUID", "The call has no CallKit uuid.")
        return
      }
      DispatchQueue.main.async {
        RubatoCallCenter.shared.reportIncoming(uuid: uuid, info: info) { reported in promise.resolve(reported) }
      }
    }

    AsyncFunction("startOutgoingCall") { (info: [String: Any], promise: Promise) in
      guard let uuid = (info["uuid"] as? String).flatMap(UUID.init(uuidString:)) else {
        promise.reject("ERR_RUBATO_CALL_UUID", "The call has no CallKit uuid.")
        return
      }
      DispatchQueue.main.async {
        RubatoCallCenter.shared.startOutgoing(uuid: uuid, info: info) { error in
          if let error { promise.reject("ERR_RUBATO_CALL_START", error.localizedDescription) } else { promise.resolve(nil) }
        }
      }
    }

    Function("reportConnected") { (uuid: String) in
      guard let id = UUID(uuidString: uuid) else { return }
      DispatchQueue.main.async { RubatoCallCenter.shared.reportConnected(uuid: id) }
    }

    /// `reason`: answeredElsewhere, declinedElsewhere, unanswered, failed or remoteEnded.
    Function("endCall") { (uuid: String, reason: String) in
      guard let id = UUID(uuidString: uuid) else { return }
      DispatchQueue.main.async { RubatoCallCenter.shared.endCall(uuid: id, reason: CXCallEndedReason(name: reason)) }
    }

    Function("requestEnd") { (uuid: String) in
      guard let id = UUID(uuidString: uuid) else { return }
      DispatchQueue.main.async { RubatoCallCenter.shared.requestEnd(uuid: id) }
    }

    Function("setMuted") { (uuid: String, muted: Bool) in
      guard let id = UUID(uuidString: uuid) else { return }
      DispatchQueue.main.async { RubatoCallCenter.shared.requestMute(uuid: id, muted: muted) }
    }

    Function("setSpeaker") { (on: Bool) in
      DispatchQueue.main.async { RubatoCallCenter.shared.setSpeaker(on) }
    }

    Function("setAudioWithoutCallKit") { (on: Bool) in
      DispatchQueue.main.async { RubatoCallCenter.shared.setAudioWithoutCallKit(on) }
    }
  }
}
