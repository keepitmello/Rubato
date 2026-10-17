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
    ['  | "/settings/phone"\n', '  | "/settings/phone"\n  | "/settings/stats"\n', 'replace'],
    ['  "/settings/phone": "Phone",\n', '  "/settings/phone": "Phone",\n  "/settings/stats": "Stats",\n', 'replace'],
    ['  "/settings/phone": null,\n', '  "/settings/phone": null,\n  "/settings/stats": null,\n', 'replace'],
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
    ['  BrainIcon,\n', '  BrainIcon,\n  ActivityIcon,\n', 'replace'],
    ['  "/settings/phone": SmartphoneIcon,\n', '  "/settings/phone": SmartphoneIcon,\n  "/settings/stats": ActivityIcon,\n', 'replace'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/phone",\n', '  "/settings/phone",\n  "/settings/stats",\n', 'replace'],
  ],
};
