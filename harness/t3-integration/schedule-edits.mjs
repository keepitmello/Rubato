// Settings > Scheduled Tasks. The page, its route and its server route are
// ours; the edits below only register them: a nav entry and search item, a
// device-only page (no scope picker), the route in the generated tree, and the
// HTTP route on the server. The server half's work happens in the Rubato
// checkout (src/schedule/service.mjs over packages/schedule-core).
export const scheduleOverlays = [
  'apps/server/src/RubatoSchedule.ts',
  'apps/server/src/RubatoSchedule.test.ts',
  'apps/web/src/state/rubatoSchedule.ts',
  'apps/web/src/components/settings/RubatoScheduleSettings.tsx',
  'apps/web/src/components/settings/RubatoScheduleSettings.logic.ts',
  'apps/web/src/components/settings/RubatoScheduleSettings.logic.test.ts',
  'apps/web/src/routes/settings.scheduled.tsx',
];

// The router plugin writes routeTree.gen.ts from routes/ at dev and build time.
// These are exactly its lines for settings.scheduled.tsx (checked with
// @tanstack/router-generator), so a rebuild leaves the file as applied. Three
// route lists repeat the same neighbours; each anchor runs on to the first
// line that differs between them.
const tail = (line) => ['snap-shot', 'source-control', 'storage'].map((name) => line(name)).join('');
const typed = (name) => {
  const route = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return `  '/settings/${name}': typeof Settings${route}Route\n`;
};
const union = (name) => `    | '/settings/${name}'\n`;
const routeTreeEdits = [
  ["import { Route as SettingsProvidersRouteImport } from './routes/settings.providers'\n",
    "import { Route as SettingsScheduledRouteImport } from './routes/settings.scheduled'\n"],
  ['const SettingsProvidersRoute = SettingsProvidersRouteImport.update({\n',
    "const SettingsScheduledRoute = SettingsScheduledRouteImport.update({\n  id: '/scheduled',\n  path: '/scheduled',\n  getParentRoute: () => SettingsRoute,\n} as any)\n"],
  ...["  '/$environmentId/$threadId'", "  '/': typeof ChatIndexRoute", "  '/_chat/': typeof"].map((next) =>
    [tail(typed) + next, "  '/settings/scheduled': typeof SettingsScheduledRoute\n"]),
  ...["    | '/$environmentId/$threadId'", "    | '/'\n", "    | '/_chat/'"].map((next) =>
    [tail(union) + next, "    | '/settings/scheduled'\n"]),
  ["    '/settings/providers': {\n",
    "    '/settings/scheduled': {\n      id: '/settings/scheduled'\n      path: '/scheduled'\n      fullPath: '/settings/scheduled'\n      preLoaderRoute: typeof SettingsScheduledRouteImport\n      parentRoute: typeof SettingsRoute\n    }\n"],
  ['  SettingsSnapShotRoute: typeof SettingsSnapShotRoute\n', '  SettingsScheduledRoute: typeof SettingsScheduledRoute\n'],
  ['  SettingsSnapShotRoute: SettingsSnapShotRoute,\n', '  SettingsScheduledRoute: SettingsScheduledRoute,\n'],
];

export const scheduleEdits = {
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";', 'import { rubatoScheduleRouteLayer } from "./RubatoSchedule.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoScheduleRouteLayer,\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/memory"\n', '  | "/settings/memory"\n  | "/settings/scheduled"\n', 'replace'],
    ['  "/settings/memory": "Memory",\n', '  "/settings/memory": "Memory",\n  "/settings/scheduled": "Scheduled Tasks",\n', 'replace'],
    ['  "/settings/memory": null,\n', '  "/settings/memory": null,\n  "/settings/scheduled": null,\n', 'replace'],
    ['  {\n    id: "storage-worktrees",',
      [
        '  {',
        '    id: "rubato-scheduled-tasks",',
        '    title: "Scheduled Tasks",',
        '    to: "/settings/scheduled",',
        '    searchTerms: ["scheduled tasks automation cron recurring daily weekly every hours run later timer 예약 작업 자동화 매일"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['  BotIcon,\n', '  BotIcon,\n  CalendarClockIcon,\n', 'replace'],
    ['  "/settings/memory": BrainIcon,\n', '  "/settings/memory": BrainIcon,\n  "/settings/scheduled": CalendarClockIcon,\n', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/memory",\n]);', '  "/settings/memory",\n  "/settings/scheduled",\n]);', 'replace'],
  ],
  'apps/web/src/routeTree.gen.ts': routeTreeEdits,
};
