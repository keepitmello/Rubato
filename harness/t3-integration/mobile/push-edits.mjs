// Notifications for the Rubato iPhone app through the Rubato push relay (harness/push-relay).
//
//   phone ── tokens ──▶ relay          the APNs and VoIP tokens go only to the relay
//   phone ── grant  ──▶ Mac            minted at the relay per paired Mac, handed over /rubato/push
//   Mac   ── grant + alert/ring ──▶ relay ──▶ APNs ──▶ phone
//
// Server half: the /rubato/push route and the thread-awareness feed (RubatoPush.ts) that hands each
// thread's state to src/push/service.mjs; the call service sends rings itself (push-relay/mac).
// Phone half: features/rubato-push registers the tokens and grants; App.tsx mounts RubatoPushHost.
export const mobilePushOverlays = [
  'apps/server/src/RubatoPush.ts',
  'apps/mobile/src/features/rubato-push/config.ts',
  'apps/mobile/src/features/rubato-push/sync.ts',
  'apps/mobile/src/features/rubato-push/sync.test.ts',
  'apps/mobile/src/features/rubato-push/RubatoPushHost.tsx',
  'apps/mobile/src/features/rubato-push/index.ts',
  'apps/mobile/src/features/rubato-push/storage.ts',
  'apps/mobile/src/features/rubato-push/deps.ts',
  'apps/mobile/src/features/rubato-push/RubatoNotificationsSettings.tsx',
];

export const mobilePushEdits = {
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
      + '      <SettingsScreen title="Notifications">\n'
      + '        <ScrollView\n'
      + '          contentInsetAdjustmentBehavior="automatic"\n'
      + '          contentContainerClassName="px-5 pt-4"\n'
      + '        >\n'
      + '          <Text className="text-base text-foreground-muted">\n'
      + '            Notifications require T3 Connect in this app build.\n'
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
