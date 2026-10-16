// Rewinding to a finished tool step, not only to a message of mine: the web half
// (chat/RubatoStepRewind.tsx). The server half is step-rewind-edits.mjs.
//
// Every finished Rubato tool row in the timeline offers "rewind to here"; hovering fades
// what goes, and the inline card rewinds and then either takes an instruction from the
// composer or continues on its own (POST /rubato/step-rewind, then /rubato/step-rewind/
// continue). Folded rows rewind too, with nothing expanded: "Worked for" and a tool
// group's row land after the last step under them, and a reply's action row lands right
// after the reply (T3's ordinary revert). A run a step rewind cut is not offered T3's
// Resume, which would send a prompt; the card's continue resumes it instead.
//
// A toast that is limited out of the stack or leaving is invisible, and it no longer
// catches the pointer: it covered the top right, where a just-sent message sits.
export const stepRewindUiOverlays = [
  'apps/web/src/components/chat/RubatoStepRewind.tsx',
  'apps/web/src/components/chat/RubatoStepRewind.test.ts',
];

const lines = (...parts) => parts.join('\n');

export const stepRewindUiEdits = {
  // A tool group's row names the steps under it, so its rewind lands after the last.
  'apps/web/src/components/chat/MessagesTimeline.logic.ts': [
    ['      summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request";\n      hasFailure: boolean;\n',
      '      summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request";\n      hasFailure: boolean;\n      /** Rubato: the items under this group, for its step rewind. */\n      stepItemIds?: ReadonlyArray<string | undefined>;\n',
      'replace'],
    ['            hiddenCount: visibleGroupedEntries.length,\n            expanded,\n',
      '            hiddenCount: visibleGroupedEntries.length,\n            stepItemIds: visibleGroupedEntries.map((entry) => entry.projectedItem?.item.id),\n            expanded,\n',
      'replace'],
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
      '    row.kind === "message" ? { messageId: row.message.id } : undefined,',
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
    ['  const { threadRef, onImageExpand, timestampFormat } = ctx;\n  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;\n', lines(
      '  const { threadRef, onImageExpand, timestampFormat } = ctx;',
      '  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;',
      '  const rubatoItem = workEntry.projectedItem?.item;',
      '  const rubatoActivity = use(TimelineRowActivityCtx);',
      '  const rubatoDropped = useRubatoStepRewindDropped(ctx.routeThreadKey, { itemId: rubatoItem?.id });',
      ''), 'replace'],
    ['  return (\n    <WorkLogRow\n      data-v2-item-type={workEntry.projectedItem?.item.type}\n',
      '  return (\n    <div className={rubatoDropped ? RUBATO_STEP_DROPPED_CLASS : undefined}>\n    <WorkLogRow\n      data-v2-item-type={workEntry.projectedItem?.item.type}\n',
      'replace'],
    [lines(
      '            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />',
      '          ) : null}',
      '          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />',
      ''), lines(
      '            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />',
      '          ) : null}',
      '          <RubatoStepRewindButton',
      '            threadKey={ctx.routeThreadKey}',
      '            threadRef={threadRef}',
      '            target={{ kind: "step", itemId: rubatoItem?.id, runId: rubatoItem?.runId }}',
      '            item={rubatoItem}',
      '            label={previewText}',
      '            busy={rubatoActivity.isWorking || rubatoActivity.isRevertingCheckpoint}',
      '          />',
      '          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />',
      ''), 'replace'],
    ['        </WorkLogDetails>\n      ) : null}\n    </WorkLogRow>\n  );\n}\n\nfunction QuestionAnswerHistory(',
      '        </WorkLogDetails>\n      ) : null}\n    </WorkLogRow>\n    <RubatoStepRewindMarker threadKey={ctx.routeThreadKey} anchorId={rubatoItem?.id} />\n    </div>\n  );\n}\n\nfunction QuestionAnswerHistory(',
      'replace'],
    // "Worked for": after the run's last step, with nothing expanded.
    [lines(
      'function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {',
      '  const ctx = use(TimelineRowCtx);',
      ''), lines(
      'function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {',
      '  const ctx = use(TimelineRowCtx);',
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
      '',
      'function AttemptFoldTimelineRow('), lines(
      '      <TimelineRowTimestamp',
      '        createdAt={row.createdAt}',
      '        timestampFormat={ctx.timestampFormat}',
      '        className="ms-auto"',
      '      />',
      '      <RubatoStepRewindButton',
      '        threadKey={ctx.routeThreadKey}',
      '        threadRef={ctx.threadRef}',
      '        target={{ kind: "last-step", runId: row.runId }}',
      '        label="this work"',
      '        busy={rubatoFoldActivity.isWorking || rubatoFoldActivity.isRevertingCheckpoint}',
      '      />',
      '    </div>',
      '  );',
      '}',
      '',
      'function AttemptFoldTimelineRow('), 'replace'],
    // A tool group's row: after its last step. The header is a button, so the rewind
    // button sits beside it.
    [lines(
      '  const ctx = use(TimelineRowCtx);',
      '  return (',
      '    <WorkGroupHeader',
      '      label={row.summary}',
      ''), lines(
      '  const ctx = use(TimelineRowCtx);',
      '  const rubatoGroupActivity = use(TimelineRowActivityCtx);',
      '  return (',
      '    <div className="group/timeline-row flex items-center gap-1">',
      '    <div className="min-w-0 flex-1">',
      '    <WorkGroupHeader',
      '      label={row.summary}',
      ''), 'replace'],
    [lines(
      '      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}',
      '    />',
      '  );',
      '}',
      '',
      'function WorkGroupHeader('), lines(
      '      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}',
      '    />',
      '    </div>',
      '    <RubatoStepRewindButton',
      '      threadKey={ctx.routeThreadKey}',
      '      threadRef={ctx.threadRef}',
      '      target={{ kind: "last-step", runId: row.runId, ...(row.stepItemIds ? { itemIds: row.stepItemIds } : {}) }}',
      '      label={row.summary}',
      '      busy={rubatoGroupActivity.isWorking || rubatoGroupActivity.isRevertingCheckpoint}',
      '    />',
      '    </div>',
      '  );',
      '}',
      '',
      'function WorkGroupHeader('), 'replace'],
    // A reply's action row: right after that reply, and the marker of a rewind waiting there.
    [lines(
      '  alwaysVisible?: boolean;',
      '}) {',
      '  const ctx = use(TimelineRowCtx);',
      ''), lines(
      '  alwaysVisible?: boolean;',
      '}) {',
      '  const ctx = use(TimelineRowCtx);',
      '  const rubatoMetaActivity = use(TimelineRowActivityCtx);',
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
      '        target={{ kind: "reply", runId: message.runId, messageId: message.id }}',
      '        label="this reply"',
      '        busy={',
      '          Boolean(message.streaming) ||',
      '          message.runId === rubatoMetaActivity.latestRunId ||',
      '          rubatoMetaActivity.isWorking ||',
      '          rubatoMetaActivity.isRevertingCheckpoint',
      '        }',
      '        reveal="inherit"',
      '      />',
      ''), 'replace'],
    [lines(
      '        copyStreaming={row.assistantCopyStreaming}',
      '        alwaysVisible',
      '      />',
      '    </div>',
      ''), lines(
      '        copyStreaming={row.assistantCopyStreaming}',
      '        alwaysVisible',
      '      />',
      '      <RubatoStepRewindMarker threadKey={use(TimelineRowCtx).routeThreadKey} anchorId={row.message.id} />',
      '    </div>',
      ''), 'replace'],
  ],
  'apps/web/src/components/ui/toast.tsx': [
    ['                "data-limited:opacity-0",\n',
      '                "data-limited:pointer-events-none data-limited:opacity-0",\n', 'replace'],
    ['                "data-ending-style:opacity-0",\n',
      '                "data-ending-style:pointer-events-none data-ending-style:opacity-0",\n', 'replace'],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { appAtomRegistry } from "../rpc/atomRegistry";\n', lines(
      'import {',
      '  isStepCutRun,',
      '  landRubatoStepRewind,',
      '  RubatoStepRewindComposerTag,',
      '  useRubatoStepRewindHost,',
      '} from "./chat/RubatoStepRewind";',
      '')],
    // A run a step rewind cut continues from the card, not with T3's Resume prompt.
    ['    if (run?.status === "interrupted") return run.id;\n',
      '    if (run?.status === "interrupted" && !isStepCutRun(serverProjection.runs, run.id)) return run.id;\n',
      'replace'],
    ['  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);\n', lines(
      '  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);',
      '  // Rubato: a rewind to a tool step borrows the revert command and the composer.',
      '  useRubatoStepRewindHost(routeThreadKey, {',
      '    threadRef: routeThreadRef,',
      '    canRestoreFiles: activeThreadWorktreePath !== null,',
      '    focusComposer: () => composerRef.current?.focusAtEnd(),',
      '    revert: async ({ turnCount, restoreFiles }) => {',
      '      if (!activeThread) throw new Error("This thread is not loaded.");',
      '      const result = await revertThreadCheckpoint({',
      '        environmentId,',
      '        input: { commandId: CommandId.make(randomUUID()), threadId: activeThread.id, turnCount, restoreFiles },',
      '      });',
      '      if (result._tag === "Failure") throw squashAtomCommandFailure(result);',
      '    },',
      '  });',
      ''), 'replace'],
    [lines(
      '      return;',
      '    }',
      '    const sendCtx = composerRef.current?.getSendContext();',
      ''), lines(
      '      return;',
      '    }',
      '    // Rubato: a rewind to a tool step waiting for this message lands first.',
      '    if (!(await landRubatoStepRewind(routeThreadKey))) return;',
      '    const sendCtx = composerRef.current?.getSendContext();',
      ''), 'replace'],
    ['                    <ComposerSurface.Shell\n                      contextStrip={showComposerContextStrip || showComposerModelStrip}\n',
      '                    <RubatoStepRewindComposerTag threadKey={routeThreadKey} />\n'],
  ],
};
