// Settings > Phone. The page, its route and its server route are ours; the edits
// below only register them: a nav entry and search item, a device-only page, the
// route in the generated tree, and the HTTP route on the server. The server half
// links this Mac to T3's relay so the T3 app on a phone gets notifications.
//
// A phone paired on a server before T3 split its permissions reads files again
// (RubatoLegacyGrants.ts): every verified session passes through it.
export const phoneOverlays = [
  'apps/server/src/RubatoLegacyGrants.ts',
  'apps/server/src/RubatoLegacyGrants.test.ts',
  'apps/server/src/RubatoPhone.ts',
  'apps/web/src/state/rubatoPhone.ts',
  'apps/web/src/components/settings/RubatoPhoneSettings.tsx',
  'apps/web/src/routes/settings.phone.tsx',
];

export const phoneEdits = {
  'apps/server/src/auth/SessionStore.ts': [
    ['import * as ServerSecretStore from "./ServerSecretStore.ts";\n',
      'import { restoreLegacyFileRead } from "../RubatoLegacyGrants.ts";\n'],
    ['    verify,\n    issueWebSocketToken,\n    verifyWebSocketToken,\n',
      '    // Rubato: an old-only grant reads files again (RubatoLegacyGrants.ts, phone-edits.mjs).\n'
        + '    verify: (token) => Effect.map(verify(token), restoreLegacyFileRead),\n'
        + '    issueWebSocketToken,\n'
        + '    verifyWebSocketToken: (token) => Effect.map(verifyWebSocketToken(token), restoreLegacyFileRead),\n',
      'replace'],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoPhoneRouteLayer } from "./RubatoPhone.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoPhoneRouteLayer,\n'],
  ],
  // T3 never widens a recorded grant; Rubato gives an old server's grant file reading back.
  'apps/server/src/auth/SessionStore.test.ts': [
    ['      expect((yield* sessions.verify(issued.token)).scopes).toEqual(legacyScopes);\n'
      + '      expect((yield* sessions.verify(legacyToken)).scopes).toEqual(legacyScopes);\n',
      '      // Rubato: an old server\'s grant reads files again, and nothing more (RubatoLegacyGrants.ts).\n'
        + '      const rubatoRestored = [...legacyScopes, "filesystem:read"];\n'
        + '      expect((yield* sessions.verify(issued.token)).scopes).toEqual(rubatoRestored);\n'
        + '      expect((yield* sessions.verify(legacyToken)).scopes).toEqual(rubatoRestored);\n',
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/scheduled"\n', '  | "/settings/scheduled"\n  | "/settings/phone"\n', 'replace'],
    ['  "/settings/scheduled": "Scheduled Tasks",\n', '  "/settings/scheduled": "Scheduled Tasks",\n  "/settings/phone": "Phone",\n', 'replace'],
    ['  "/settings/scheduled": null,\n', '  "/settings/scheduled": null,\n  "/settings/phone": null,\n', 'replace'],
    ['  {\n    id: "rubato-scheduled-tasks",',
      [
        '  {',
        '    id: "rubato-phone",',
        '    title: "Phone",',
        '    to: "/settings/phone",',
        '    searchTerms: ["phone iphone mobile push notifications live activities t3 connect relay 핸드폰 휴대폰 아이폰 알림 연결"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['  CalendarClockIcon,\n', '  CalendarClockIcon,\n  SmartphoneIcon,\n', 'replace'],
    ['  "/settings/scheduled": CalendarClockIcon,\n', '  "/settings/scheduled": CalendarClockIcon,\n  "/settings/phone": SmartphoneIcon,\n', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/scheduled",\n]);', '  "/settings/scheduled",\n  "/settings/phone",\n]);', 'replace'],
  ],
};
