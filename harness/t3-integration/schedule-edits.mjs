// Settings > Scheduled Tasks. The page, its route and its server route are
// ours; the edits below only register them: a nav entry and search item, a
// device-only page (no scope picker), the route in the generated tree, and the
// HTTP route on the server. The server half's work happens in the Rubato
// checkout (src/schedule/service.mjs over packages/schedule-core).
export const scheduleOverlays = [
  'apps/server/src/RubatoSchedule.ts',
  'apps/web/src/state/rubatoSchedule.ts',
  'apps/web/src/components/settings/RubatoScheduleSettings.tsx',
  'apps/web/src/components/settings/RubatoScheduleSettings.logic.ts',
  'apps/web/src/components/settings/RubatoScheduleSettings.logic.test.ts',
  'apps/web/src/routes/_chat.settings.scheduled.tsx',
];

export const scheduleEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoScheduleRouteLayer } from "./RubatoSchedule.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoScheduleRouteLayer,\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/memory"\n', '  | "/settings/memory"\n  | "/settings/scheduled"\n', 'replace'],
    ['  "/settings/memory": msg("Memory"),\n', '  "/settings/memory": msg("Memory"),\n  "/settings/scheduled": msg("Scheduled Tasks"),\n', 'replace'],
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
    // T3's own Scheduled Tasks page (its server scheduler) keeps its route, but the nav
    // shows only one "Scheduled Tasks": Rubato's, on the rail. Search leaves T3's out too
    // (settings/rubatoSettingsSurface.ts).
    ['      "/settings/devices",\n      "/settings/scheduled-tasks",\n    ],\n',
      '      "/settings/devices",\n    ],\n',
      'replace'],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['  "/settings/memory": BrainIcon,\n', '  "/settings/memory": BrainIcon,\n  "/settings/scheduled": CalendarClockIcon,\n', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/memory",\n', '  "/settings/memory",\n  "/settings/scheduled",\n', 'replace'],
  ],
};
