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
  'apps/server/src/RubatoCompanion.test.ts',
  'apps/server/src/RubatoCompanionRewind.ts',
  'apps/server/src/RubatoCompanionRewind.test.ts',
  'apps/server/src/RubatoCompanionModel.ts',
  'apps/web/src/state/rubatoCompanion.ts',
  'apps/web/src/state/rubatoCompanion.test.tsx',
  // What the companion pages draw, without React: word diff, crop, list line, chips, drafts.
  'apps/web/src/state/rubatoCompanionModel.ts',
  'apps/web/src/state/rubatoCompanionModel.test.ts',
  'apps/web/src/hooks/rubatoCompanionProjectBoundary.test.ts',
  'apps/web/src/components/settings/RubatoCompanionSettings.tsx',
  // The profile picture: camera menu, round crop, pictures from the conversation (intent companion-manage).
  'apps/web/src/components/settings/RubatoCompanionPicture.tsx',
  'apps/web/src/components/settings/RubatoCompanionIconSetting.tsx',
  // A companion's face wherever one is drawn, and the one way the pages open its room with a draft.
  'apps/web/src/components/chat/RubatoCompanionFace.tsx',
  // Proposal cards and onboarding chips in the room.
  'apps/web/src/components/chat/RubatoCompanionProposals.tsx',
  'apps/web/src/components/chat/RubatoCompanionProposals.test.tsx',
  'apps/web/src/components/settings/RubatoCompanionSettings.test.tsx',
  'apps/web/src/components/sidebar/RubatoSegnoIcon.tsx',
  'apps/web/src/components/sidebar/RubatoRooIcon.tsx',
  'apps/web/src/routes/_chat.settings.companion.tsx',
  'apps/web/src/components/chat/RubatoSegnoSpace.tsx',
  'apps/web/src/components/chat/RubatoSegnoSpace.css',
  'apps/web/src/components/chat/RubatoSegnoSpace.test.ts',
  'apps/web/src/components/chat/RubatoCompanionRooms.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoSidebar.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoNotice.tsx',
  'apps/web/src/components/chat/RubatoSegnoChat.tsx',
  'apps/web/src/components/chat/RubatoSegnoChat.css',
  'apps/web/src/components/chat/RubatoSegnoChat.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoInner.tsx',
  'apps/web/src/hooks/useRubatoRoomVisible.ts',
  'apps/web/src/components/chat/RubatoRoomActivity.test.tsx',
  // The room's side panel: status board, questions, memory, records (intent memory-redesign-work-cards).
  'apps/web/src/components/chat/RubatoSegnoPanel.tsx',
  'apps/web/src/components/chat/RubatoSegnoPanel.test.tsx',
  'apps/web/src/components/chat/rubatoSegnoRoom.ts',
  'apps/web/src/components/chat/rubatoSegnoRoom.test.ts',
  'apps/web/src/components/chat/RubatoSegnoNotice.test.tsx',
  'apps/web/src/components/chat/RubatoSegnoNoticeCoordinator.test.tsx',
  // One reply, several bubbles: where the room and the phone break a reply (shared with mobile/companion-edits.mjs).
  'packages/shared/src/rubatoReplyBubbles.ts',
  'packages/shared/src/rubatoRoomPoll.ts',
  'packages/shared/src/rubatoReplyBubbles.test.ts',
  // Which models the Add Companion flow offers, for the settings page and the phone's "+".
  'packages/shared/src/rubatoCompanionModelChoice.ts',
  'packages/shared/src/rubatoCompanionModelChoice.test.ts',
];

