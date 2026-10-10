// The right panel's Side chat: forks of the thread's conversation beside it, the way Codex's
// /side works. It sits in the surface launcher right under Terminal.
//
// - /rubato/side-chat, /list and /close on the server (RubatoSideChat.ts) fork the thread's Pi
//   session as a side chat, list the thread's side chats and delete one. The engine writes a
//   hidden notice after the copied history, so the model knows it is in a side chat and the bytes
//   the parent cached stay the same (pi-runtime session-link/side-chat.mjs);
// - a singleton `side-chat` surface: the panel (RubatoSideChatPanel.tsx) lists the thread's side
//   chats and opens one in place of the list, like the Agents panel opens an agent. Closing the
//   tab keeps them; Side chat in the launcher brings the list back, or starts one when none exist;
// - what the Agents and Side chat surfaces have open survives a thread switch (rubatoPanelViews.ts);
// - the client's shell leaves side chat threads out (packages/shared rubatoSideChat.ts), so no
//   sidebar, search or notification lists them; the panel reads the thread's detail instead.
export const sideChatOverlays = [
  'packages/shared/src/rubatoSideChat.ts',
  'packages/shared/src/rubatoSideChat.test.ts',
  'apps/server/src/RubatoSideChat.ts',
  'apps/server/src/RubatoSideChat.test.ts',
  'apps/web/src/components/rubatoSideChat.ts',
  'apps/web/src/components/rubatoSideChat.test.ts',
  'apps/web/src/components/RubatoSideChatPanel.tsx',
  'apps/web/src/rubatoPanelViews.ts',
  'apps/web/src/rubatoPanelViews.test.ts',
];

const SURFACE = '  | { id: "agents"; kind: "agents" };';

const launcherAction = (reasons, badge) => [
  '    {',
  '      label: "Side chat",',
  '      icon: MessagesSquare,',
  '      shortcut: "S",',
  '      available: props.sideChatAvailable === true,',
  `      disabledReason: ${reasons},`,
  '      onClick: () => props.onAddSideChat?.(),',
  ...(badge ? ['      badgeCount: 0,'] : []),
  '    },',
  '',
].join('\n');

const panelProps = (indent) => [
  '',
  `${indent}onAddSideChat={addSideChatSurface}`,
  `${indent}sideChatAvailable={sideChatAvailable}`,
].join('\n');

