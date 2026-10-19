// Segno, the always-on companion (harness/companion; intent companion-segno).
//
// - Settings › Companion (settings/RubatoCompanionSettings.tsx), a page in Rubato's Settings
//   layout under Work: turning Segno on, its heartbeat and daily report, and the pieces of its
//   prompt. The server half is /rubato/companion (RubatoCompanion.ts over src/companion/service.mjs).
// - The rail's Segno button (sidebar/RubatoProjectRail.tsx) opens Segno's conversation; it shows
//   while Segno is on.
// - Segno's conversation is the rail's, not the thread list's: the sidebar leaves its thread out,
//   and the project lists leave out its folder (state/rubatoCompanion.ts).
// Registered after settings-layout-edits.mjs, whose Settings lines these anchor on.
export const companionOverlays = [
  'apps/server/src/RubatoCompanion.ts',
  'apps/web/src/state/rubatoCompanion.ts',
  'apps/web/src/components/settings/RubatoCompanionSettings.tsx',
  'apps/web/src/components/sidebar/RubatoSegnoIcon.tsx',
  'apps/web/src/routes/settings.companion.tsx',
];

/** The settings route slug the generated route tree gains (route-tree-edits.mjs). */
export const companionSettingsPages = ['companion'];

export const companionEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoCompanionRouteLayer } from "./RubatoCompanion.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoCompanionRouteLayer,\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/chat"\n', '  | "/settings/companion"\n'],
    ['  "/settings/chat": "Chat",\n', '  "/settings/companion": "Companion",\n'],
    ['  "/settings/chat": null,\n', '  "/settings/companion": null,\n'],
    ['  {\n    id: "rubato-title-models",\n',
      [
        '  {',
        '    id: "rubato-companion",',
        '    title: "Companion",',
        '    to: "/settings/companion",',
        '    searchTerms: ["segno companion always on assistant heartbeat daily report prompt soul 세뇨 컴패니언 하트비트 데일리 리포트"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['import { RUBATO_SETTINGS_DETAIL_PAGES, RUBATO_SETTINGS_PAGES } from "./rubatoSettingsLayout";\n',
      'import { RubatoSegnoIcon } from "../sidebar/RubatoSegnoIcon";\n'],
    ['  "/settings/chat": MessageSquareIcon,\n', '  "/settings/companion": RubatoSegnoIcon,\n'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/phone",\n', '  "/settings/companion",\n'],
  ],
  // The thread list every sidebar section is laid out from.
  'apps/web/src/components/Sidebar.tsx': [
    ['  const threads = useThreadShells();\n',
      '  // Rubato: Segno\'s conversation opens from the rail, not the list (companion-edits.mjs).\n'
        + '  const threads = useWithoutCompanionThread(useThreadShells());\n',
      'replace'],
    ['import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";\n',
      'import { useWithoutCompanionThread } from "../state/rubatoCompanion";\n'],
  ],
};
