// The right panel's Side chat: a throwaway fork of the thread's conversation beside it, the
// way Codex's /side works. It sits in the surface launcher right under Terminal.
//
// - /rubato/side-chat and /rubato/side-chat/close on the server (RubatoSideChat.ts) fork the
//   thread's Pi session as a side chat and delete it again. The engine writes a hidden notice
//   after the copied history, so the model knows it is in a side chat and the bytes the parent
//   cached stay the same (pi-runtime session-link/side-chat.mjs);
// - a `side-chat` surface kind in the panel store, carrying the side chat's thread id;
// - the panel (RubatoSideChatPanel.tsx) draws that thread with the thread timeline and a plain
//   composer that keeps the source's model;
// - rubatoSideChat.ts deletes a side chat whenever its tab leaves the panel, by any close path;
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
];

const SURFACE = '  | { id: "agents"; kind: "agents" };';
const EXCLUDED = 'Exclude<RightPanelKind, "file" | "terminal" | "pull-request">';
const EXCLUDED_SIDE = 'Exclude<RightPanelKind, "file" | "terminal" | "pull-request" | "side-chat">';

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
      '  /** Rubato: a throwaway fork of the thread\'s conversation (components/rubatoSideChat.ts). */',
      '  | { id: `side-chat:${string}`; kind: "side-chat"; threadId: string };',
    ].join('\n'), 'replace'],
    [`  open: (\n    ref: ScopedThreadRef,\n    kind: ${EXCLUDED},`,
      `  open: (\n    ref: ScopedThreadRef,\n    kind: ${EXCLUDED_SIDE},`, 'replace'],
    [`  toggle: (\n    ref: ScopedThreadRef,\n    kind: ${EXCLUDED},`,
      `  toggle: (\n    ref: ScopedThreadRef,\n    kind: ${EXCLUDED_SIDE},`, 'replace'],
    ['  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "pull-request">,\n): RightPanelSurface => {',
      '  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "pull-request" | "side-chat">,\n): RightPanelSurface => {',
      'replace'],
    ['  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;\n',
      '  /** Rubato: opens the side chat `threadId` as a tab of `ref` (components/rubatoSideChat.ts). */\n  openSideChat: (ref: ScopedThreadRef, threadId: string) => void;\n'],
    ['      openBrowser: (ref, tabId) =>\n', [
      '      openSideChat: (ref, threadId) =>',
      '        set((state) =>',
      '          userAction(state, scopedThreadKey(ref), (current) =>',
      '            upsertSurface(current, { id: `side-chat:${threadId}`, kind: "side-chat", threadId }),',
      '          ),',
      '        ),',
      '',
    ].join('\n')],
    ['                    if (surface.kind !== "terminal") return [surface];\n', [
      '                    if (surface.kind === "side-chat") {',
      '                      return typeof surface.threadId === "string" &&',
      '                        surface.id === `side-chat:${surface.threadId}`',
      '                        ? [surface]',
      '                        : [];',
      '                    }',
      '',
    ].join('\n')],
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
      'import { RubatoSideChatPanel } from "./RubatoSideChatPanel";',
      'import { openSideChat, sideChatSourceReady, watchSideChatTabs } from "./rubatoSideChat";',
      'import { threadRunsOnRubato } from "./sidebar/rubatoThreadFork";',
      '',
    ].join('\n')],
    ['  const addAgentsSurface = useCallback(() => {\n', [
      '  // Rubato: the Side chat surface (rubatoSideChat.ts). Closing its tab deletes it.',
      '  useEffect(() => watchSideChatTabs(), []);',
      '  const sideChatAvailable = sideChatSourceReady(',
      '    activeServerThread,',
      '    activeServerThread !== null && threadRunsOnRubato(activeServerThread),',
      '  );',
      '  const addSideChatSurface = useCallback(async () => {',
      '    if (!activeThreadRef) return;',
      '    const ref = activeThreadRef;',
      '    const progress = toastManager.add({ type: "loading", title: "Opening a side chat…" });',
      '    try {',
      '      const side = await openSideChat(ref);',
      '      toastManager.close(progress);',
      '      useRightPanelStore.getState().openSideChat(ref, side.threadId);',
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
      '        key={renderedRightPanelSurface.id}',
      '        environmentId={activeThreadRef.environmentId}',
      '        threadId={renderedRightPanelSurface.threadId}',
      '        workspaceRoot={activeWorkspaceRoot}',
      '      />',
      '',
    ].join('\n')],
    ['\n          onAddDevice={addDeviceSurface}\n', panelProps('          ')],
    ['\n            onAddDevice={addDeviceSurface}\n', panelProps('            ')],
  ],
};
