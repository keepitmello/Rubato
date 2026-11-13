import Intents
import UserNotifications

/// A companion's message as a messenger's notification (user f38fd3c2): the companion's name and
/// face as the sender, the words right away. iOS draws that look for a Communication
/// Notification, so the push is turned into an incoming INSendMessageIntent before it shows.
///
/// The phone may be locked and off the tailnet now, so the name and face come from what the app
/// left in the app group (modules/rubato-call ios/CompanionIdentity.swift writes them; the keys
/// and the file layout here must match it). Any other push passes through unchanged.
final class NotificationService: UNNotificationServiceExtension {
  private static let appGroup = "group.com.keepitmello.rubato"
  private static let defaultNames = ["roo": "루", "segno": "세뇨"]

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    fallback = request.content
    let rubato = request.content.userInfo["rubato"] as? [String: Any]
    guard (rubato?["kind"] as? String) == "companion-message", let companionId = rubato?["companionId"] as? String,
          let content = request.content.mutableCopy() as? UNMutableNotificationContent
    else {
      contentHandler(request.content)
      return
    }
    let name = Self.name(for: companionId) ?? content.title
    let image = Self.avatar(for: companionId).map { INImage(imageData: $0) }
    let sender = INPerson(
      personHandle: INPersonHandle(value: "rubato-companion:\(companionId)", type: .unknown),
      nameComponents: nil,
      displayName: name,
      image: image,
      contactIdentifier: nil,
      customIdentifier: "companion:\(companionId)"
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: content.body,
      speakableGroupName: nil,
      conversationIdentifier: "companion:\(companionId)",
      serviceName: "Rubato",
      sender: sender,
      attachments: nil
    )
    if let image { intent.setImage(image, forParameterNamed: \.sender) }
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { _ in
      content.title = name
      if let updated = try? content.updating(from: intent) { contentHandler(updated) } else { contentHandler(content) }
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let fallback { contentHandler(fallback) }
  }

  /// The person's rename, else the name the app last showed, else the Korean default.
  private static func name(for companionId: String) -> String? {
    let store = UserDefaults(suiteName: appGroup)
    if let renamed = (store?.dictionary(forKey: "rubato.companionRenames") as? [String: String])?[companionId] { return renamed }
    let identities = store?.dictionary(forKey: "rubato.companions") as? [String: [String: String]]
    return identities?[companionId]?["name"] ?? defaultNames[companionId]
  }

  private static func avatar(for companionId: String) -> Data? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    let safe = companionId.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
    return try? Data(contentsOf: container.appendingPathComponent("companions", isDirectory: true).appendingPathComponent("\(safe).png"))
  }
}
