import { randomUUID } from "node:crypto";

function errorResult(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    details: { isError: true },
  };
}

function resolveActiveTool(session, name) {
  return session.agent.state.tools.find((candidate) => candidate.name === name);
}

/**
 * Execute one registered tool through the same validation and middleware hooks
 * used by stock Pi's agent loop. AgentSession owns lookup and activation state.
 * A provider may supply a trusted in-memory native file executor; model-visible
 * tool removal is not authorization to skip the session's middleware.
 */
export async function executeRegisteredTool(
  session,
  toolName,
  rawParams,
  options = {},
  { validateToolArguments, ExecuteToolError },
) {
  if (
    options.toolCallId !== undefined &&
    (typeof options.toolCallId !== "string" || options.toolCallId.trim() === "")
  ) {
    throw new TypeError("executeTool toolCallId must be a non-empty string when provided");
  }
  let activeToolNames = session.getActiveToolNames();
  let tool = resolveActiveTool(session, toolName);

  // This capability contains an executable function and is passed only by the
  // native provider bridge, never deserialized from model/RPC arguments. Keep
  // the original tool name so permission/loop/result hooks see write or edit.
  if (options.nativeFileTool !== undefined) {
    const native = options.nativeFileTool;
    if ((toolName !== "write" && toolName !== "edit") || native?.name !== toolName ||
        typeof native.execute !== "function" || !native.parameters) {
      throw new TypeError("Invalid native file executor");
    }
    tool = native;
  }

  if (!tool && options.activateInactiveTool === true && session._toolDefinitions.has(toolName)) {
    const definition = session._toolDefinitions.get(toolName)?.definition;
    const canActivate = definition?.allowLazyActivation !== false;
    const activated = canActivate && session._lazyToolActivators.some((activate) => activate(toolName));
    if (activated) {
      activeToolNames = session.getActiveToolNames();
      tool = resolveActiveTool(session, toolName);
    }
  }

  if (!tool) {
    const code = session._toolDefinitions.has(toolName) ? "inactive_tool" : "unknown_tool";
    const activeList = activeToolNames.length > 0 ? activeToolNames.join(", ") : "(none)";
    throw new ExecuteToolError(
      code,
      toolName,
      code === "inactive_tool"
        ? `Tool ${toolName} is registered but inactive. Active tools: ${activeList}`
        : `Unknown tool ${toolName}. Active tools: ${activeList}`,
      activeToolNames,
    );
  }

  const toolCall = {
    type: "toolCall",
    id: options.toolCallId ?? `rubato-${randomUUID()}`,
    name: toolName,
    arguments: rawParams,
  };
  let args;
  try {
    const preparedArguments = tool.prepareArguments
      ? tool.prepareArguments(toolCall.arguments)
      : toolCall.arguments;
    args = validateToolArguments(tool, { ...toolCall, arguments: preparedArguments });
  } catch (error) {
    throw new ExecuteToolError(
      "invalid_params",
      toolName,
      error instanceof Error ? error.message : String(error),
      activeToolNames,
    );
  }

  const beforeResult = await session.agent.beforeToolCall?.({ toolCall, args }, options.signal);
  if (beforeResult?.block) {
    throw new ExecuteToolError(
      "blocked",
      toolName,
      beforeResult.reason || "Tool execution was blocked",
      activeToolNames,
    );
  }

  let result;
  let isError = false;
  try {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Operation aborted", "AbortError");
    result = await tool.execute(toolCall.id, args, options.signal, options.onUpdate);
  } catch (error) {
    result = errorResult(error);
    isError = true;
  }

  let afterResult;
  try {
    afterResult = await session.agent.afterToolCall?.(
      { toolCall, args, result, isError },
      options.signal,
    );
  } catch (error) {
    return { ...errorResult(error), isError: true };
  }
  if (afterResult) {
    result = {
      ...result,
      content: afterResult.content ?? result.content,
      details: afterResult.details ?? result.details,
      usage: afterResult.usage ?? result.usage,
      addedToolNames: afterResult.addedToolNames ?? result.addedToolNames,
      terminate: afterResult.terminate ?? result.terminate,
    };
    isError = afterResult.isError ?? isError;
  }
  return { ...result, isError };
}
