import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-agent-core";
import { PI_VERSION as PACKAGE_VERSION } from "../../pi-version.mjs";
const CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[provider-execution:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[provider-execution:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchAgentLoop(source) {
  let next = replaceOnce(
    source,
    `import { getDefaultStreamFn } from "./stream-fn.js";`,
    `import { isCursorExecResolved } from "../../pi-ai/dist/utils/block-symbols.js";
import { getDefaultStreamFn } from "./stream-fn.js";`,
    "resolved-import",
  );
  next = replaceOnce(
    next,
    `            const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
            newMessages.push(message);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                lastCompletedTurn = {
                    message,
                    toolResults: [],
                    context: currentContext,
                    newMessages,
                };
                await config.finishTurn?.(lastCompletedTurn, signal);
                await emit({ type: "turn_end", message, toolResults: [] });
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
            // Check for tool calls
            const toolCalls = message.content.filter((c) => c.type === "toolCall");
            const toolResults = [];
            hasMoreToolCalls = false;`,
    `            const streamed = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
            const message = streamed.message;
            const providerToolResults = streamed.providerToolResults;
            newMessages.push(message);
            const toolResults = [];
            for (const result of providerToolResults) {
                await emit({ type: "message_start", message: result });
                await emit({ type: "message_end", message: result });
                currentContext.messages.push(result);
                newMessages.push(result);
                toolResults.push(result);
            }
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                lastCompletedTurn = {
                    message,
                    toolResults,
                    context: currentContext,
                    newMessages,
                };
                await config.finishTurn?.(lastCompletedTurn, signal);
                await emit({ type: "turn_end", message, toolResults });
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
            // Cursor exec-resolved calls have already run and are paired above.
            const toolCalls = message.content.filter((c) => c.type === "toolCall" && !isCursorExecResolved(c));
            hasMoreToolCalls = false;`,
    "collect-provider-results",
  );
  next = replaceOnce(
    next,
    `                for (const result of toolResults) {
                    currentContext.messages.push(result);
                    newMessages.push(result);
                }`,
    `                for (const result of executedToolBatch.messages) {
                    currentContext.messages.push(result);
                    newMessages.push(result);
                }`,
    "append-only-loop-results",
  );
  next = replaceOnce(
    next,
    `    const response = await streamFunction(config.model, llmContext, {
        ...config,
        apiKey: resolvedApiKey,
        signal,
    });`,
    `    // 1.0.1 inserts a result() wrapper (requested thinking level) after this call; the anchor
    // stops at the call so that wrapper stays as stock wrote it.
    // Provider-executed tools (Cursor exec channel) normally settle before
    // the assistant turn completes. Abort releases the transport drain early,
    // so retain request-local ownership until a signal-aware tool publishes its
    // terminal pair. A hung tool is bounded and receives one synthetic pair.
    const providerToolResults = [];
    const providerToolStates = new Map();
    const bufferedProviderToolCallIds = new Set();
    const beginProviderTool = async (event) => {
        let resolve;
        const settled = new Promise((done) => { resolve = done; });
        providerToolStates.set(event.toolCallId, { toolName: event.toolName, resolve, settled });
        await emit(event);
    };
    const bufferProviderToolResult = async (result) => {
        if (!bufferedProviderToolCallIds.has(result.toolCallId)) {
            bufferedProviderToolCallIds.add(result.toolCallId);
            providerToolResults.push(result);
        }
        const state = providerToolStates.get(result.toolCallId);
        if (state) {
            providerToolStates.delete(result.toolCallId);
            state.resolve();
        }
        return result;
    };
    const settleProviderTools = async () => {
        if (providerToolStates.size === 0)
            return;
        const allSettled = Promise.all([...providerToolStates.values()].map((state) => state.settled));
        if (!signal?.aborted) {
            await allSettled;
            return;
        }
        let timeout;
        await Promise.race([
            allSettled,
            new Promise((resolve) => { timeout = setTimeout(resolve, 1000); }),
        ]);
        if (timeout)
            clearTimeout(timeout);
        for (const [toolCallId, state] of providerToolStates) {
            if (!bufferedProviderToolCallIds.has(toolCallId)) {
                bufferedProviderToolCallIds.add(toolCallId);
                providerToolResults.push({
                    role: "toolResult",
                    toolCallId,
                    toolName: state.toolName,
                    content: [{ type: "text", text: "Tool execution aborted before a result settled" }],
                    isError: true,
                    timestamp: Date.now(),
                });
            }
            providerToolStates.delete(toolCallId);
            state.resolve();
        }
    };
    const response = await streamFunction(config.model, llmContext, {
        ...config,
        apiKey: resolvedApiKey,
        signal,
        onToolResult: bufferProviderToolResult,
        onProviderToolExecutionStart: beginProviderTool,
        onProviderToolExecutionUpdate: (event) => emit(event),
        onProviderToolExecutionEnd: (event) => emit(event),
    });`,
    "provider-lifecycle",
  );
  next = replaceOnce(
    next,
    `                await emit({ type: "message_end", message: finalMessage });
                return finalMessage;`,
    `                await settleProviderTools();
                await emit({ type: "message_end", message: finalMessage });
                return { message: finalMessage, providerToolResults };`,
    "terminal-results",
  );
  next = replaceOnce(
    next,
    `    await emit({ type: "message_end", message: finalMessage });
    return finalMessage;
}`,
    `    await settleProviderTools();
    await emit({ type: "message_end", message: finalMessage });
    return { message: finalMessage, providerToolResults };
}`,
    "eof-results",
  );
  return replaceOnce(
    next,
    `    const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");`,
    `    const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall" && !isCursorExecResolved(c));`,
    "defense-in-depth-skip",
  );
}

export function patchCodingAgentSdk(source) {
  // 1.0.1 builds the Agent as `const agent` after buildRequestOptions, so `let agent;` is gone.
  // Declare the session binding right before buildRequestOptions; its closures read it per request.
  let next = replaceOnce(
    source,
    `    const buildRequestOptions = (requestModel, options = {}) => {`,
    `    let session;
    const buildRequestOptions = (requestModel, options = {}) => {`,
    "session-closure",
  );
  next = replaceOnce(
    next,
    `            maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
            transformHeaders: async (requestHeaders) => {`,
    `            maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
            // The ModelRuntime can be shared by parent and child sessions. Resolve
            // tool ownership from this createAgentSession closure on every request;
            // a provider-global extension binding can execute in the wrong cwd.
            providerExecuteTool: (toolName, params, executionOptions) => {
                if (!session)
                    throw new Error("provider-execution session is not initialized");
                return session.executeTool(toolName, params, executionOptions);
            },
            providerExecCwd: cwd,
            providerExecAgentDir: agentDir,
            providerExecLineageId: () => {
                if (!session)
                    throw new Error("provider-execution session is not initialized");
                return session.sessionId;
            },
            transformHeaders: async (requestHeaders) => {`,
    "request-local-executor",
  );
  return replaceOnce(
    next,
    `    const session = new AgentSession({`,
    `    session = new AgentSession({`,
    "session-assignment",
  );
}

export function patchExtensionToolResult(source) {
  let next = replaceOnce(
    source,
    `                    if (handlerResult.usage !== undefined) {\n                        currentEvent.usage = handlerResult.usage;\n                        modified = true;\n                    }`,
    `                    if (handlerResult.usage !== undefined) {\n                        currentEvent.usage = handlerResult.usage;\n                        modified = true;\n                    }\n                    if (handlerResult.addedToolNames !== undefined) {\n                        currentEvent.addedToolNames = handlerResult.addedToolNames;\n                        modified = true;\n                    }`,
    "emit-added-tool-names",
  );
  return replaceOnce(
    next,
    `            structuredContent: currentEvent.structuredContent,\n            isError: currentEvent.isError,\n            usage: currentEvent.usage,\n        };`,
    `            structuredContent: currentEvent.structuredContent,\n            isError: currentEvent.isError,\n            usage: currentEvent.usage,\n            addedToolNames: currentEvent.addedToolNames,\n        };`,
    "return-added-tool-names",
  );
}

// 1.0.1 moved the afterToolCall body into AgentSession._afterToolCall (shared by model calls and
// ctx.executeTool nested calls) and added structuredContent; the anchors follow that method.
export function patchAgentSessionAfterToolCall(source) {
  let next = replaceOnce(
    source,
    `                isError,\n                usage: result.usage,\n            })`,
    `                isError,\n                usage: result.usage,\n                addedToolNames: result.addedToolNames,\n            })`,
    "emit-session-added-tool-names",
  );
  return replaceOnce(
    next,
    `            isError: hookResult?.isError ?? isError,\n            usage: hookResult?.usage,\n        };`,
    `            isError: hookResult?.isError ?? isError,\n            usage: hookResult?.usage,\n            addedToolNames: hookResult?.addedToolNames ?? result.addedToolNames,\n        };`,
    "return-session-added-tool-names",
  );
}

const file = (path, sourcePath) => Object.freeze({
  target: "package",
  packageName: "@earendil-works/pi-ai",
  version: PACKAGE_VERSION,
  path,
  sourcePath,
});

export const files = Object.freeze([
  file(
    "dist/rubato-features/provider-execution/extension.mjs",
    fileURLToPath(new URL("./extension.mjs", import.meta.url)),
  ),
  file(
    "dist/rubato-features/provider-execution/cursor-exec-bridge.mjs",
    fileURLToPath(new URL("./cursor-exec-bridge.mjs", import.meta.url)),
  ),
  file(
    "dist/rubato-features/provider-execution/cursor-exec-journal.mjs",
    fileURLToPath(new URL("./cursor-exec-journal.mjs", import.meta.url)),
  ),
  file(
    "dist/rubato-features/provider-execution/cursor-host-mutation.mjs",
    fileURLToPath(new URL("./cursor-host-mutation.mjs", import.meta.url)),
  ),
  file(
    "dist/rubato-features/provider-execution/THIRD_PARTY_NOTICES.md",
    fileURLToPath(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url)),
  ),
]);

export const patches = Object.freeze([
  Object.freeze({
    id: "provider-execution:coding-agent-sdk",
    packageName: CODING_AGENT_PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/core/sdk.js",
    preimageSha256: "fe643170de3d259c7e06179d9e18270a009dfb54df915f6e3de515425b8d009b",
    apply: patchCodingAgentSdk,
  }),
  Object.freeze({
    id: "provider-execution:extension-tool-result",
    packageName: CODING_AGENT_PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/core/extensions/runner.js",
    preimageSha256: "258f142bc56cc84d953ef6146222e5ff3a94cc908592a1b3d075d34bbcd68b36",
    apply: patchExtensionToolResult,
  }),
  Object.freeze({
    id: "provider-execution:session-after-tool-call",
    packageName: CODING_AGENT_PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/core/agent-session.js",
    preimageSha256: "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab",
    apply: patchAgentSessionAfterToolCall,
  }),
  Object.freeze({
    id: "provider-execution:agent-loop",
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/agent-loop.js",
    preimageSha256: "65def8c7f3fa01e38fe05467520efc8673c22ea8197833a3b04b29c8a60cb1e3",
    apply: patchAgentLoop,
  }),
]);

export const providerExecutionFeature = Object.freeze({
  id: "provider-execution",
  files,
  patches,
});
