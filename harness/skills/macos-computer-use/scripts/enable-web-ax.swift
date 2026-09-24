// Ask a Chromium/Electron app to build its web-content accessibility tree.
// Electron exposes web content to AX only after an assistive client sets
// AXManualAccessibility on the application element (VoiceOver does this).
// Peekaboo does not, so Electron windows look like a few empty groups.
// The flag lasts until the app quits.
import ApplicationServices

guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]) else {
  FileHandle.standardError.write("usage: enable-web-ax.swift <pid>\n".data(using: .utf8)!)
  exit(2)
}
let app = AXUIElementCreateApplication(pid)
let result = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
if result != .success {
  FileHandle.standardError.write("AXManualAccessibility failed for pid \(pid): \(result.rawValue)\n".data(using: .utf8)!)
  exit(1)
}
print("AXManualAccessibility on for pid \(pid)")