export const sideChatEdits = {
  'packages/shared/package.json': [
    [`    "./dateTime": {
      "types": "./src/dateTime.ts",
      "import": "./src/dateTime.ts"
    },
`, `    "./rubatoSideChat": {
      "types": "./src/rubatoSideChat.ts",
      "import": "./src/rubatoSideChat.ts"
    },
`],
  ],
  'packages/client-runtime/src/state/shell.ts': [
    ['import { applyShellStreamEvent } from "./shellReducer.ts";\n',
      'import { addsSideChat, withoutSideChats } from "@t3tools/shared/rubatoSideChat";\n'],
    [`        item.kind === "snapshot"
          ? item.snapshot
          : Option.match(next.snapshot, {
              onNone: () => null,
              onSome: (snapshot) =>
                item.sequence > snapshot.snapshotSequence
                  ? applyShellStreamEvent(snapshot, item)
                  : snapshot,
            });`, `        item.kind === "snapshot"
          ? withoutSideChats(item.snapshot)
          : Option.match(next.snapshot, {
              onNone: () => null,
              onSome: (snapshot) =>
                item.sequence > snapshot.snapshotSequence
                  ? addsSideChat(item)
                    ? { ...snapshot, snapshotSequence: item.sequence }
                    : applyShellStreamEvent(snapshot, item)
                  : snapshot,
            });`, 'replace'],
  ],
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";',
      'import { rubatoSideChatRouteLayer } from "./RubatoSideChat.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoSideChatRouteLayer,\n'],
  ],
  'apps/web/src/rightPanelStore.ts': [
    ['  "agents",\n] as const;', '  "agents",\n  "side-chat",\n] as const;', 'replace'],
    [SURFACE, [
      '  | { id: "agents"; kind: "agents" }',
      '  /** Rubato: the thread\'s side chats (components/rubatoSideChat.ts). */',
      '  | { id: "side-chat"; kind: "side-chat" };',
    ].join('\n'), 'replace'],
    ['    case "agents":\n      return { id: "agents", kind };\n',
      '    case "side-chat":\n      return { id: "side-chat", kind };\n'],
  ],
  'apps/web/src/components/RightPanelTabs.tsx': [
    ['  TerminalSquare,\n', '  MessagesSquare,\n'],
    ["/** Overlays that must win over the launcher's letter shortcuts. */",
      'const SIDE_CHAT_UNAVAILABLE = "Side chat needs a Rubato thread that has run.";\n\n'],
    ['  liveAgentCount: number;\n  children: ReactNode;\n',
      '  /** Rubato: a throwaway fork of the thread (rubatoSideChat.ts). */\n  onAddSideChat?: () => void;\n  sideChatAvailable?: boolean;\n'],
    ['  liveAgentCount: number;\n}) {', '  onAddSideChat?: (() => void) | undefined;\n  sideChatAvailable?: boolean | undefined;\n'],
    ['    {\n      label: "Files",\n      icon: Files,\n      shortcut: "F",\n      available: props.filesAvailable,\n      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,',
      launcherAction('SIDE_CHAT_UNAVAILABLE', true)],
    ['    {\n      label: "Files",\n      icon: Files,\n      shortcut: "F",\n      available: props.filesAvailable,\n      disabledReason: SURFACE_DISABLED_REASONS.files,',
      launcherAction('SIDE_CHAT_UNAVAILABLE', false)],
    ['    case "agents":\n      return "Agents";\n', '    case "side-chat":\n      return "Side chat";\n'],
    ['    case "agents":\n      return <Bot className="size-3 shrink-0" />;\n',
      '    case "side-chat":\n      return <MessagesSquare className="size-3 shrink-0" />;\n'],
    ['            onAddAgents={props.onAddAgents}\n',
      '            onAddSideChat={props.onAddSideChat}\n            sideChatAvailable={props.sideChatAvailable}\n'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { stackedThreadToast, toastManager } from "./ui/toast";\n', [
      'import { setOpenedInPanel, usePanelViewStore, watchPanelViews } from "../rubatoPanelViews";',
      'import { RubatoSideChatPanel } from "./RubatoSideChatPanel";',
      'import { createSideChat, deleteSideChatIfEmpty, listSideChats, sideChatRef, sideChatSourceReady } from "./rubatoSideChat";',
      'import { threadRunsOnRubato } from "./sidebar/rubatoThreadFork";',
      '',
    ].join('\n')],
    ['  const addAgentsSurface = useCallback(() => {\n', [
      '  // Rubato: what the Agents and Side chat tabs have open survives a thread switch, and a side',
      '  // chat left without a word is deleted when its tab closes (rubatoPanelViews.ts).',
      '  useEffect(',
      '    () =>',
      '      watchPanelViews({',
      '        onSideChatLeft: (owner, sideThreadId) =>',
      '          deleteSideChatIfEmpty(sideChatRef(owner.environmentId, sideThreadId)),',
      '      }),',
      '    [],',
      '  );',
      '  const sideChatAvailable = sideChatSourceReady(',
      '    activeServerThread,',
      '    activeServerThread !== null && threadRunsOnRubato(activeServerThread),',
      '  );',
      '  // Side chat shows the side chat that was open, else the list, else starts the first one.',
      '  const addSideChatSurface = useCallback(async () => {',
      '    if (!activeThreadRef) return;',
      '    const ref = activeThreadRef;',
      '    const key = scopedThreadKey(ref);',
      '    const show = () => useRightPanelStore.getState().open(ref, "side-chat");',
      '    if (usePanelViewStore.getState().opened["side-chat"][key]) return show();',
      '    const existing = await listSideChats(ref).catch(() => null);',
      '    if (existing === null || existing.length > 0) return show();',
      '    const progress = toastManager.add({ type: "loading", title: "Opening a side chat…" });',
      '    try {',
      '      const side = await createSideChat(ref);',
      '      toastManager.close(progress);',
      '      setOpenedInPanel("side-chat", key, side.threadId);',
      '      show();',
      '    } catch (error) {',
      '      toastManager.update(',
      '        progress,',
      '        stackedThreadToast({',
      '          type: "error",',
      '          title: "Could not open a side chat",',
      '          description: error instanceof Error ? error.message : "An error occurred.",',
      '        }),',
      '      );',
      '    }',
      '  }, [activeThreadRef]);',
      '',
    ].join('\n')],
    ['    ) : renderedRightPanelSurface?.kind === "agents" ? (\n', [
      '    ) : renderedRightPanelSurface?.kind === "side-chat" && activeThreadRef ? (',
      '      <RubatoSideChatPanel',
      '        environmentId={activeThreadRef.environmentId}',
      '        threadId={activeThreadRef.threadId}',
      '        workspaceRoot={activeWorkspaceRoot}',
      '      />',
      '',
    ].join('\n')],
    ['\n          onAddDevice={addDeviceSurface}\n', panelProps('          ')],
    ['\n            onAddDevice={addDeviceSurface}\n', panelProps('            ')],
  ],
};
