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
  // T3 splits the timeline's rows into their own modules; a work row is drawn here.
  'apps/web/src/components/chat/TimelineWorkEntryRow.tsx': [
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
