import {
  composeShellCommand,
  omitUndefinedArgs,
  piLimit,
  piLsPath,
  piReadArgs,
  piTimeout,
} from "../../api/cursor-agent/pi-args.js";

function textResult(toolCallId, toolName, text, isError) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function resultIsError(result) {
  if (typeof result?.isError === "boolean") return result.isError;
  return result?.details?.isError === true;
}

async function executeTool(options, toolName, toolCallId, rawArgs) {
  const args = omitUndefinedArgs(rawArgs);
  const signal = options.signal;
  if (signal?.aborted) {
    return textResult(toolCallId, toolName, errorText(signal.reason ?? "Operation aborted"), true);
  }

  await options.onStart?.({
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  });

  let result;
  let isError = false;
  try {
    result = await options.executeTool(toolName, args, {
      signal,
      toolCallId,
      activateInactiveTool: true,
      onUpdate: (partialResult) => options.onUpdate?.({
        type: "tool_execution_update",
        toolCallId,
        toolName,
        args,
        partialResult,
      }),
    });
    isError = resultIsError(result);
  } catch (error) {
    isError = true;
    result = {
      content: [{ type: "text", text: errorText(error) }],
      details: { isError: true },
    };
  }

  await options.onEnd?.({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result,
    isError,
  });

  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: result?.content ?? [],
    details: result?.details,
    usage: result?.usage,
    isError,
    timestamp: Date.now(),
  };
}

/**
 * Map Cursor's server-driven exec frames onto the selected session's public
 * executeTool capability. The argument transforms intentionally mirror the
 * display blocks synthesized by cursor-agent.
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
    }),
    ls: (args) => executeTool(options, "ls", args.toolCallId, { path: piLsPath(args.path) }),
    grep: (args) => executeTool(options, "grep", args.toolCallId, {
      pattern: args.pattern,
      path: args.path || undefined,
      glob: args.glob || undefined,
      ignoreCase: args.caseInsensitive === true ? true : undefined,
    }),
    write: (args) => executeTool(options, "write", args.toolCallId, {
      path: args.path,
      content: args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array()),
    }),
    shell: (args) => executeTool(options, "bash", args.toolCallId, {
      command: composeShellCommand(args.command, args.workingDirectory || undefined),
      timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
    }),
    mcp: (call) => executeTool(options, call.toolName || call.name, call.toolCallId, call.args),
    piRead: (call) => {
      const args = piReadArgs(call.args.path, call.args.offset, call.args.limit);
      return args === null
        ? textResult(call.toolCallId, "read", "", false)
        : executeTool(options, "read", call.toolCallId, args);
    },
    piBash: (call) => executeTool(options, "bash", call.toolCallId, {
      command: call.args.command,
      timeout: piTimeout(call.args.timeout),
    }),
    piEdit: (call) => executeTool(options, "edit", call.toolCallId, {
      path: call.args.path,
      edits: call.args.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
    }),
    piWrite: (call) => executeTool(options, "write", call.toolCallId, {
      path: call.args.path,
      content: call.args.content,
    }),
    piGrep: (call) => executeTool(options, "grep", call.toolCallId, {
      pattern: call.args.pattern,
      path: call.args.path || undefined,
      glob: call.args.glob || undefined,
      ignoreCase: call.args.ignoreCase === true ? true : undefined,
      literal: call.args.literal === true ? true : undefined,
      context: call.args.context,
      limit: piLimit(call.args.limit),
    }),
    piFind: (call) => executeTool(options, "find", call.toolCallId, {
      pattern: call.args.pattern,
      path: call.args.path || undefined,
      limit: piLimit(call.args.limit),
    }),
    piLs: (call) => executeTool(options, "ls", call.toolCallId, {
      path: piLsPath(call.args.path),
      limit: piLimit(call.args.limit),
    }),
  };
}