export const companionEdits = {
  'packages/shared/package.json': [
    ['    "./delimitedPreview": {\n',
      '    "./rubatoReplyBubbles": {\n      "types": "./src/rubatoReplyBubbles.ts",\n      "import": "./src/rubatoReplyBubbles.ts"\n    },\n    "./rubatoRoomPoll": {\n      "types": "./src/rubatoRoomPoll.ts",\n      "import": "./src/rubatoRoomPoll.ts"\n    },\n    "./rubatoCompanionModelChoice": {\n      "types": "./src/rubatoCompanionModelChoice.ts",\n      "import": "./src/rubatoCompanionModelChoice.ts"\n    },\n'],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoCompanionRouteLayer } from "./RubatoCompanion.ts";\nimport { rubatoCompanionModelRouteLayer } from "./RubatoCompanionModel.ts";\nimport { rubatoCompanionRewindRouteLayer } from "./RubatoCompanionRewind.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoCompanionRouteLayer,\n    rubatoCompanionModelRouteLayer,\n    rubatoCompanionRewindRouteLayer,\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/chat"\n', '  | "/settings/companion"\n'],
    ['  "/settings/chat": msg("Chat"),\n', '  "/settings/companion": msg("Companion"),\n'],
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
    ['import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";\n',
      'import { RubatoSegnoIcon } from "../sidebar/RubatoSegnoIcon";\n'],
    ['  "/settings/chat": MessageSquareTextIcon,\n', '  "/settings/companion": RubatoSegnoIcon,\n'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/phone",\n', '  "/settings/companion",\n'],
  ],
  // Segno keeps its name: its first message does not title its thread (T3 titles a thread with no
  // messages from the first one it sends, and the Pi adapter mirrors that title into the engine).
  // v0.1.11 starts the turn in useComposerSend.ts, so the suppression sits there.
  'apps/web/src/components/chat/useComposerSend.ts': [
    ['          modelSelection: ctxSelectedModelSelection,\n          titleSeed: title,\n          runtimeMode,\n          interactionMode: DEFAULT_INTERACTION_MODE,\n',
      '          modelSelection: isCompanionThread(threadIdForSend) ? undefined : ctxSelectedModelSelection,\n          ...(isCompanionThread(threadIdForSend) ? {} : { titleSeed: title }),\n          runtimeMode,\n          interactionMode: DEFAULT_INTERACTION_MODE,\n',
      'replace'],
    ['import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";\n',
      'import { isCompanionThread } from "../../state/rubatoCompanion";\n'],
  ],
  // A model picked in a companion's room applies at once, not at the next send: the companion
  // works on its own between messages (applyCompanionModel, user item bceb5547). v0.1.11 keeps the
  // picker's handler in useComposerSelection.ts.
  'apps/web/src/components/chat/useComposerSelection.ts': [
    ['    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({\n',
      [
        '    if (activeThread && isCompanionThread(activeThread.id)) {',
        '      void applyCompanionModel(activeThread.environmentId, activeThread.id, nextModelSelection).catch((error: unknown) => {',
        '        toastManager.add({',
        '          type: "error",',
        '          title: "The companion did not switch models",',
        '          description: error instanceof Error ? error.message : String(error),',
        '        });',
        '      });',
        '      return;',
        '    }',
        '    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({',
        '',
      ].join('\n'), 'replace'],
    ['import { toastManager } from "../ui/toast";\n',
      'import { applyCompanionModel, isCompanionThread } from "../../state/rubatoCompanion";\n'],
  ],
  // The room's "Rewind from here" and its edit: a companion's thread holds no checkpoints, so the
  // message names where the rewind lands (RubatoCompanionRewind.ts, user 4c412ab9). The message
  // still returns to the composer the way T3's revert puts it there. v0.1.11 runs the revert in
  // chatViewSend.ts's rewindToMessage.
  'apps/web/src/components/chat/chatViewSend.ts': [
    ['    const commandId = CommandId.make(randomUUID());\n'
        + '    await waitForRevertedMessage(input.routeThreadRef, input.turnCount, commandId, async () => {\n'
        + '      const result = await input.revertThreadCheckpoint({\n'
        + '        environmentId,\n'
        + '        input: {\n'
        + '          commandId,\n'
        + '          threadId: input.threadId,\n'
        + '          turnCount: input.turnCount,\n'
        + '          restoreFiles: input.restoreFiles,\n'
        + '          ...(input.checkpoint === undefined\n'
        + '            ? {}\n'
        + '            : { checkpointId: input.checkpoint.id, scopeId: input.checkpoint.scopeId }),\n'
        + '        },\n'
        + '      });\n'
        + '      if (result._tag === "Failure") throw squashAtomCommandFailure(result);\n'
        + '    });\n',
      '    if (isCompanionThread(input.threadId)) {\n'
        + '      await rewindCompanionMessage(environmentId, input.threadId, input.message.id);\n'
        + '    } else {\n'
        + '      const commandId = CommandId.make(randomUUID());\n'
        + '      await waitForRevertedMessage(input.routeThreadRef, input.turnCount, commandId, async () => {\n'
        + '        const result = await input.revertThreadCheckpoint({\n'
        + '          environmentId,\n'
        + '          input: {\n'
        + '            commandId,\n'
        + '            threadId: input.threadId,\n'
        + '            turnCount: input.turnCount,\n'
        + '            restoreFiles: input.restoreFiles,\n'
        + '            ...(input.checkpoint === undefined\n'
        + '              ? {}\n'
        + '              : { checkpointId: input.checkpoint.id, scopeId: input.checkpoint.scopeId }),\n'
        + '          },\n'
        + '        });\n'
        + '        if (result._tag === "Failure") throw squashAtomCommandFailure(result);\n'
        + '      });\n'
        + '    }\n',
      'replace'],
    ['import { recallComposerMessage } from "./composerPromptHistory";\n',
      'import { rewindCompanionMessage } from "./RubatoMessageEdit";\nimport { isCompanionThread } from "../../state/rubatoCompanion";\n'],
  ],
  // PageUp and PageDown in the composer move the room, which has no list of its own (user f7c42421).
  'apps/web/src/components/chat/useTimelineFollow.ts': [
    ['      getContainer: () => viewport.scrollNode,\n',
      '      getContainer: () =>\n'
        + '        viewport.scrollNode ??\n'
        + '        document.querySelector<HTMLElement>("[data-rubato-segno-scroller]"),\n',
      'replace'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { useSideChat } from "./chat/useSideChat";\n', 'import { companionComposerSettings, isCompanionThread } from "../state/rubatoCompanion";\n'],
    // A companion's room sends during its work as a steer, whatever Settings › Chat says
    // (companionComposerSettings, user item 6b6a88c5).
    ['                              settings={settings}\n',
      '                              settings={companionComposerSettings(settings, activeThread?.id)}\n',
      'replace'],
    // Segno's thread has no workspace or version control of its own: the floating thread details
    // (workspace, open in editor, branch, publish, changes), the hosts beside it and the button
    // that toggles them stay out of Segno's space (user 2026-10-21). Every other thread keeps
    // them. v0.1.11 renders the panel outside the `embedded` guard.
    ['            {embedded ? null : (\n',
      '            {embedded || isCompanionThread(activeThread.id) ? null : (\n',
      'replace'],
    ['      showThreadPanelControl={!inlineRightPanelOwnsTitleBar}\n',
      '      showThreadPanelControl={!inlineRightPanelOwnsTitleBar && !isCompanionThread(activeThread.id)}\n',
      'replace'],
    // Segno's thread is a chat room (chat/RubatoSegnoChat.tsx, user f38c36a6): it reads the same
    // timeline as the ordinary one and draws it as bubbles. Every other thread keeps the timeline.
    // Its rewind is the timeline's own, with files left as they are (user f8828a9f): straight to
    // the confirmed revert, no dialog. Its pencil edit answers to the thread's edit host
    // (RubatoMessageEdit.tsx, user 97580a28). v0.1.11 resolves the entries inside
    // chat/ThreadTimeline.tsx, so ChatView names the room here and ThreadTimeline draws it.
    ['                <ThreadTimeline\n                  pendingApprovals={pendingApprovals}\n',
      '                <ThreadTimeline\n'
        + '                  rubatoSegno={\n'
        + '                    isCompanionThread(activeThread.id)\n'
        + '                      ? {\n'
        + '                          threadId: activeThread.id,\n'
        + '                          threadKey: routeThreadKey,\n'
        + '                          scrollToEndClearance,\n'
        + '                          onRewind: (messageId) => onConfirmRevertStable(0, messageId, false),\n'
        + '                        }\n'
        + '                      : null\n'
        + '                  }\n'
        + '                  pendingApprovals={pendingApprovals}\n',
      'replace'],
    // The room floats its own "Scroll to end", from its own scroll (RubatoSegnoChat.tsx).
    ['              {showScrollToBottom && !isThreadFindActive && (\n',
      '              {showScrollToBottom && !isThreadFindActive && !isCompanionThread(activeThread.id) && (\n',
      'replace'],
  ],
  // The room in place of the timeline, from the same entries (see the ChatView block above).
  'apps/web/src/components/chat/ThreadTimeline.tsx': [
    ['import type { ScopedThreadRef } from "@t3tools/contracts";\n',
      'import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";\n', 'replace'],
    ['import { MessagesTimeline } from "./MessagesTimeline";\n',
      'import { RubatoSegnoChat } from "./RubatoSegnoChat";\n'],
    ['  detailLoading,\n  ...timelineProps\n}: ',
      '  detailLoading,\n  rubatoSegno,\n  ...timelineProps\n}: ', 'replace'],
    ['  detailLoading: boolean;\n}) {\n',
      '  detailLoading: boolean;\n'
        + '  /** Rubato: a companion\'s thread, drawn as its room (companion-edits.mjs). */\n'
        + '  rubatoSegno?: {\n'
        + '    readonly threadId: string;\n'
        + '    readonly threadKey: string;\n'
        + '    readonly scrollToEndClearance: number;\n'
        + '    readonly onRewind: (messageId: MessageId) => void;\n'
        + '  } | null;\n'
        + '}) {\n',
      'replace'],
    ['  return (\n    <MessagesTimeline {...timelineProps} syncing={syncing} timelineEntries={displayedEntries} />\n',
      [
        '  // Rubato: Segno\'s thread is a chat room (chat/RubatoSegnoChat.tsx, companion-edits.mjs).',
        '  if (rubatoSegno) {',
        '    return (',
        '      <RubatoSegnoChat',
        '        entries={displayedEntries}',
        '        working={timelineProps.isWorking}',
        '        cwd={timelineProps.markdownCwd}',
        '        environmentId={threadDetailRef?.environmentId ?? timelineProps.activeThreadEnvironmentId}',
        '        bottomInset={timelineProps.contentInsetEndAdjustment}',
        '        scrollToEndClearance={rubatoSegno.scrollToEndClearance}',
        '        threadId={rubatoSegno.threadId}',
        '        threadKey={rubatoSegno.threadKey}',
        '        onRewind={rubatoSegno.onRewind}',
        '        {...(timelineProps.historyControls === undefined',
        '          ? {}',
        '          : { historyControls: timelineProps.historyControls })}',
        '      />',
        '    );',
        '  }',
        '',
      ].join('\n')],
  ],
  // Segno's own folder is not a project to start work in: neither the new thread's default
  // project nor the headline's picker offers it. v0.1.11 chooses the default project from the
  // projects list in resolveDefaultProjectRef, so the folder leaves the list before the choice.
  'apps/web/src/hooks/useHandleNewThread.ts': [
    ['  const projects = useProjects();\n',
      '  // Rubato: Segno\'s own folder is not a project to start work in (companion-edits.mjs).\n'
        + '  const projects = useWithoutCompanionProjects(useProjects());\n',
      'replace'],
    ['import { useThreadRouteTarget } from "./useThreadRouteTarget";\n',
      'import { useWithoutCompanionProjects } from "../state/rubatoCompanion";\n'],
  ],
  'apps/web/src/hooks/useHandleNewThread.test.ts': [
    ['vi.mock("../components/Sidebar.logic", () => ({\n  orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items,\n}));\n',
      'vi.mock("../state/rubatoCompanion", () => ({\n'
        + '  isCompanionProject: () => false,\n'
        + '  useRubatoCompanion: () => ({ status: null, threadId: null, companions: [] }),\n'
        + '}));\n'],
  ],
  // The palette's and the headline's project groups both come from the shared order
  // (useRubatoSortedProjectOrder, project-order-edits.mjs); Segno's folder leaves them there.
  'apps/web/src/components/CommandPaletteLookups.ts': [
    ['  const projects = useProjects();\n  const projectOrder = useUiStateStore((store) => store.projectOrder);\n',
      '  // Rubato: Segno\'s own folder is not offered as a project (companion-edits.mjs).\n'
        + '  const projects = useWithoutCompanionProjects(useProjects());\n'
        + '  const projectOrder = useUiStateStore((store) => store.projectOrder);\n',
      'replace'],
    ['import { useRubatoProjectOrder } from "./sidebar/rubatoProjectOrder";\n',
      'import { useWithoutCompanionProjects } from "../state/rubatoCompanion";\n'],
  ],
  // Nor do the palette's project list, the first screen's draft, or a new thread started from
  // Segno's conversation ("new thread in this project" takes the default project instead).
  'apps/web/src/components/CommandPalette.tsx': [
    ['  const projects = useProjects();\n', '  const projects = useWithoutCompanionProjects(useProjects());\n', 'replace'],
    ['  const contextualProjectRef = resolveThreadActionProjectRef({\n    activeDraftThread,\n    activeThread: activeThread ?? undefined,\n',
      '  const contextualProjectRef = resolveThreadActionProjectRef({\n    activeDraftThread,\n    activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n', 'replace'],
    ['          await startNewThreadFromContext({\n            activeDraftThread,\n            activeThread: activeThread ?? undefined,\n',
      '          await startNewThreadFromContext({\n            activeDraftThread,\n            activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n', 'replace'],
    ['import {\n  resolveThreadActionProjectRef,\n  startNewThreadFromContext,\n  threadHasStarted,\n} from "../lib/chatThreadActions";\n',
      'import { isCompanionThread, useWithoutCompanionProjects } from "../state/rubatoCompanion";\n'],
  ],
  'apps/web/src/routes/_chat.index.tsx': [
    ['  const projects = useProjects();\n',
      '  const projects = useWithoutCompanionProjects(useProjects());\n', 'replace'],
    ['import { useNewThreadHandler } from "../hooks/useHandleNewThread";\n',
      'import { useWithoutCompanionProjects } from "../state/rubatoCompanion";\n'],
  ],
  // The new-thread shortcuts (chat.newLocal, chat.new) from Segno's conversation, likewise. v0.1.11
  // keeps both shortcuts' thread context in one place, shortcuts/chatRouteCommands.ts.
  'apps/web/src/shortcuts/chatRouteCommands.ts': [
    ['      activeThread: activeThread ?? undefined,\n',
      '      activeThread: activeThread && !isCompanionThread(activeThread.id) ? activeThread : undefined,\n',
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
    ['    <SidebarInset\n      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"\n      inert={background}\n    >\n',
      '    <SidebarInset\n'
        + '      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"\n'
        + '      inert={background}\n'
        + '      data-rubato-segno-space-host={rubatoSegnoSpace ? "" : undefined}\n'
        + '    >\n',
      'replace'],
    // The room keeps T3's own hidden-thread wrapper: only what is inside it changes.
    ['        <HiddenThreadContext value={background}>{view}</HiddenThreadContext>\n',
      '        <HiddenThreadContext value={background}>\n'
        + '          {rubatoSegnoSpace ? (\n'
        + '            <RubatoSegnoSpace key={rubatoCurrentCompanion!.id} companionId={rubatoCurrentCompanion!.id}>\n'
        + '              {view}\n'
        + '            </RubatoSegnoSpace>\n'
        + '          ) : (\n'
        + '            view\n'
        + '          )}\n'
        + '        </HiddenThreadContext>\n',
      'replace'],
    ['import { SidebarInset } from "./ui/sidebar";\n',
      'import { RubatoSegnoSpace } from "./chat/RubatoSegnoSpace";\nimport { useRubatoCompanion } from "../state/rubatoCompanion";\n'],
  ],
  // A run that ends in Segno's thread notifies like a messenger — Segno's name, the start of what it
  // said, "Open" (chat/RubatoSegnoNotice.tsx); every other thread's notification is unchanged.
  // v0.1.11 reads the settings and the open thread inside present(), and its titles already go
  // through m(msg(...)), so nothing wraps them here.
  'apps/web/src/components/ThreadNotificationCoordinator.tsx': [
    ['import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";\n',
      'import { notifySegnoCompletion } from "./chat/RubatoSegnoNotice";\n'
        + 'import { isCompanionThread } from "../state/rubatoCompanion";\n'
        + 'import { rubatoPush } from "../state/rubatoPush";\n'],
    ['  const present = (\n', '  const present = async (\n', 'replace'],
    ['    const active = activeThread();\n',
      '    const active = activeThread();\n'
        + '    // Rubato: Segno\'s thread notifies like a messenger (companion-edits.mjs).\n'
        + '    if (kind === "completion" && isCompanionThread(thread.id)) {\n'
        + '      void notifySegnoCompletion({\n'
        + '        environmentId,\n'
        + '        threadId: thread.id,\n'
        + '        runId: state.raw.latestRunId ?? null,\n'
        + '        mode,\n'
        + '        inAppNotificationsEnabled,\n'
        + '        viewing: active.environmentId === environmentId && active.threadId === thread.id,\n'
        + '        open: () =>\n'
        + '          void router.navigate({\n'
        + '            to: "/$environmentId/$threadId",\n'
        + '            params: { environmentId, threadId: thread.id },\n'
        + '          }),\n'
        + '        onNotification: (notifiedEnvironmentId, notification) =>\n'
        + '          trackNotification(notifiedEnvironmentId, thread.id, notification),\n'
        + '      });\n'
        + '      return;\n'
        + '    }\n'
        + '    if (!isCompanionThread(thread.id) && (kind === "completion" || status === "failed")\n'
        + '      && await rubatoPush.desktopThreadMuted(environmentId, thread.id)) return;\n',
      'replace'],
  ],
  // Segno's header is just its name: its folder is not a project.
  'apps/web/src/components/chat/ChatHeader.tsx': [
    ['        {activeProject ? (\n', '        {activeProject && !isCompanionThread(activeThreadId) ? (\n', 'replace'],
    ['import { cn } from "~/lib/utils";\n', 'import { isCompanionThread } from "../../state/rubatoCompanion";\n'],
    // The companion's face before its name; it opens the companion's page, where the picture changes.
    ['        {parentThreadLink ? (\n',
      '        {isCompanionThread(activeThreadId) ? (\n'
        + '          <WorkspaceBreadcrumbItem className="shrink-0">\n'
        + '            <RubatoCompanionHeaderFace threadId={activeThreadId} />\n'
        + '          </WorkspaceBreadcrumbItem>\n'
        + '        ) : null}\n'],
    ['import { cn } from "~/lib/utils";\n', 'import { RubatoCompanionHeaderFace } from "./RubatoCompanionFace";\n'],
  ],
  // The thread list every sidebar section is laid out from.
  'apps/web/src/components/Sidebar.tsx': [
    ['  const threads = useQuietThreadShells();\n',
      '  // Rubato: Segno\'s conversation opens from the rail, not the list (companion-edits.mjs).\n'
        + '  const threads = useWithoutCompanionThread(useQuietThreadShells());\n',
      'replace'],
    ['import { environmentPresentations } from "../state/presentation";\n',
      'import { isCompanionThread, useWithoutCompanionThread } from "../state/rubatoCompanion";\n'],
    ['        activeThread: newThreadContext.activeThread ?? undefined,\n',
      '        activeThread:\n'
        + '          newThreadContext.activeThread && !isCompanionThread(newThreadContext.activeThread.id)\n'
        + '            ? newThreadContext.activeThread\n'
        + '            : undefined,\n',
      'replace'],
  ],
};
