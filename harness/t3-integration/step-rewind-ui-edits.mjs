// Rewinding to a finished tool step, not only to a message of mine: the web half
// (chat/RubatoStepRewind.tsx). The server half is step-rewind-edits.mjs.
//
// Every finished Rubato or agy tool row in the timeline offers "rewind to here"; hovering fades
// what goes, and the inline card rewinds and then either takes an instruction from the
// composer or continues on its own (POST /rubato/step-rewind, then /rubato/step-rewind/
// continue). Folded rows rewind too, with nothing expanded: "Worked for" and a tool
// group's row land after the last step under them, and a reply's action row lands right
// after the reply (T3's ordinary revert). A run a step rewind cut is not offered T3's
// Resume, which would send a prompt; the card's continue resumes it instead.
//
// T3 v0.1.11 splits the code these hook into: a work entry is chat/TimelineWorkEntryRow.tsx,
// a tool group chat/TimelineWorkGroupRows.tsx, a reply's meta chat/TimelineAssistantRows.tsx,
// and the revert command a rewind borrows lives in chat/useTimelineRewind.ts while the send
// moved to chat/useComposerSend.ts.
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
    ['      toolIcon?: WorkLogEntry["toolIcon"];\n      hasFailure: boolean;\n',
      '      toolIcon?: WorkLogEntry["toolIcon"];\n      /** Rubato: the items under this group, for its step rewind. */\n      stepItemIds?: ReadonlyArray<string | undefined>;\n      hasFailure: boolean;\n',
      'replace'],
    ['            hiddenCount: visibleGroupedEntries.length,\n            expanded,\n',
      '            hiddenCount: visibleGroupedEntries.length,\n            stepItemIds: visibleGroupedEntries.map((entry) => entry.projectedItem?.item.id),\n            expanded,\n',
      'replace'],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['import { WorkLogBlock } from "./WorkLog";\n', lines(
      'import {',
      '  RUBATO_STEP_DROPPED_CLASS,',
      '  RubatoStepRewindButton,',
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
      '        <TimelineRowTimestamp',
      '          createdAt={row.createdAt}',
      '          timestampFormat={ctx.timestampFormat}',
      '          className="ms-auto"',
      '        />',
      '      </div>',
      ''), lines(
      '        <TimelineRowTimestamp',
      '          createdAt={row.createdAt}',
      '          timestampFormat={ctx.timestampFormat}',
      '          className="ms-auto"',
      '        />',
      '        <RubatoStepRewindButton',
      '          threadKey={ctx.routeThreadKey}',
      '          threadRef={ctx.threadRef}',
      '          target={{ kind: "last-step", runId: row.runId }}',
      '          label="this work"',
      '          busy={rubatoFoldActivity.isWorking || rubatoFoldActivity.isRevertingCheckpoint}',
      '        />',
      '      </div>',
      ''), 'replace'],
  ],
  // A tool row: its rewind button, its fade, and the marker of a rewind waiting after it.
  'apps/web/src/components/chat/TimelineWorkEntryRow.tsx': [
    ['import { WorkLogDetails, WorkLogRow } from "./WorkLog";\n', lines(
      'import {',
      '  RUBATO_STEP_DROPPED_CLASS,',
      '  RubatoStepRewindButton,',
      '  RubatoStepRewindMarker,',
      '  useRubatoStepRewindDropped,',
      '} from "./RubatoStepRewind";',
      '')],
    ['  const { threadRef, onImageExpand, timestampFormat } = ctx;\n  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;\n', lines(
      '  const { threadRef, onImageExpand, timestampFormat } = ctx;',
      '  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;',
      '  const rubatoItem = workEntry.projectedItem?.item;',
      '  const rubatoActivity = use(TimelineRowActivityCtx);',
      '  const rubatoDropped = useRubatoStepRewindDropped(ctx.routeThreadKey, { itemId: rubatoItem?.id });',
      ''), 'replace'],
    [lines(
      '  return (',
      '    <WorkLogRow',
      '      data-work-entry-id={workEntry.id}',
      '      data-v2-item-type={workEntry.projectedItem?.item.type}',
      ''), lines(
      '  return (',
      '    <div className={rubatoDropped ? RUBATO_STEP_DROPPED_CLASS : undefined}>',
      '    <WorkLogRow',
      '      data-work-entry-id={workEntry.id}',
      '      data-v2-item-type={workEntry.projectedItem?.item.type}',
      ''), 'replace'],
    ['          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />\n', lines(
      '          <RubatoStepRewindButton',
      '            threadKey={ctx.routeThreadKey}',
      '            threadRef={threadRef}',
      '            target={{ kind: "step", itemId: rubatoItem?.id, runId: rubatoItem?.runId }}',
      '            item={rubatoItem}',
      '            label={previewText}',
      '            busy={rubatoActivity.isWorking || rubatoActivity.isRevertingCheckpoint}',
      '          />',
      '')],
    ['        </WorkLogDetails>\n      ) : null}\n    </WorkLogRow>\n  );\n}\n\nfunction QuestionAnswerHistory(',
      '        </WorkLogDetails>\n      ) : null}\n    </WorkLogRow>\n    <RubatoStepRewindMarker threadKey={ctx.routeThreadKey} anchorId={rubatoItem?.id} />\n    </div>\n  );\n}\n\nfunction QuestionAnswerHistory(',
      'replace'],
  ],
  // A tool group's row: after its last step. The header is a button, so the rewind
  // button sits beside it.
  'apps/web/src/components/chat/TimelineWorkGroupRows.tsx': [
    ['import { WorkLogButton, WorkLogList, WorkLogRow } from "./WorkLog";\n',
      'import { RubatoStepRewindButton } from "./RubatoStepRewind";\n'],
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
  ],
  // A reply's action row: right after that reply, and the marker of a rewind waiting there.
  'apps/web/src/components/chat/TimelineAssistantRows.tsx': [
    ['import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";\n',
      'import { RubatoStepRewindButton, RubatoStepRewindMarker } from "./RubatoStepRewind";\n'],
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
      'import { isStepCutRun, RubatoStepRewindComposerTag } from "./chat/RubatoStepRewind";',
      '')],
    // A run a step rewind cut continues from the card, not with T3's Resume prompt.
    [lines(
      '  const resumableRunId =',
      '    !isServerThread || serverProjection === null',
      '      ? null',
      '      : deriveResumableRunId(serverProjection, serverRuntime);',
      ''), lines(
      '  const resumableRunId = (() => {',
      '    if (!isServerThread || serverProjection === null) return null;',
      '    const runId = deriveResumableRunId(serverProjection, serverRuntime);',
      '    // Rubato: a step rewind cut this run; its card continues it (RubatoStepRewind.tsx).',
      '    return runId !== null && isStepCutRun(serverProjection.runs, runId) ? null : runId;',
      '  })();',
      ''), 'replace'],
    ['                      <ComposerSurface.Shell contextRow={showComposerContextStrip}>\n',
      '                      <RubatoStepRewindComposerTag threadKey={routeThreadKey} />\n'],
  ],
  // A rewind to a tool step borrows the revert command this hook holds.
  'apps/web/src/components/chat/useTimelineRewind.ts': [
    ['  AuthOrchestrationOperateScope,\n  type EnvironmentId,\n',
      '  AuthOrchestrationOperateScope,\n  CommandId,\n  type EnvironmentId,\n', 'replace'],
    ['import { newThreadId } from "~/lib/utils";\n',
      'import { newThreadId, randomUUID } from "~/lib/utils";\n', 'replace'],
    ['import { openRevertConfirm } from "./ChatOverlayHosts";\n',
      'import { openRevertConfirm } from "./ChatOverlayHosts";\nimport { useRubatoStepRewindHost } from "./RubatoStepRewind";\n', 'replace'],
    [lines(
      '  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {',
      '    reportFailure: false,',
      '  });',
      ''), lines(
      '  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {',
      '    reportFailure: false,',
      '  });',
      '',
      '  // Rubato: a rewind to a tool step borrows the revert command and the composer.',
      '  useRubatoStepRewindHost(routeThreadKey, {',
      '    threadRef: routeThreadRef,',
      '    canRestoreFiles: activeThread?.worktreePath != null,',
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
  ],
  // A rewind to a tool step waiting for this message lands before it is sent.
  'apps/web/src/components/chat/useComposerSend.ts': [
    ['import { msg } from "gt-react";\n',
      'import { msg } from "gt-react";\nimport { landRubatoStepRewind } from "./RubatoStepRewind";\n', 'replace'],
    [lines(
      '      return;',
      '    }',
      '    // Where side chats are unavailable, `/side` text can still be a literal answer.',
      ''), lines(
      '      return;',
      '    }',
      '    // Rubato: a rewind to a tool step waiting for this message lands first.',
      '    if (!(await landRubatoStepRewind(routeThreadKey))) return;',
      '    // Where side chats are unavailable, `/side` text can still be a literal answer.',
      ''), 'replace'],
  ],
};
