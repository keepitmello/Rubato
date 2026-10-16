// V1 web half of step rewind, split out for `ui` to port onto V2 (contract: step-rewind-edits.mjs).
// Rewinding to a finished tool step, not only to a message of mine. Every tool row in the
// timeline offers "rewind to here"; hovering shows what goes, and the inline card rewinds
// and then either takes an instruction from the composer or continues on its own.
//
// - The revert command carries an optional `step` (the row's call id and turn). The
//   checkpoint reactor reads when that step finished from the turn's tool rows
//   (rubatoStepRewind.ts revertCutFor) and puts that instant on thread.reverted as `cut`;
//   the three projections drop that turn's rows stamped after it (keptAfterRevertCut).
// - Rubato lands on the step's last tool result (pi-runtime conversation-rewind), so
//   every message the model saw before stays byte for byte and the next request reads
//   the cached prefix. /rubato/step-rewind/continue (RubatoStepContinue.ts) runs on from there.
// - A thread with its own worktree keeps the files each tool step left (a checkpoint ref
//   per call); a step rewind can put them back, and the kept turn's checkpoint becomes
//   that state so the next turn's diff starts from it.
// - The bridge tags tool rows with the batch they were called in (`rubatoStep`); the
//   activity projection passes it to clients so the timeline cuts after the whole batch.
// - Folded rows rewind too, with nothing expanded: "Worked for" and a tool group's row
//   land after the last step under them, and a reply's action row lands right after the
//   reply (an ordinary turn revert).
// - A toast that is limited out of the stack or leaving is invisible, and it no longer
//   catches the pointer: it covered the top right, where a just-sent message sits, so
//   hovering that message showed no "Edit from here".
export const stepRewindUiOverlays = [
  'packages/shared/src/rubatoStepRewind.ts',
  'apps/web/src/components/chat/RubatoStepRewind.tsx',
  'apps/web/src/components/chat/RubatoStepRewind.test.ts',
];

const lines = (...parts) => parts.join('\n');
const CUT_IMPORT = 'import { keptAfterRevertCut } from "@t3tools/shared/rubatoRevertRetention";\n';

// The tool group header as T3 renders it, and the same header with the rewind button.
const ACTIVITY_GROUP_HEADER = "  return (\n    <div>\n      <button\n        type=\"button\"\n        className=\"group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70\"\n        aria-label={failed ? `${label}, tool call failed` : undefined}\n        aria-expanded={row.expanded}\n        onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}\n      >\n        <DwellingLiveActivityRow\n          dwellKey={row.active ? label : null}\n          label={label}\n          iconName={iconWork ? workEntryIconName(iconWork) : \"brain\"}\n          toolIcon={iconWork?.toolIcon ?? iconWork?.toolSource?.icon}\n          failed={failed}\n          active={row.active}\n          shimmer={thinking}\n        />\n      </button>\n      {row.expanded ? <div className=\"mt-2\">{details}</div> : null}\n";
const ACTIVITY_GROUP_HEADER_WITH_REWIND = "  const rubatoGroupActivity = use(TimelineRowActivityCtx);\n  return (\n    <div>\n      <div className=\"group/timeline-row flex items-center gap-1\">\n        <button\n          type=\"button\"\n          className=\"group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70\"\n          aria-label={failed ? `${label}, tool call failed` : undefined}\n          aria-expanded={row.expanded}\n          onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}\n        >\n          <DwellingLiveActivityRow\n            dwellKey={row.active ? label : null}\n            label={label}\n            iconName={iconWork ? workEntryIconName(iconWork) : \"brain\"}\n            toolIcon={iconWork?.toolIcon ?? iconWork?.toolSource?.icon}\n            failed={failed}\n            active={row.active}\n            shimmer={thinking}\n          />\n        </button>\n        <RubatoStepRewindButton\n          threadKey={ctx.routeThreadKey}\n          threadRef={ctx.threadRef}\n          target={{\n            kind: \"last-step\",\n            turnId: row.turnId,\n            toolCallIds: work.map((entry) => entry.toolCallId),\n          }}\n          label={label}\n          busy={\n            row.active || rubatoGroupActivity.isWorking || rubatoGroupActivity.isRevertingCheckpoint\n          }\n        />\n      </div>\n      {row.expanded ? <div className=\"mt-2\">{details}</div> : null}\n";

