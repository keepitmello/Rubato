import ExpoModulesCore
import UIKit

/// Registers for VoIP pushes as the app launches. iOS may launch the app only to deliver one, before
/// any JavaScript runs, and the push must reach CallKit then (RubatoCallCenter).
public final class RubatoCallAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    RubatoCallCenter.shared.start()
    return true
  }
}
