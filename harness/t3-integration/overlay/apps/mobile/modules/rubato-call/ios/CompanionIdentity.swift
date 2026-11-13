import Foundation
import UIKit

/// Each companion's name and face as this phone shows them, kept where the system call screen and
/// the notification service extension can read them without the app's JavaScript or the Mac: the
/// app group's UserDefaults and container. The app writes them whenever it sees the companion list
/// (src/features/companions/companionNames.ts); the person's renames live here too.
enum CompanionIdentity {
  static let appGroup = "group.com.keepitmello.rubato"
  private static let identitiesKey = "rubato.companions"
  private static let renamesKey = "rubato.companionRenames"
  /// Korean names until the person picks their own (user 2026-11-14).
  static let defaultNames = ["roo": "루", "segno": "세뇨"]

  private static var store: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }
  /// Builds may ship before the App Group capability is granted; renames made then live in the
  /// app's own defaults too, so they survive the switch to the shared store.
  private static let local = UserDefaults.standard

  /// The name to show for `companionId`: the person's rename, else what the app last saw, else the default.
  static func name(for companionId: String) -> String? {
    if let renamed = renames()[companionId] { return renamed }
    let identities = store.dictionary(forKey: identitiesKey) as? [String: [String: String]] ?? [:]
    return identities[companionId]?["name"] ?? defaultNames[companionId]
  }

  static func renames() -> [String: String] {
    let mine = local.dictionary(forKey: renamesKey) as? [String: String] ?? [:]
    let shared = store.dictionary(forKey: renamesKey) as? [String: String] ?? [:]
    return mine.merging(shared) { _, sharedName in sharedName }
  }

  /// `name` nil or blank goes back to the default.
  static func setRename(_ companionId: String, _ name: String?) {
    var renames = renames()
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if trimmed.isEmpty { renames[companionId] = nil } else { renames[companionId] = trimmed }
    store.set(renames, forKey: renamesKey)
    local.set(renames, forKey: renamesKey)
  }

  /// Records the name the app shows and the face: `avatar` is the art's image data, or nil to draw the initial.
  static func save(_ companionId: String, name: String, avatar: Data?) {
    var identities = store.dictionary(forKey: identitiesKey) as? [String: [String: String]] ?? [:]
    identities[companionId] = ["name": name]
    store.set(identities, forKey: identitiesKey)
    guard let file = avatarFile(companionId) else { return }
    let image = avatar.flatMap(UIImage.init(data:)).map { square($0, side: 256) } ?? initial(name, side: 256)
    if let png = image.pngData() {
      try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? png.write(to: file, options: .atomic)
    }
  }

  /// The face as a PNG in the app group, or nil when the app has not seen the companion yet.
  static func avatarFile(_ companionId: String) -> URL? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
    let safe = companionId.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
    return container.appendingPathComponent("companions", isDirectory: true).appendingPathComponent("\(safe).png")
  }

  private static func square(_ image: UIImage, side: CGFloat) -> UIImage {
    let scale = max(side / image.size.width, side / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
      image.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
    }
  }

  private static func initial(_ name: String, side: CGFloat) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
      UIColor(white: 0.55, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: side, height: side))
      let letter = String(name.prefix(1)) as NSString
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: side * 0.46, weight: .semibold),
        .foregroundColor: UIColor.white,
      ]
      let size = letter.size(withAttributes: attributes)
      letter.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2), withAttributes: attributes)
    }
  }
}
