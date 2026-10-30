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
  'apps/web/src/state/rubatoCompanion.test.tsx',
  'apps/web/src/hooks/rubatoCompanionProjectBoundary.test.ts',
  'apps/web/src/components/settings/RubatoCompanionSettings.tsx',
  'apps/web/src/components/sidebar/RubatoSegnoIcon.tsx',
  'apps/web/src/routes/settings.companion.tsx',
  'apps/web/src/components/chat/RubatoSegnoSpace.tsx',
  'apps/web/src/components/chat/RubatoSegnoSpace.css',
  'apps/web/src/components/chat/RubatoSegnoSpace.test.ts',
  'apps/web/src/components/chat/RubatoCompanionRooms.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoSidebar.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoNotice.tsx',
  'apps/web/src/components/chat/RubatoSegnoChat.tsx',
  'apps/web/src/components/chat/RubatoSegnoChat.css',
  'apps/web/src/components/chat/RubatoSegnoInner.tsx',
  'apps/web/src/components/chat/rubatoSegnoRoom.ts',
  'apps/web/src/components/chat/rubatoSegnoRoom.test.ts',
  'apps/web/src/components/chat/RubatoSegnoNotice.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoNoticeCoordinator.test.tsx',
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
    ['import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";\n', 'import { isCompanionThread } from "../state/rubatoCompanion";\nimport { RubatoSegnoChat } from "./chat/RubatoSegnoChat";\n'],
    // Segno's thread has no workspace or version control of its own: the floating thread details
    // (workspace, open in editor, branch, publish, changes) and the button that toggles them stay
    // out of Segno's space (user 2026-10-21). Every other thread keeps them.
    ['            <ThreadDetailsPanel {...threadDetailsPanelProps} />\n',
      '            {isCompanionThread(activeThread.id) ? null : <ThreadDetailsPanel {...threadDetailsPanelProps} />}\n',
      'replace'],
    ['      showThreadPanelControl={!inlineRightPanelOwnsTitleBar}\n',
      '      showThreadPanelControl={!inlineRightPanelOwnsTitleBar && !isCompanionThread(activeThread.id)}\n',
      'replace'],
    // Segno's thread is a chat room (chat/RubatoSegnoChat.tsx, user f38c36a6): it reads the same
    // timeline as the ordinary one and draws it as bubbles. Every other thread keeps the timeline.
    // Its rewind is the timeline's own, with files left as they are (user f8828a9f).
    ['              <MessagesTimeline\n                citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}\n',
      '              {isCompanionThread(activeThread.id) ? (\n'
        + '                <RubatoSegnoChat\n'
        + '                  entries={displayedTimeline.entries}\n'
        + '                  working={!paintOnlyDisplayedTimeline && isWorking}\n'
        + '                  cwd={gitCwd ?? undefined}\n'
        + '                  environmentId={displayedThreadRef?.environmentId ?? activeThread.environmentId}\n'
        + '                  bottomInset={composerTimelineInset}\n'
        + '                  threadId={activeThread.id}\n'
        + '                  onRewind={(turnCount, messageId) => void onRevertToTurnCountRef.current(turnCount, messageId, false)}\n'
        + '                  {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined\n'
        + '                    ? {}\n'
        + '                    : { historyControls: threadHistoryControls })}\n'
        + '                />\n'
        + '              ) : (\n'
        + '              <MessagesTimeline\n                citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}\n',
      'replace'],
    ['                {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined\n                  ? {}\n                  : { historyControls: threadHistoryControls })}\n              />\n',
      '                {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined\n                  ? {}\n                  : { historyControls: threadHistoryControls })}\n              />\n              )}\n',
      'replace'],
  ],
  // Segno's own folder is not a project to start work in: neither the new thread's default
  // project nor the headline's picker offers it.
  'apps/web/src/hooks/useHandleNewThread.ts': [
    ['  const rubatoFirstGroup = useSidebarProjectGroups().find((group) => group.isScratch !== true);\n',
      '  const rubatoCompanionHomes = useRubatoCompanion().companions.map(item => item.home);\n'
        + '  const rubatoFirstGroup = useSidebarProjectGroups().find(\n'
        + '    (group) => group.isScratch !== true && !rubatoCompanionHomes.some(home => isCompanionProject(group, home)),\n'
        + '  );\n'
        + '  const rubatoFallbackProject = orderedProjects.find(project => !rubatoCompanionHomes.some(home => isCompanionProject(project, home)));\n',
      'replace'],
    ['      : orderedProjects[0]\n        ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)\n        : null,\n',
      '      : rubatoFallbackProject\n        ? scopeProjectRef(rubatoFallbackProject.environmentId, rubatoFallbackProject.id)\n        : null,\n', 'replace'],
    ['import { useSidebarProjectGroups } from "./useSidebarProjectGroups";\n',
      'import { isCompanionProject, useRubatoCompanion } from "../state/rubatoCompanion";\n'],
  ],
  'apps/web/src/hooks/useHandleNewThread.test.ts': [
    ['vi.mock("./useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => [] }));\n',
      'vi.mock("../state/rubatoCompanion", () => ({\n'
        + '  isCompanionProject: () => false,\n'
        + '  useRubatoCompanion: () => ({ status: null, threadId: null, companions: [] }),\n'
        + '}));\n'],
  ],
  'apps/web/src/components/chat/DraftHeroHeadline.tsx': [
    ['  const projectGroups = useRubatoProjectOrder(unsortedProjectGroups).ordered;',
      '  const rubatoOrderedGroups = useRubatoProjectOrder(unsortedProjectGroups).ordered;\n'
        + '  // Rubato: Segno\'s own folder is not offered as a project (companion-edits.mjs).\n'
        + '  const rubatoCompanionHomes = useRubatoCompanion().companions.map(item => item.home);\n'
        + '  const projectGroups = useMemo(\n'
        + '    () => rubatoOrderedGroups.filter((group) => !rubatoCompanionHomes.some(home => isCompanionProject(group, home))),\n'
        + '    [rubatoOrderedGroups, rubatoCompanionHomes],\n'
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
  // The new-thread shortcuts (chat.newLocal, chat.new) from Segno's conversation, likewise.
  'apps/web/src/routes/_chat.tsx': [
    ['      if (command === "chat.newLocal") {\n        event.preventDefault();\n        event.stopPropagation();\n        void startNewThreadFromContext({\n          activeDraftThread,\n          activeThread: activeThread ?? undefined,\n',
      '      if (command === "chat.newLocal") {\n        event.preventDefault();\n        event.stopPropagation();\n        void startNewThreadFromContext({\n          activeDraftThread,\n          activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n',
      'replace'],
    ['        void startNewThreadFromContext({\n          activeDraftThread,\n          activeThread: activeThread ?? undefined,\n',
      '        void startNewThreadFromContext({\n          activeDraftThread,\n          activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n',
      'replace'],
    ['import { startNewThreadFromContext } from "../lib/chatThreadActions";\n',
      'import { isCompanionThread } from "../state/rubatoCompanion";\n'],
  ],
  // Segno's thread opens in Segno's space: its chat on the left, Segno and the task panel on the
  // right (components/chat/RubatoSegnoSpace.tsx). Every other thread is unchanged.
  'apps/web/src/components/ThreadRouteView.tsx': [
    ['  let view: React.ReactNode = null;\n',
      '  // Rubato: Segno\'s thread opens in its own space (companion-edits.mjs).\n'
        + '  const rubatoCompanionView = useRubatoCompanion();\n'
        + '  const rubatoCurrentCompanion = target.kind === "server" ? rubatoCompanionView.companions.find(item => item.threadId === target.threadRef.threadId) : undefined;\n'
        + '  const rubatoSegnoSpace = rubatoCurrentCompanion !== undefined;\n'],
    ['    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">\n      {view}\n    </SidebarInset>\n',
      '    <SidebarInset\n'
        + '      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"\n'
        + '      data-rubato-segno-space-host={rubatoSegnoSpace ? "" : undefined}\n'
        + '    >\n'
        + '      {rubatoSegnoSpace ? <RubatoSegnoSpace key={rubatoCurrentCompanion!.id} companionId={rubatoCurrentCompanion!.id}>{view}</RubatoSegnoSpace> : view}\n'
        + '    </SidebarInset>\n',
      'replace'],
    ['import { SidebarInset } from "./ui/sidebar";\n',
      'import { RubatoSegnoSpace } from "./chat/RubatoSegnoSpace";\nimport { useRubatoCompanion } from "../state/rubatoCompanion";\n'],
  ],
  // A run that ends in Segno's thread notifies like a messenger — Segno's name, the start of what it
  // said, "Open" (chat/RubatoSegnoNotice.tsx); every other thread's notification is unchanged but
  // for its desktop title, which now follows the interface language like the toast's.
  'apps/web/src/components/ThreadNotificationCoordinator.tsx': [
    ['import { resolveSidebarThreadStatus } from "./Sidebar.logic";\n',
      'import { notifySegnoCompletion } from "./chat/RubatoSegnoNotice";\n'
        + 'import { uiText } from "../rubatoI18n";\n'
        + 'import { isCompanionThread } from "../state/rubatoCompanion";\n'],
    ['      if (!kind) continue;\n      const title =\n',
      '      if (!kind) continue;\n'
        + '      // Rubato: Segno\'s thread notifies like a messenger (companion-edits.mjs).\n'
        + '      if (kind === "completion" && isCompanionThread(thread.id)) {\n'
        + '        void notifySegnoCompletion({\n'
        + '          environmentId,\n'
        + '          threadId: thread.id,\n'
        + '          runId: rawThread.latestRunId,\n'
        + '          mode,\n'
        + '          inAppNotificationsEnabled,\n'
        + '          viewing: activeEnvironmentId === environmentId && activeThreadId === thread.id,\n'
        + '          open: () =>\n'
        + '            void navigate({\n'
        + '              to: "/$environmentId/$threadId",\n'
        + '              params: { environmentId, threadId: thread.id },\n'
        + '            }),\n'
        + '          onNotification,\n'
        + '        });\n'
        + '        continue;\n'
        + '      }\n'
        + '      const title =\n',
      'replace'],
    ['        const notification = new Notification(title, {\n',
      '        const notification = new Notification(uiText(title), {\n', 'replace'],
  ],
  // Segno's header is just its name: its folder is not a project.
  'apps/web/src/components/chat/ChatHeader.tsx': [
    ['        {activeProject ? (\n', '        {activeProject && !isCompanionThread(activeThreadId) ? (\n', 'replace'],
    ['import { cn } from "~/lib/utils";\n', 'import { isCompanionThread } from "../../state/rubatoCompanion";\n'],
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
