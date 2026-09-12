import {
  composeShellCommand,
  omitUndefinedArgs,
  piLimit,
  piLsPath,
  piReadArgs,
  piTimeout,
} from "../../api/cursor-agent/pi-args.js";
import { createCursorExecJournal, cursorExecJournalPath } from "./cursor-exec-journal.mjs";
import { createNativeFileTool } from "./cursor-host-mutation.mjs";

const inFlight = new Map();
const journals = new Map();
const IN_FLIGHT_MAX = 1024;

function inFlightKey(lineageId, execId) {
  return lineageId + "\u0000" + execId;
}

function rememberInFlight(key, promise) {
  inFlight.set(key, promise);
  if (inFlight.size <= IN_FLIGHT_MAX) return;
  for (const oldest of inFlight.keys()) {
    if (inFlight.size <= IN_FLIGHT_MAX) break;
    if (oldest === key) continue;
    inFlight.delete(oldest);
  }
}

export function resetCursorExecBridgeState() {
  inFlight.clear();
  journals.clear();
}

function resolveJournal(options) {
  if (options.journal) return options.journal;
  const agentDir = options.agentDir;
  if (typeof agentDir !== "string" || agentDir.trim() === "") {
    throw new Error("Cursor exec bridge has no agentDir to journal under");
  }
  const path = cursorExecJournalPath(agentDir);
  if (!journals.has(path)) journals.set(path, createCursorExecJournal({ agentDir, journalPath: path }));
  return journals.get(path);
}

function resolveLineageId(options) {
  const lineageId = typeof options.getLineageId === "function" ? options.getLineageId() : options.lineageId;
  return typeof lineageId === "string" && lineageId !== "" ? lineageId : undefined;
}

function resolveExecId(call) {
  const execId = call?.cursorExecId ?? call?.execId;
  return typeof execId === "string" && execId !== "" ? execId : undefined;
}

function textResult(toolCallId, toolName, text, isError, extra = {}) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
    ...extra,
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function resultIsError(result) {
  if (typeof result?.isError === "boolean") return result.isError;
  return result?.details?.isError === true;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayedResult(toolCallId, toolName, entry) {
  const stored = entry?.result;
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: isRecord(stored) && Array.isArray(stored.content) ? stored.content : [],
    details: isRecord(stored) ? stored.details : undefined,
    usage: isRecord(stored) ? stored.usage : undefined,
    addedToolNames: isRecord(stored) ? stored.addedToolNames : undefined,
    isError: entry?.isError === true,
    timestamp: Date.now(),
  };
}

function refusalMessage(toolName, entry, reason) {
  const sideEffect = entry?.sideEffect;
  const detail = sideEffect === "happened"
    ? "It already ran, so it will not run again."
    : sideEffect === "none"
      ? "It did not run."
      : "Whether it already ran cannot be determined, so it will not be run again.";
  return "Tool \"" + toolName + "\" was not executed: " + (reason ?? "a previous attempt did not settle") + ". " + detail;
}

async function executeTool(options, toolName, toolCallId, rawArgs, call) {
  const execId = resolveExecId(call);
  const lineageId = resolveLineageId(options);
  if (!lineageId) {
    return textResult(toolCallId, toolName, "Tool \"" + toolName + "\" was not executed: the Cursor exec bridge has no conversation lineage id to journal it under.", true);
  }
  if (!execId) {
    return textResult(toolCallId, toolName, "Tool \"" + toolName + "\" was not executed: the Cursor exec frame has no exec identity.", true);
  }
  const key = inFlightKey(lineageId, execId);
  const existing = inFlight.get(key);
  if (existing !== undefined) return await existing;
  const run = runJournaledTool(options, toolName, toolCallId, rawArgs, lineageId, execId);
  rememberInFlight(key, run);
  try {
    return await run;
  } finally {
    // Keep the settled promise so a later sequential redelivery in this process joins it.
  }
}

