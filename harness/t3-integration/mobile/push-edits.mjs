// Notifications for the Rubato iPhone app through the Rubato push relay (harness/push-relay).
//
//   phone ── tokens ──▶ relay          the APNs and VoIP tokens go only to the relay
//   phone ── grant  ──▶ Mac            minted at the relay per paired Mac, handed over /rubato/push
//   Mac   ── grant + alert/ring ──▶ relay ──▶ APNs ──▶ phone
//
// Server half: the /rubato/push route and the thread-awareness feed (RubatoPush.ts) that hands each
// thread's state to src/push/service.mjs; the call service sends rings itself (push-relay/mac).
// Phone half: features/rubato-push registers the tokens and grants; App.tsx mounts RubatoPushHost.
// Thread alerts ring with the desktop's chimes, kept on the phone (sounds.ts). The Live Activity card
// (upstream's AgentActivity widget) is opened by the phone and kept current by the Mac (liveActivity.ts).
export const mobilePushOverlays = [
  'apps/server/src/RubatoPush.ts',
  'apps/mobile/src/features/rubato-push/config.ts',
  'apps/mobile/src/features/rubato-push/sync.ts',
  'apps/mobile/src/features/rubato-push/sync.test.ts',
  'apps/mobile/src/features/rubato-push/syncQueue.ts',
  'apps/mobile/src/features/rubato-push/syncQueue.test.ts',
  'apps/mobile/src/features/rubato-push/RubatoPushHost.tsx',
  'apps/mobile/src/features/rubato-push/index.ts',
  'apps/mobile/src/features/rubato-push/storage.ts',
  'apps/mobile/src/features/rubato-push/deps.ts',
  'apps/mobile/src/features/rubato-push/RubatoNotificationsSettings.tsx',
  'apps/mobile/src/features/rubato-push/builtinSounds.ts',
  'apps/mobile/src/features/rubato-push/sounds.ts',
  'apps/mobile/src/features/rubato-push/sounds.test.ts',
  'apps/mobile/src/features/rubato-push/soundFolder.ts',
  'apps/mobile/src/features/rubato-push/liveActivity.ts',
  'apps/mobile/src/features/rubato-push/liveActivity.test.ts',
];

export const mobilePushEdits = {
  // Upstream's own Live Activity code waits for T3's relay, which this app does not carry. Starting
  // work from the phone opens Rubato's card instead (liveActivity.ts), and upstream's "signed out of
  // T3" cleanup, which runs on every launch here, leaves Rubato's cards alone.
  'apps/mobile/src/features/agent-awareness/remoteRegistration.ts': [
    ['import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";\n',
      'import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";\nimport { requestLiveActivitySync } from "../rubato-push/liveActivity";\n', 'replace'],
    ['}): void {\n  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {\n    return;\n  }\n  if (!environmentPublishesAgentActivity(input.environmentId)) {',
      '}): void {\n  requestLiveActivitySync();\n  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {\n    return;\n  }\n  if (!environmentPublishesAgentActivity(input.environmentId)) {', 'replace'],
    ['    endLocalLiveActivities("live activity cleanup after cloud sign-out failed");\n',
      '    if (readRelayConfig()) endLocalLiveActivities("live activity cleanup after cloud sign-out failed");\n', 'replace'],
  ],
  // T3's sign-out test, in a build that carries T3's relay: only there does the cleanup run.
  'apps/mobile/src/features/agent-awareness/remoteRegistration.test.ts': [
    ["  it(\"ends local Live Activities and stops foreground reconciliation on cloud sign-out\", () => {\n",
      "  it(\"ends local Live Activities and stops foreground reconciliation on cloud sign-out\", () => {\n    // Rubato: the cleanup belongs to T3's relay (push-edits.mjs), so this build carries one.\n    const extra = Constants.expoConfig!.extra!;\n    extra.relay = { url: \"https://relay.example.com\" };\n", 'replace'],
    ["    expect(appStateMock.listeners).toHaveLength(0);\n  });\n\n  it.effect(\"registers the APNs device when cloud auth becomes available\"",
      "    expect(appStateMock.listeners).toHaveLength(0);\n    delete extra.relay;\n  });\n\n  it.effect(\"registers the APNs device when cloud auth becomes available\"", 'replace'],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoPushLayer } from "./RubatoPush.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoPushLayer,\n'],
  ],
  // Settings > Notifications: T3's screen needs T3 Connect, which this app does not carry.
  'apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx': [
    ['import { SettingsRow } from "./components/SettingsRow";\n',
      'import { RubatoNotificationsSettings } from "../rubato-push/RubatoNotificationsSettings";\n'],
    ['  if (!hasCloudPublicConfig()) {\n'
      + '    return (\n'
      + '      <SettingsScreen title={gt("Notifications")}>\n'
      + '        <ScrollView\n'
      + '          contentInsetAdjustmentBehavior="automatic"\n'
      + '          contentContainerClassName="px-5 pt-4"\n'
      + '        >\n'
      + '          <Text className="text-base text-foreground-muted">\n'
      + '            {gt("Notifications require {product} in this app build.", { product: "T3 Connect" })}\n'
      + '          </Text>\n'
      + '        </ScrollView>\n'
      + '      </SettingsScreen>\n'
      + '    );\n'
      + '  }\n',
      '  // Rubato: notifications come through the Rubato relay (features/rubato-push, push-edits.mjs).\n'
        + '  if (!hasCloudPublicConfig()) return <RubatoNotificationsSettings />;\n',
      'replace'],
  ],
};
