// ACP streaming performance (Antigravity / local agy):
// 1. Emit node.updated in emitTool only when the tool's node status actually transitions,
//    avoiding redundant node events on every intermediate tool update.
// 2. Route live running command_execution output appends through command_output.delta
//    (CommandOutputHub) like Pi, Codex, and Claude adapters, instead of flooding the
//    orchestration event store and mobile WebSocket with full turn_item.updated snapshots.
export const acpPerfOverlays = [];

export const acpPerfEdits = {
  'packages/provider-acp/src/server/adapter.ts': [
    [
      `          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "tool_call",
              status: nodeStatus(status),
              countsForRun: true,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });`,
      `          const nextNodeStatus = nodeStatus(status);
          const previousNodeStatus = previousStatus === undefined ? undefined : nodeStatus(previousStatus);
          const rawInput = toolCall.data.rawInput;
          const rawOutput = toolCall.data.rawOutput ?? toolCall.data.content;
          const changes = structuredFileChanges(toolCall);
          const rawInputRecord = unknownRecord(rawInput);
          const inputVariant =
            typeof rawInputRecord?.variant === "string"
              ? rawInputRecord.variant.trim().toLowerCase()
              : "";
          const rawOutputRecord = unknownRecord(rawOutput);
          const outputIsBashResult =
            typeof rawOutputRecord?.type === "string" &&
            rawOutputRecord.type.trim().toLowerCase() === "bash" &&
            commandExitCode(rawOutput) !== undefined;
          const projectAsCommandExecution = inputVariant === "monitor" || outputIsBashResult;
          const mcpIdentity = extractMcpToolCallIdentity(toolCall, {
            embeddedTerminalCommands: embeddedTerminalCommands(
              context.nativeThreadId,
              toolCall.toolCallId,
            ),
          });
          const isRunningCommandOutputOnly =
            status === "running" &&
            previous !== undefined &&
            previousStatus === "running" &&
            previous.title === toolCall.title &&
            !toolCall.toolCallId.startsWith("acp-compaction:") &&
            mcpIdentity === undefined &&
            changes.length === 0 &&
            (toolCall.kind === "execute" || projectAsCommandExecution);
          if (isRunningCommandOutputOnly) {
            const prevOutputText = textFromUnknown(previous.data.rawOutput ?? previous.data.content) ?? "";
            const nextOutputText = textFromUnknown(rawOutput) ?? "";
            if (nextOutputText.length > prevOutputText.length && nextOutputText.startsWith(prevOutputText)) {
              yield* emitProviderEvent({
                type: "command_output.delta",
                driver,
                threadId: context.input.threadId,
                itemId: turnItemId,
                chunk: nextOutputText.slice(prevOutputText.length),
              });
              yield* rearmDeferredFinalize(context);
              return;
            }
          }
          if (previousNodeStatus !== nextNodeStatus) {
            yield* emitProviderEvent({
              type: "node.updated",
              driver,
              node: {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "tool_call",
                status: nextNodeStatus,
                countsForRun: true,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt,
                completedAt,
              },
            });
          }`,
      'replace',
    ],
    [
      `          const rawInput = toolCall.data.rawInput;
          const rawOutput = toolCall.data.rawOutput ?? toolCall.data.content;
          const changes = structuredFileChanges(toolCall);
          const path = changes[0]?.path ?? pathFromToolCall(toolCall);
          const diffText =
            acpToolCallDiffPatch(toolCall.data.content) ?? textFromUnknown(rawOutput);
          const rawInputRecord = unknownRecord(rawInput);
          const inputVariant =
            typeof rawInputRecord?.variant === "string"
              ? rawInputRecord.variant.trim().toLowerCase()
              : "";
          const rawOutputRecord = unknownRecord(rawOutput);
          const outputCommand =
            typeof rawOutputRecord?.command === "string" &&
            rawOutputRecord.command.trim().length > 0
              ? rawOutputRecord.command.trim()
              : undefined;
          const monitorCommand =
            (typeof rawInputRecord?.command === "string" && rawInputRecord.command.trim().length > 0
              ? rawInputRecord.command.trim()
              : undefined) ?? outputCommand;
          const outputIsBashResult =
            typeof rawOutputRecord?.type === "string" &&
            rawOutputRecord.type.trim().toLowerCase() === "bash" &&
            commandExitCode(rawOutput) !== undefined;
          const projectAsCommandExecution = inputVariant === "monitor" || outputIsBashResult;
          const mcpIdentity = extractMcpToolCallIdentity(toolCall, {
            embeddedTerminalCommands: embeddedTerminalCommands(
              context.nativeThreadId,
              toolCall.toolCallId,
            ),
          });`,
      `          const path = changes[0]?.path ?? pathFromToolCall(toolCall);
          const diffText =
            acpToolCallDiffPatch(toolCall.data.content) ?? textFromUnknown(rawOutput);
          const outputCommand =
            typeof rawOutputRecord?.command === "string" &&
            rawOutputRecord.command.trim().length > 0
              ? rawOutputRecord.command.trim()
              : undefined;
          const monitorCommand =
            (typeof rawInputRecord?.command === "string" && rawInputRecord.command.trim().length > 0
              ? rawInputRecord.command.trim()
              : undefined) ?? outputCommand;`,
      'replace',
    ],
  ],
};
