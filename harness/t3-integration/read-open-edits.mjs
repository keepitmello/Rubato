// A tool row that read a file ("Read /tmp/rubato-look/switcher-check.png") has "Open"
// beside its time, like "Open subagent". It opens the file the way a file link in a
// reply does: an image in the expanded preview, any other file in the files panel,
// read-only when it is outside the workspace. Expanding the row still shows what the
// read returned at that time; "Open" shows the file as it is now.
//
// chat/RubatoReadOpenButton.tsx holds the button and which way a path opens.
export const readOpenOverlays = [
  'apps/web/src/components/chat/RubatoReadOpenButton.tsx',
  'apps/web/src/components/chat/RubatoReadOpenButton.test.ts',
];

const lines = (...parts) => parts.join('\n');

export const readOpenEdits = {
  'apps/web/src/components/chat/MessagesTimeline.test.tsx': [
    [
      'import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";\n',
      'import { useRightPanelStore } from "~/rightPanelStore";\n',
    ],
    [
      '  it("leads an unanswered question row with the question text", async () => {\n',
      lines(
        '  // Rubato: "Open" on a row that read a file (read-open-edits.mjs).',
        '  it("opens the file a read row read from its Open button", async () => {',
        '    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);',
        '    vi.stubGlobal("requestAnimationFrame", () => 0);',
        '    vi.stubGlobal("cancelAnimationFrame", () => {});',
        '    const openFile = vi.fn();',
        '    const originalOpenFile = useRightPanelStore.getState().openFile;',
        '    useRightPanelStore.setState({ openFile } as never);',
        '    const toolEntry = (id: string, toolName: string, path: string) => ({',
        '      id,',
        '      kind: "work" as const,',
        '      createdAt: MESSAGE_CREATED_AT,',
        '      entry: {',
        '        id,',
        '        createdAt: MESSAGE_CREATED_AT,',
        '        label: toolName,',
        '        toolTitle: toolName,',
        '        tone: "tool" as const,',
        '        itemType: "dynamic_tool" as const,',
        '        toolLifecycleStatus: "completed" as const,',
        '        toolData: { toolName, input: { path } },',
        '      },',
        '    });',
        '    let renderer: ReactTestRenderer | undefined;',
        '    try {',
        '      await act(() => {',
        '        renderer = create(',
        '          <MessagesTimeline',
        '            {...buildProps()}',
        '            timelineEntries={[toolEntry("read-report", "read", "/tmp/report.md")]}',
        '          />,',
        '        );',
        '      });',
        '      const open = renderer!.root.findByProps({ "aria-label": "Open /tmp/report.md" });',
        '      const stopPropagation = vi.fn();',
        '      await act(() => open.props.onClick({ stopPropagation }));',
        '      expect(stopPropagation).toHaveBeenCalled();',
        '      expect(openFile).toHaveBeenCalledWith(',
        '        expect.objectContaining({ threadId: "thread-1" }),',
        '        "/tmp/report.md",',
        '      );',
        '',
        '      await act(() => {',
        '        renderer!.update(',
        '          <MessagesTimeline',
        '            {...buildProps()}',
        '            timelineEntries={[toolEntry("edit-report", "edit", "/tmp/report.md")]}',
        '          />,',
        '        );',
        '      });',
        '      expect(renderer!.root.findAllByProps({ "aria-label": "Open /tmp/report.md" })).toHaveLength(0);',
        '    } finally {',
        '      await act(() => renderer?.unmount());',
        '      useRightPanelStore.setState({ openFile: originalOpenFile } as never);',
        '    }',
        '  });',
        '',
        '',
      ),
    ],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    [
      'import { FetchedToolOutput, V2ItemInspector } from "./V2ItemInspector";\n',
      'import { RubatoReadOpenButton, rubatoReadOpenTarget } from "./RubatoReadOpenButton";\n',
    ],
    [
      '  const viewedImage =\n    viewedImagePath && threadRef\n',
      lines(
        '  // Rubato: the file a read row opens from its "Open" button (read-open-edits.mjs).',
        '  const readOpenTarget =',
        '    toolGroupAction(workEntry) === "read"',
        '      ? rubatoReadOpenTarget(workEntryReadOutput(workEntry, workspaceRoot), workspaceRoot)',
        '      : null;',
        '',
      ),
    ],
    [
      '          {showFailedIndicator &&\n          !showDestructiveRowStyle &&\n          !toolIconAcceptsTint(entryToolIcon) ? (\n',
      lines(
        '          {readOpenTarget && threadRef ? (',
        '            <RubatoReadOpenButton',
        '              target={readOpenTarget}',
        '              threadRef={threadRef}',
        '              workspaceRoot={workspaceRoot}',
        '              onImageExpand={onImageExpand}',
        '            />',
        '          ) : null}',
        '',
      ),
    ],
  ],
};
