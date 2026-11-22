// Rubato: the Notification Service Extension that turns a companion's message into an iOS
// Communication Notification (sender name and face, the text right away) before it shows.
// @bacons/apple-targets builds this target at prebuild. The Swift beside this file belongs
// to features/companions (NotificationService.swift); it reads each companion's name and
// face from the App Group the app writes, because a locked phone may not reach the Mac.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "notification-service",
  name: "NotificationService",
  bundleIdentifier: ".NotificationService",
  deploymentTarget: "18.0",
  frameworks: ["UserNotifications", "Intents"],
  entitlements: {
    "com.apple.security.application-groups": ["group.com.keepitmello.rubato"],
  },
};
