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
//
// A workspace that is not a git repository got no checkpoint at all, and every rewind
// names its point by checkpoint: the timeline offered no rewind on a message, a step or
// a reply said "This turn has not finished yet.", and a revert would drop the turns it
// could not number. A Rubato turn there now leaves a placeholder checkpoint with no
// files (status "missing", as T3's provider-diff placeholder), so the conversation can
// rewind while files stay as they are. A thread with no checkpoint yet numbers its
// earlier turns first, in the order they started.
export const rewindOverlays = [
  'packages/shared/src/rubatoRevertRetention.ts',
  'packages/shared/src/rubatoRevertRetention.test.ts',
  'apps/web/src/components/rubatoRewindWait.test.ts',
];

const IMPORT_ANCHOR = 'import { compareDateTimeStrings } from "@t3tools/shared/dateTime";\n';
const IMPORT = 'import { retainUserMessagesAfterRevert } from "@t3tools/shared/rubatoRevertRetention";\n';

const CONVERSATION_CHECKPOINTS = `  // Rubato: no git here, so no files to keep, but a rewind names its point by checkpoint.
  // A finished turn gets a placeholder with no files; a thread with none yet numbers its
  // earlier turns first, by when they started, so a rewind keeps them.
  const recordConversationCheckpoints = Effect.fn("recordConversationCheckpoints")(function* (
    thread: {
      readonly id: ThreadId;
      readonly checkpoints: ReadonlyArray<{
        readonly turnId: TurnId;
        readonly checkpointTurnCount: number;
      }>;
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
        readonly createdAt: string;
      }>;
    },
    turnId: TurnId,
    createdAt: string,
  ) {
    if (thread.checkpoints.some((checkpoint) => checkpoint.turnId === turnId)) return;
    const startedAt = new Map<TurnId, string>();
    if (thread.checkpoints.length === 0) {
      // A turn can have tool rows and no reply (an interrupted one), and a revert drops
      // the rows of a turn it cannot number.
      const detail = yield* projectionSnapshotQuery
        .getThreadDetailById(thread.id)
        .pipe(Effect.map(Option.getOrUndefined));
      for (const row of [...thread.messages, ...(detail?.activities ?? [])]) {
        if (row.turnId === null || row.turnId === turnId) continue;
        const known = startedAt.get(row.turnId);
        if (known === undefined || compareDateTimeStrings(row.createdAt, known) < 0)
          startedAt.set(row.turnId, row.createdAt);
      }
    }
    const turns = [...startedAt.entries()]
      .toSorted(([, left], [, right]) => compareDateTimeStrings(left, right))
      .map(([earlier]) => earlier);
    turns.push(turnId);
    let turnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    for (const numbered of turns) {
      turnCount += 1;
      const reply = thread.messages.findLast(
        (message) => message.role === "assistant" && message.turnId === numbered,
      );
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: yield* serverCommandId("conversation-checkpoint"),
        threadId: thread.id,
        turnId: numbered,
        completedAt: createdAt,
        checkpointRef: CheckpointRef.make(\`rubato-conversation:\${numbered}\`),
        status: "missing",
        files: [],
        assistantMessageId: reply?.id ?? MessageId.make(\`assistant:\${numbered}\`),
        checkpointTurnCount: turnCount,
        createdAt,
      });
    }
  });

`;

const CONVERSATION_CHECKPOINTS_TEST = `  it("numbers Rubato turns in a workspace without git so the conversation can rewind", async () => {
    const harness = await createHarness({
      initializeGit: false,
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("rubato-pi"),
    });
    const threadId = ThreadId.make("thread-1");
    // Two turns finished before placeholders existed; the second listed started first.
    for (const [turn, at] of [
      ["turn-b", "2026-01-01T00:00:02.000Z"],
      ["turn-a", "2026-01-01T00:00:01.000Z"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(\`cmd-activity-\${turn}\`),
          threadId,
          activity: {
            id: EventId.make(\`activity-\${turn}\`),
            tone: "tool",
            kind: "tool.completed",
            summary: turn,
            payload: {},
            turnId: asTurnId(turn),
            createdAt: at,
          },
          createdAt: at,
        }),
      );
    }
    const complete = async (turn: string) => {
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make(\`turn.completed-\${turn}\`),
        provider: ProviderDriverKind.make("rubato-pi"),
        createdAt: "2026-01-01T00:00:05.000Z",
        threadId,
        turnId: asTurnId(turn),
        payload: { state: "completed" },
      });
      await harness.drain();
    };
    await complete("turn-c");
    await complete("turn-d");
    const numbered = (await harness.readModel()).threads[0]?.checkpoints;
    expect(
      numbered?.map((checkpoint) => [checkpoint.turnId, checkpoint.checkpointTurnCount]),
    ).toEqual([
      ["turn-a", 1],
      ["turn-b", 2],
      ["turn-c", 3],
      ["turn-d", 4],
    ]);
    expect(numbered?.every((checkpoint) => checkpoint.status === "missing")).toBe(true);
    expect(numbered?.every((checkpoint) => checkpoint.files.length === 0)).toBe(true);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.revert",
        commandId: CommandId.make("cmd-conversation-revert"),
        threadId,
        turnCount: 2,
        createdAt: "2026-01-01T00:00:06.000Z",
      }),
    );
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    await waitForThread(harness.readModel, (entry) => entry.checkpoints.length === 2);
    expect(
      (await harness.readModel()).threads[0]?.checkpoints.map((checkpoint) => checkpoint.turnId),
    ).toEqual(["turn-a", "turn-b"]);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({ threadId, numTurns: 2 });
    expect(NodeFS.existsSync(NodePath.join(harness.cwd, ".git"))).toBe(false);
  });

  it("leaves another provider's turns unnumbered in a workspace without git", async () => {
    const harness = await createHarness({ initializeGit: false, seedFilesystemCheckpoints: false });
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("turn.completed-codex"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:05.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.checkpoints).toEqual([]);
  });

`;

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
  'apps/server/src/orchestration/Layers/CheckpointReactor.ts': [
    ['  type CheckpointRef,\n', '  CheckpointRef,\n', 'replace'],
    ['import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";\n',
      'import { compareDateTimeStrings } from "@t3tools/shared/dateTime";\n'],
    ['  // Capture the files left by a completed or interrupted turn.\n', CONVERSATION_CHECKPOINTS],
    [`        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
`, `        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        if (event.provider === "rubato-pi")
          yield* recordConversationCheckpoints(thread, turnId, event.createdAt);
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
`, 'replace'],
  ],
  'apps/server/src/orchestration/Layers/CheckpointReactor.test.ts': [
    ['  it("executes provider revert and emits thread.reverted for claude sessions", async () => {\n',
      CONVERSATION_CHECKPOINTS_TEST],
  ],
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
