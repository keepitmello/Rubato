// Which user messages survive a rewind. T3 stores user messages without a turn and,
// on thread.reverted, kept as many of them as turns survive. A Rubato turn is not
// always one user message: a finished child wakes the lead without one, and a steered
// message joins a running turn. So the screen dropped a kept steer and kept the prompt
// being rewound, and the client waited on that prompt until its two-minute timeout.
//
// The three places that apply a revert (the server's in-memory projector, its SQL
// projection and the client reducer) now pair each user message with the turn of the
// reply after it (packages/shared/src/rubatoRevertRetention.ts) and count only the
// rest. The bridge cuts Pi's history by the same pairing (rewindPlan in src/bridge.mjs).
export const rewindOverlays = [
  'packages/shared/src/rubatoRevertRetention.ts',
  'packages/shared/src/rubatoRevertRetention.test.ts',
  'apps/web/src/components/rubatoRewindWait.test.ts',
];

const IMPORT_ANCHOR = 'import { compareDateTimeStrings } from "@t3tools/shared/dateTime";\n';
const IMPORT = 'import { retainUserMessagesAfterRevert } from "@t3tools/shared/rubatoRevertRetention";\n';

const countingFor = (id) => [
  `  const retainedUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      !isImportedAgentSessionMessageId(message.${id}) &&
      retainedMessageIds.has(message.${id}),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.${id}) &&`,
  `  const pairedUsers = retainUserMessagesAfterRevert(
    ${id === 'id' ? 'messages' : 'messages.map((message) => ({ ...message, id: message.messageId }))'},
    retainedTurnIds,
  );
  for (const messageId of pairedUsers.retained) retainedMessageIds.add(messageId);
  const retainedUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      !isImportedAgentSessionMessageId(message.${id}) &&
      retainedMessageIds.has(message.${id}),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount - pairedUsers.promptlessTurns);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !pairedUsers.decided.has(message.${id}) &&
          !retainedMessageIds.has(message.${id}) &&`,
  'replace',
];

export const rewindEdits = {
  // The wait for a rewind to show asked that no checkpoint lie past the rewound point.
  // A child's completion can open a new turn on the rewound branch before the request's
  // own acknowledgement lands, and then that never held: the rewind showed and the
  // composer still failed two minutes later. What proves the revert is that the turns
  // it removes are gone.
  'apps/web/src/components/ChatView.logic.ts': [
    [`  const previousFailures = new Set(
    initial.activities
      .filter((activity) => activity.kind === "checkpoint.revert.failed")`,
    `  const removedTurnIds = new Set(
    initial.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > turnCount)
      .map((checkpoint) => checkpoint.turnId),
  );
`],
    [`        accepted &&
        !thread.messages.some((message) => message.id === messageId) &&
        thread.checkpoints.every((checkpoint) => checkpoint.checkpointTurnCount <= turnCount) &&
        (turnCount === 0
          ? thread.latestTurn === null
          : thread.checkpoints.some(
              (checkpoint) => checkpoint.turnId === thread.latestTurn?.turnId,
            ))`,
    `        accepted &&
        !thread.messages.some((message) => message.id === messageId) &&
        !thread.checkpoints.some((checkpoint) => removedTurnIds.has(checkpoint.turnId))`,
    'replace'],
  ],
  'packages/shared/package.json': [
    [`    "./dateTime": {
      "types": "./src/dateTime.ts",
      "import": "./src/dateTime.ts"
    },
`, `    "./rubatoRevertRetention": {
      "types": "./src/rubatoRevertRetention.ts",
      "import": "./src/rubatoRevertRetention.ts"
    },
`],
  ],
  'apps/server/src/orchestration/projector.ts': [
    [IMPORT_ANCHOR, IMPORT],
    countingFor('id'),
  ],
  'apps/server/src/orchestration/Layers/ProjectionPipeline.ts': [
    [IMPORT_ANCHOR, IMPORT],
    countingFor('messageId'),
  ],
  'packages/client-runtime/src/state/threadReducer.ts': [
    [IMPORT_ANCHOR, IMPORT],
    [`  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) =>
        message.role === role &&
        !isImportedAgentSessionMessageId(message.id) &&
        retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    const fallbackMessages = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&`,
    `  const pairedUsers = retainUserMessagesAfterRevert(messages, retainedTurnIds);
  for (const messageId of pairedUsers.retained) retainedMessageIds.add(messageId);
  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) =>
        message.role === role &&
        !isImportedAgentSessionMessageId(message.id) &&
        retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(
      0,
      turnCount - retainedCount - (role === "user" ? pairedUsers.promptlessTurns : 0),
    );
    const fallbackMessages = messages
      .filter(
        (message) =>
          message.role === role &&
          !(role === "user" && pairedUsers.decided.has(message.id)) &&
          !retainedMessageIds.has(message.id) &&`,
    'replace'],
  ],
};
