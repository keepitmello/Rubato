// The Stats page: how this person works with Rubato, from the local session logs.
// The page, its routes and its server half (src/stats/service.mjs behind
// RubatoServiceRoute.ts) are ours. The rail button lives in RubatoProjectRail.tsx
// and the route-tree lines in route-tree-edits.mjs; the edits below register the
// server route and list the page in Settings, where a click opens the rail page.
export const statsOverlays = [
  'apps/web/src/state/rubatoStats.ts',
  'apps/web/src/components/RubatoStatsPage.tsx',
  'apps/web/src/components/rubatoStatsFormat.ts',
  'apps/web/src/components/rubatoStatsFormat.test.ts',
  'apps/web/src/routes/stats.tsx',
  'apps/web/src/routes/settings.stats.tsx',
];

export const statsEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoStatsRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoStatsRouteLayer,\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/archived";\n', '  | "/settings/stats"\n'],
    ['  "/settings/about": msg("About"),\n',
      '  "/settings/about": msg("About"),\n  "/settings/stats": msg("Stats"),\n', 'replace'],
    ['  "/settings/about": null,\n',
      '  "/settings/about": null,\n  "/settings/stats": null,\n', 'replace'],
    ['    paths: ["/settings/maintenance", "/settings/labs", "/settings/about", "/settings/archived"],\n',
      '    paths: ["/settings/maintenance", "/settings/labs", "/settings/stats", "/settings/about", "/settings/archived"],\n', 'replace'],
    ['  {\n    id: "storage-worktrees",',
      [
        '  {',
        '    id: "rubato-stats",',
        '    title: "Stats",',
        '    to: "/settings/stats",',
        '    searchTerms: ["stats statistics usage history sessions messages tokens cache models speed streak heatmap thinking 통계 사용량 기록 잔디"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['  ArchiveIcon,\n', '  ArchiveIcon,\n  ActivityIcon,\n', 'replace'],
    ['  "/settings/devices": SmartphoneIcon,\n', '  "/settings/devices": SmartphoneIcon,\n  "/settings/stats": ActivityIcon,\n', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/about",\n', '  "/settings/about",\n  "/settings/stats",\n', 'replace'],
  ],
};