export const stepRewindUiEdits = {
  'packages/shared/package.json': [
    [lines(
      '    "./dateTime": {',
      '      "types": "./src/dateTime.ts",',
      '      "import": "./src/dateTime.ts"',
      '    },',
      ''), lines(
      '    "./rubatoStepRewind": {',
      '      "types": "./src/rubatoStepRewind.ts",',
      '      "import": "./src/rubatoStepRewind.ts"',
      '    },',
      '')],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";\n', lines(
      'import {',
      '  RUBATO_STEP_DROPPED_CLASS,',
      '  RubatoStepRewindButton,',
      '  RubatoStepRewindMarker,',
      '  useRubatoStepRewindDropped,',
      '} from "./RubatoStepRewind";',
      '')],
    // A message row the shown rewind would drop fades.
    ['const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {\n', lines(
      'const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {',
      '  const rubatoDropped = useRubatoStepRewindDropped(',
      '    use(TimelineRowCtx).routeThreadKey,',
      '    row.kind === "message" ? row.message : undefined,',
      '  );',
      ''), 'replace'],
    [lines(
      '          ? "group/assistant"',
      '          : null,',
      '      )}',
      '      data-timeline-row-id={row.id}',
      ''), lines(
      '          ? "group/assistant"',
      '          : null,',
      '        rubatoDropped ? RUBATO_STEP_DROPPED_CLASS : null,',
      '      )}',
      '      data-timeline-row-id={row.id}',
      ''), 'replace'],
    // A tool row: its rewind button, its fade, and the marker of a rewind waiting after it.
    ['  const { threadRef, onImageExpand, timestampFormat } = use(TimelineRowCtx);\n', lines(
      '  const { threadRef, onImageExpand, timestampFormat } = use(TimelineRowCtx);',
      '  const { routeThreadKey: rubatoThreadKey } = use(TimelineRowCtx);',
      '  const rubatoActivity = use(TimelineRowActivityCtx);',
      '  const rubatoDropped = useRubatoStepRewindDropped(rubatoThreadKey, workEntry);',
      ''), 'replace'],
    ['        expanded && "mb-1",\n', '        rubatoDropped && RUBATO_STEP_DROPPED_CLASS,\n'],
    [lines(
      '            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />',
      '          ) : null}',
      '          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />',
      ''), lines(
      '            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />',
      '          ) : null}',
      '          <RubatoStepRewindButton',
      '            threadKey={rubatoThreadKey}',
      '            threadRef={threadRef}',
      '            target={{ kind: "step", toolCallId: workEntry.toolCallId, turnId: workEntry.turnId }}',
      '            label={previewText}',
      '            busy={rubatoActivity.isWorking || rubatoActivity.isRevertingCheckpoint}',
      '          />',
      '          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />',
      ''), 'replace'],
    [lines(
      '          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>',
      '        </div>',
      '      ) : null}',
      '    </div>',
      '  );',
      '});',
      ''), lines(
      '          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>',
      '        </div>',
      '      ) : null}',
      '      <RubatoStepRewindMarker threadKey={rubatoThreadKey} anchorId={workEntry.toolCallId} />',
      '    </div>',
      '  );',
      '});',
      ''), 'replace'],
    // "Worked for": after the turn's last step, with nothing expanded.
    ['  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;\n', lines(
      '  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;',
      '  const rubatoFoldActivity = use(TimelineRowActivityCtx);',
      ''), 'replace'],
    [lines(
      '      <TimelineRowTimestamp',
      '        createdAt={row.createdAt}',
      '        timestampFormat={ctx.timestampFormat}',
      '        className="ms-auto"',
      '      />',
      '    </div>',
      '  );',
      '}',
      ''), lines(
      '      <TimelineRowTimestamp',
      '        createdAt={row.createdAt}',
      '        timestampFormat={ctx.timestampFormat}',
      '        className="ms-auto"',
      '      />',
      '      <RubatoStepRewindButton',
      '        threadKey={ctx.routeThreadKey}',
      '        threadRef={ctx.threadRef}',
      '        target={{ kind: "last-step", turnId: row.turnId }}',
      '        label="this work"',
      '        busy={rubatoFoldActivity.isWorking || rubatoFoldActivity.isRevertingCheckpoint}',
      '      />',
      '    </div>',
      '  );',
      '}',
      ''), 'replace'],
    // A tool group's row: after its last step. The header is a button, so the rewind
    // button sits beside it.
    [ACTIVITY_GROUP_HEADER, ACTIVITY_GROUP_HEADER_WITH_REWIND, 'replace'],
    // A reply's action row: right after that reply.
    [lines(
      '}) {',
      '  const ctx = use(TimelineRowCtx);',
      '',
      '  return (',
      '    <div',
      '      className={cn(',
      '        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",',
      ''), lines(
      '}) {',
      '  const ctx = use(TimelineRowCtx);',
      '  const rubatoMetaActivity = use(TimelineRowActivityCtx);',
      '',
      '  return (',
      '    <div',
      '      className={cn(',
      '        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",',
      ''), 'replace'],
    [lines(
      '      <AssistantCopyButton',
      '        message={message}',
      '        showCopyButton={showCopyButton}',
      '        streaming={copyStreaming}',
      '      />',
      ''), lines(
      '      <AssistantCopyButton',
      '        message={message}',
      '        showCopyButton={showCopyButton}',
      '        streaming={copyStreaming}',
      '      />',
      '      <RubatoStepRewindButton',
      '        threadKey={ctx.routeThreadKey}',
      '        threadRef={ctx.threadRef}',
      '        target={{ kind: "reply", turnId: message.turnId, messageId: message.id }}',
      '        label="this reply"',
      '        busy={',
      '          Boolean(message.streaming) ||',
      '          message.turnId === rubatoMetaActivity.latestTurnId ||',
      '          rubatoMetaActivity.isWorking ||',
      '          rubatoMetaActivity.isRevertingCheckpoint',
      '        }',
      '        reveal="inherit"',
      '      />',
      ''), 'replace'],
    [lines(
      '            copyStreaming={row.assistantCopyStreaming}',
      '          />',
      '        ) : null}',
      '      </div>',
      '    </>',
      ''), lines(
      '            copyStreaming={row.assistantCopyStreaming}',
      '          />',
      '        ) : null}',
      '        <RubatoStepRewindMarker threadKey={ctx.routeThreadKey} anchorId={row.message.id} />',
      '      </div>',
      '    </>',
      ''), 'replace'],
  ],
  'apps/web/src/components/ui/toast.tsx': [
    ['                "data-limited:opacity-0",\n',
      '                "data-limited:pointer-events-none data-limited:opacity-0",\n', 'replace'],
    ['                "data-ending-style:opacity-0",\n',
      '                "data-ending-style:pointer-events-none data-ending-style:opacity-0",\n', 'replace'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { appAtomRegistry } from "../rpc/atomRegistry";\n',
      'import {\n  landRubatoStepRewind,\n  RubatoStepRewindComposerTag,\n  useRubatoStepRewindHost,\n} from "./chat/RubatoStepRewind";\n'],
    ['  const onRevertToTurnCount = useCallback(\n', lines(
      '  // Rubato: a rewind to a tool step borrows the revert command and the composer.',
      '  useRubatoStepRewindHost(routeThreadKey, {',
      '    threadRef: routeThreadRef,',
      '    canRestoreFiles: activeWorktreePath !== null,',
      '    focusComposer: () => composerRef.current?.focusAtEnd(),',
      '    revert: async ({ turnCount, restoreFiles, step }) => {',
      '      if (!activeThread) throw new Error("This thread is not loaded.");',
      '      const result = await revertThreadCheckpoint({',
      '        environmentId,',
      '        input: { threadId: activeThread.id, turnCount, restoreFiles, ...(step ? { step } : {}) },',
      '      });',
      '      if (result._tag === "Failure") throw squashAtomCommandFailure(result);',
      '    },',
      '  });',
      '')],
    [lines(
      '      onAdvanceActivePendingUserInput();',
      '      return;',
      '    }',
      '    const sendCtx = composerRef.current?.getSendContext();',
      ''), lines(
      '      onAdvanceActivePendingUserInput();',
      '      return;',
      '    }',
      '    // Rubato: a rewind to a tool step waiting for this message lands first.',
      '    if (!(await landRubatoStepRewind(routeThreadKey))) return;',
      '    const sendCtx = composerRef.current?.getSendContext();',
      ''), 'replace'],
    ['                    <ComposerSurface.Shell contextStrip={showComposerContextStrip}>\n',
      '                    <RubatoStepRewindComposerTag threadKey={routeThreadKey} />\n'],
  ],
};
