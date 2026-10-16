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
export const rewindOverlays = [
  'apps/server/src/orchestration-v2/RubatoConversationCheckpoint.test.ts',
];

const NON_GIT = '            // Rubato: no repository means no files to keep, not no rewind (rewind-edits.mjs).\n';

export const rewindEdits = {
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
