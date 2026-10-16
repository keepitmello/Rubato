// Settings > Phone. The page, its route and its server route are ours; the edits
// below only register them: a nav entry and search item, a device-only page, the
// route in the generated tree, and the HTTP route on the server. The server half
// links this Mac to T3's relay so the T3 app on a phone gets notifications.
export const phoneOverlays = [
  'apps/server/src/RubatoPhone.ts',
  'apps/web/src/state/rubatoPhone.ts',
  'apps/web/src/components/settings/RubatoPhoneSettings.tsx',
  'apps/web/src/routes/settings.phone.tsx',
];

export const phoneEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoPhoneRouteLayer } from "./RubatoPhone.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoPhoneRouteLayer,\n'],
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