async function runJournaledTool(options, toolName, toolCallId, rawArgs, lineageId, execId) {
  const signal = options.signal;
  if (signal?.aborted) {
    return textResult(toolCallId, toolName, errorText(signal.reason ?? "Operation aborted"), true);
  }
  let journal;
  try {
    journal = resolveJournal(options);
  } catch (error) {
    return textResult(toolCallId, toolName, "Tool \"" + toolName + "\" was not executed: the exec journal could not be opened (" + errorText(error) + ").", true);
  }
  let decision;
  try {
    decision = journal.prepare({ lineageId, execId, toolCallId, toolName });
  } catch (error) {
    return textResult(toolCallId, toolName, "Tool \"" + toolName + "\" was not executed: the exec journal could not be updated (" + errorText(error) + ").", true);
  }
  if (decision.decision === "refuse") {
    return textResult(toolCallId, toolName, refusalMessage(toolName, decision.entry, decision.reason), true);
  }
  if (decision.decision === "replay") {
    const replayed = replayedResult(toolCallId, toolName, decision.entry);
    await options.onStart?.({ type: "tool_execution_start", toolCallId, toolName, args: omitUndefinedArgs(rawArgs) });
    await options.onEnd?.({ type: "tool_execution_end", toolCallId, toolName, result: { content: replayed.content, details: replayed.details }, isError: replayed.isError });
    return replayed;
  }

  const args = omitUndefinedArgs(rawArgs);
  await options.onStart?.({ type: "tool_execution_start", toolCallId, toolName, args });

  let result;
  let isError = false;
  let executed = false;
  try {
    journal.markExecuting(lineageId, execId);
    executed = true;
    result = await runSideEffect(options, toolName, toolCallId, args);
    isError = resultIsError(result);
  } catch (error) {
    isError = true;
    result = {
      content: [{ type: "text", text: errorText(error) }],
      details: { isError: true },
    };
  }

  const toolResult = {
    role: "toolResult",
    toolCallId,
    toolName,
    content: result?.content ?? [],
    details: result?.details,
    usage: result?.usage,
    addedToolNames: result?.addedToolNames,
    isError,
    timestamp: Date.now(),
  };
  journal.complete(lineageId, execId, {
    isError,
    result: {
      content: toolResult.content,
      details: toolResult.details,
      usage: toolResult.usage,
      addedToolNames: toolResult.addedToolNames,
    },
    summary: executed ? undefined : "not executed",
  });
  await options.onEnd?.({ type: "tool_execution_end", toolCallId, toolName, result, isError });
  journal.markResultDelivered(lineageId, execId);
  return toolResult;
}

async function runSideEffect(options, toolName, toolCallId, args) {
  if (typeof options.executeTool !== "function") {
    throw new TypeError("Cursor exec bridge requires executeTool");
  }
  const nativeFileTool = toolName === "write" || toolName === "edit"
    ? createNativeFileTool(toolName, options.cwd)
    : undefined;
  const result = await options.executeTool(toolName, args, {
    signal: options.signal,
    toolCallId,
    activateInactiveTool: true,
    ...(nativeFileTool ? { nativeFileTool } : {}),
    onUpdate: (partialResult) => options.onUpdate?.({
      type: "tool_execution_update",
      toolCallId,
      toolName,
      args,
      partialResult,
    }),
  });
  return result;
}

/**
 * Map every Cursor exec frame onto the session executor. Native write/edit
 * retain their own persistence implementation without bypassing validation,
 * cancellation, permission/loop hooks, or result middleware.
 */
export function createCursorExecBridge(options) {
  if (typeof options?.executeTool !== "function") {
    throw new TypeError("Cursor exec bridge requires executeTool");
  }
  return {
    read: (args) => executeTool(options, "read", args.toolCallId, {
      path: args.path,
      offset: args.offset,
      limit: args.limit,
    }, args),
    ls: (args) => executeTool(options, "ls", args.toolCallId, { path: piLsPath(args.path) }, args),
    grep: (args) => executeTool(options, "grep", args.toolCallId, {
      pattern: args.pattern,
      path: args.path || undefined,
      glob: args.glob || undefined,
      ignoreCase: args.caseInsensitive === true ? true : undefined,
    }, args),
    write: (args) => executeTool(options, "write", args.toolCallId, {
      path: args.path,
      content: args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array()),
      bytes: args.fileBytes,
    }, args),
    shell: (args) => executeTool(options, "bash", args.toolCallId, {
      command: composeShellCommand(args.command, args.workingDirectory || undefined),
      timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
    }, args),
    mcp: (call) => executeTool(options, call.toolName || call.name, call.toolCallId, call.args, call),
    piRead: (call) => {
      const args = piReadArgs(call.args.path, call.args.offset, call.args.limit);
      return args === null
        ? textResult(call.toolCallId, "read", "", false)
        : executeTool(options, "read", call.toolCallId, args, call);
    },
    piBash: (call) => executeTool(options, "bash", call.toolCallId, {
      command: call.args.command,
      timeout: piTimeout(call.args.timeout),
    }, call),
    piEdit: (call) => executeTool(options, "edit", call.toolCallId, {
      path: call.args.path,
      edits: call.args.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
    }, call),
    piWrite: (call) => executeTool(options, "write", call.toolCallId, {
      path: call.args.path,
      content: call.args.content,
    }, call),
    piGrep: (call) => executeTool(options, "grep", call.toolCallId, {
      pattern: call.args.pattern,
      path: call.args.path || undefined,
      glob: call.args.glob || undefined,
      ignoreCase: call.args.ignoreCase === true ? true : undefined,
      literal: call.args.literal === true ? true : undefined,
      context: call.args.context,
      limit: piLimit(call.args.limit),
    }, call),
    piFind: (call) => executeTool(options, "find", call.toolCallId, {
      pattern: call.args.pattern,
      path: call.args.path || undefined,
      limit: piLimit(call.args.limit),
    }, call),
    piLs: (call) => executeTool(options, "ls", call.toolCallId, {
      path: piLsPath(call.args.path),
      limit: piLimit(call.args.limit),
    }, call),
  };
}
