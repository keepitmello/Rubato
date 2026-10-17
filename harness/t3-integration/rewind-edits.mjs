// Rewinding a conversation in a project that is not a git repository.
//
// V2 checkpoints a turn's files through git. Without a repository it records the
// checkpoint as "missing", and every rewind path accepts only "ready" ones: the
// timeline offers no "Edit from here" and the server refuses the rollback. On V1 the
// conversation rewound there anyway with the files left as they are (a placeholder
// checkpoint with no files), and Rubato sessions often run in plain folders. So a
// non-git workspace's checkpoints are recorded "ready" with no files, restoring one
// leaves the files alone, and there are no git refs to clean up. The rollback itself
// is the engine's in-place rewind (src/rpc-connection.mjs).
//
// What V1's rewind patch also did is gone on V2 by construction: it paired each user
// message with the turn of the reply after it, because V1 stored user messages without
// a turn. V2 stores every message with its run (a steer joins the running run, a wake
// run has no user message), and a rollback drops whole runs.
//
// Editing a sent message rewinds to the latest turn before it that kept a checkpoint; the
// server picks it (RubatoMessageRewind.ts, turn-actions-edits.mjs). Here the timeline only
// decides which messages offer the edit: T3 offered none on a failed run's message, since a
// failed run captures no checkpoint.
export const rewindOverlays = [
  'apps/server/src/orchestration-v2/RubatoConversationCheckpoint.test.ts',
  'apps/web/src/RubatoEditableMessages.test.ts',
];

const NON_GIT = '            // Rubato: no repository means no files to keep, not no rewind (rewind-edits.mjs).\n';

const T3_REVERT_TARGETS = `export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
}): Map<ChatMessage["id"], number> {
  const readyCheckpointByRunId = new Map<RunId, ThreadCheckpointSummary>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyCheckpointByRunId.set(checkpoint.runId, checkpoint);
    }
  }
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    if (entry.message.inputIntent !== "turn_start" && entry.message.inputIntent !== "queued_turn") {
      continue;
    }
    if (entry.message.runId === null) continue;
    const checkpoint = readyCheckpointByRunId.get(entry.message.runId);
    if (checkpoint === undefined) continue;
    byUserMessageId.set(entry.message.id, Math.max(0, checkpoint.checkpointTurnCount - 1));
  }
  return byUserMessageId;
}
`;

const RUBATO_REVERT_TARGETS = `// Rubato: a failed run's message offers the edit too (rewind-edits.mjs). The number is
// only the timeline's guess; the edit asks the server where it lands (RubatoMessageRewind.ts).
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
  /** Runs that failed; a failed run captures no checkpoint. */
  readonly failedRunIds?: ReadonlySet<RunId>;
}): Map<ChatMessage["id"], number> {
  const readyCheckpointByRunId = new Map<RunId, ThreadCheckpointSummary>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyCheckpointByRunId.set(checkpoint.runId, checkpoint);
    }
  }
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  let latestReadyShown: number | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message") continue;
    const runId = entry.message.runId;
    const checkpoint = runId === null ? undefined : readyCheckpointByRunId.get(runId);
    if (
      runId !== null &&
      entry.message.role === "user" &&
      (entry.message.inputIntent === "turn_start" || entry.message.inputIntent === "queued_turn")
    ) {
      if (checkpoint !== undefined) {
        byUserMessageId.set(entry.message.id, Math.max(0, checkpoint.checkpointTurnCount - 1));
      } else if (input.failedRunIds?.has(runId) && latestReadyShown !== null) {
        byUserMessageId.set(entry.message.id, latestReadyShown);
      }
    }
    if (checkpoint !== undefined) {
      latestReadyShown = Math.max(latestReadyShown ?? 0, checkpoint.checkpointTurnCount);
    }
  }
  return byUserMessageId;
}
`;

export const rewindEdits = {
  'apps/web/src/session-logic.ts': [
    [T3_REVERT_TARGETS, RUBATO_REVERT_TARGETS, 'replace'],
  ],
  'apps/web/src/components/chat/MessagesTimeline.logic.ts': [
    [
      '        checkpoints: input.turnDiffSummaries,\n      })\n    : new Map<MessageId, number>();\n',
      '        checkpoints: input.turnDiffSummaries,\n'
        + '        // Rubato: a failed run\'s message can rewind too (rewind-edits.mjs).\n'
        + '        failedRunIds: failedTimelineRunIds(timelineEntries, input.latestRun ?? null),\n'
        + '      })\n    : new Map<MessageId, number>();\n',
      'replace',
    ],
  ],
  'apps/server/src/orchestration-v2/CheckpointService.ts': [
    [
      '              status: available ? "ready" : "missing",\n',
      NON_GIT.replace('            //', '              //') + '              status: available || !checkpointable ? "ready" : "missing",\n',
      'replace',
    ],
    [
      '              status: "missing",\n',
      NON_GIT.replace('            //', '              //') + '              status: "ready",\n',
      'replace',
    ],
    [
      '          if (input.checkpoint.status !== "ready") {\n            return yield* new CheckpointRestoreError({\n',
      '          // Rubato: a non-git checkpoint holds no files; restoring it leaves them as they are.\n'
        + '          if (input.checkpoint.status === "ready" && !(yield* isGitCheckpointable(input.scope.cwd))) return;\n',
    ],
    [
      '    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>\n      withWorkspaceLock(\n        input.scope.cwd,\n        checkpointStore.deleteCheckpointRefs({\n          cwd: input.scope.cwd,\n          checkpointRefs: input.checkpoints.map((checkpoint) => checkpoint.ref),\n        }),\n      ).pipe(\n',
      '    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>\n      withWorkspaceLock(\n        input.scope.cwd,\n'
        + '        // Rubato: a non-git workspace has no checkpoint refs to delete.\n'
        + '        Effect.flatMap(isGitCheckpointable(input.scope.cwd), (git) => !git ? Effect.void : checkpointStore.deleteCheckpointRefs({\n'
        + '          cwd: input.scope.cwd,\n          checkpointRefs: input.checkpoints.map((checkpoint) => checkpoint.ref),\n        })),\n      ).pipe(\n',
      'replace',
    ],
  ],
};
