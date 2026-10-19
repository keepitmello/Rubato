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
  // Segno keeps its name: its first message does not title its thread (T3 titles a thread with no
  // messages from the first one it sends, and the Pi adapter mirrors that title into the engine).
  'apps/web/src/components/ChatView.tsx': [
    ['          modelSelection: ctxSelectedModelSelection,\n          titleSeed: title,\n          runtimeMode,\n          interactionMode: sendInteractionMode,\n',
      '          modelSelection: ctxSelectedModelSelection,\n          ...(isCompanionThread(threadIdForSend) ? {} : { titleSeed: title }),\n          runtimeMode,\n          interactionMode: sendInteractionMode,\n',
      'replace'],
    ['import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";\n', 'import { isCompanionThread } from "../state/rubatoCompanion";\n'],
  ],
  // Segno's own folder is not a project to start work in: neither the new thread's default
  // project nor the headline's picker offers it.
  'apps/web/src/hooks/useHandleNewThread.ts': [
    ['  const rubatoFirstGroup = useSidebarProjectGroups().find((group) => group.isScratch !== true);\n',
      '  const rubatoCompanionHome = useRubatoCompanion().status?.home;\n'
        + '  const rubatoFirstGroup = useSidebarProjectGroups().find(\n'
        + '    (group) => group.isScratch !== true && !isCompanionProject(group, rubatoCompanionHome),\n'
        + '  );\n',
      'replace'],
    ['import { useSidebarProjectGroups } from "./useSidebarProjectGroups";\n',
      'import { isCompanionProject, useRubatoCompanion } from "../state/rubatoCompanion";\n'],
  ],
  'apps/web/src/hooks/useHandleNewThread.test.ts': [
    ['vi.mock("./useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => [] }));\n',
      'vi.mock("../state/rubatoCompanion", () => ({\n'
        + '  isCompanionProject: () => false,\n'
        + '  useRubatoCompanion: () => ({ status: null, threadId: null }),\n'
        + '}));\n'],
  ],
  'apps/web/src/components/chat/DraftHeroHeadline.tsx': [
    ['  const projectGroups = useRubatoProjectOrder(unsortedProjectGroups).ordered;',
      '  const rubatoOrderedGroups = useRubatoProjectOrder(unsortedProjectGroups).ordered;\n'
        + '  // Rubato: Segno\'s own folder is not offered as a project (companion-edits.mjs).\n'
        + '  const rubatoCompanionHome = useRubatoCompanion().status?.home;\n'
        + '  const projectGroups = useMemo(\n'
        + '    () => rubatoOrderedGroups.filter((group) => !isCompanionProject(group, rubatoCompanionHome)),\n'
        + '    [rubatoOrderedGroups, rubatoCompanionHome],\n'
        + '  );',
      'replace'],
    ['import { ProjectFavicon } from "../ProjectFavicon";\n',
      'import { isCompanionProject, useRubatoCompanion } from "../../state/rubatoCompanion";\n'],
  ],
  // Nor do the palette's project list, the first screen's draft, or a new thread started from
  // Segno's conversation ("new thread in this project" takes the default project instead).
  'apps/web/src/components/CommandPalette.tsx': [
    ['  const projects = useProjects();\n', '  const projects = useWithoutCompanionProjects(useProjects());\n', 'replace'],
    ['      resolveThreadActionProjectRef({\n        activeDraftThread,\n        activeThread: activeThread ?? undefined,\n',
      '      resolveThreadActionProjectRef({\n        activeDraftThread,\n        activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n', 'replace'],
    ['          await startNewThreadFromContext({\n            activeDraftThread,\n            activeThread: activeThread ?? undefined,\n',
      '          await startNewThreadFromContext({\n            activeDraftThread,\n            activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n', 'replace'],
    ['import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";\n',
      'import { isCompanionThread, useWithoutCompanionProjects } from "../state/rubatoCompanion";\n'],
  ],
  'apps/web/src/routes/_chat.index.tsx': [
    ['  const projects = useProjects();\n  const threads = useThreadShells();\n',
      '  const projects = useWithoutCompanionProjects(useProjects());\n  const threads = useThreadShells();\n', 'replace'],
    ['import { useNewThreadHandler } from "../hooks/useHandleNewThread";\n',
      'import { useWithoutCompanionProjects } from "../state/rubatoCompanion";\n'],
  ],
  // The thread list every sidebar section is laid out from.
  'apps/web/src/components/Sidebar.tsx': [
    ['  const threads = useThreadShells();\n',
      '  // Rubato: Segno\'s conversation opens from the rail, not the list (companion-edits.mjs).\n'
        + '  const threads = useWithoutCompanionThread(useThreadShells());\n',
      'replace'],
    ['import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";\n',
      'import { isCompanionThread, useWithoutCompanionThread } from "../state/rubatoCompanion";\n'],
    ['          activeThread: newThreadContext.activeThread ?? undefined,\n',
      '          activeThread:\n'
        + '            newThreadContext.activeThread && !isCompanionThread(newThreadContext.activeThread.id)\n'
        + '              ? newThreadContext.activeThread\n'
        + '              : undefined,\n',
      'replace'],
  ],
};
