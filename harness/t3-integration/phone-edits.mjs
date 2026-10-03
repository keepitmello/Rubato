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

// The router plugin writes routeTree.gen.ts from routes/ at dev and build time.
// These are exactly its lines for settings.phone.tsx. `phone` sorts between
// `permissions` and `projects`: imports, consts and the by-path map run
// backwards, the route lists forwards. The three typed lists and three unions
// repeat the same neighbours; each anchor runs on to the first line that differs.
const tail = (line) =>
  ['projects', 'providers', 'scheduled', 'snap-shot', 'source-control', 'storage'].map((name) => line(name)).join('');
const typed = (name) => {
  const route = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return `  '/settings/${name}': typeof Settings${route}Route\n`;
};
const union = (name) => `    | '/settings/${name}'\n`;
const routeTreeEdits = [
  ["import { Route as SettingsPermissionsRouteImport } from './routes/settings.permissions'\n",
    "import { Route as SettingsPhoneRouteImport } from './routes/settings.phone'\n"],
  ['const SettingsPermissionsRoute = SettingsPermissionsRouteImport.update({\n',
    "const SettingsPhoneRoute = SettingsPhoneRouteImport.update({\n  id: '/phone',\n  path: '/phone',\n  getParentRoute: () => SettingsRoute,\n} as any)\n"],
  ...["  '/$environmentId/$threadId'", "  '/': typeof ChatIndexRoute", "  '/_chat/': typeof"].map((next) =>
    [tail(typed) + next, "  '/settings/phone': typeof SettingsPhoneRoute\n"]),
  ...["    | '/$environmentId/$threadId'", "    | '/'\n", "    | '/_chat/'"].map((next) =>
    [tail(union) + next, "    | '/settings/phone'\n"]),
  ["    '/settings/permissions': {\n",
    "    '/settings/phone': {\n      id: '/settings/phone'\n      path: '/phone'\n      fullPath: '/settings/phone'\n      preLoaderRoute: typeof SettingsPhoneRouteImport\n      parentRoute: typeof SettingsRoute\n    }\n"],
  ['  SettingsProjectsRoute: typeof SettingsProjectsRoute\n', '  SettingsPhoneRoute: typeof SettingsPhoneRoute\n'],
  ['  SettingsProjectsRoute: SettingsProjectsRoute,\n', '  SettingsPhoneRoute: SettingsPhoneRoute,\n'],
];

export const phoneEdits = {
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";', 'import { rubatoPhoneRouteLayer } from "./RubatoPhone.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoPhoneRouteLayer,\n'],
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
  'apps/web/src/routeTree.gen.ts': routeTreeEdits,
};
