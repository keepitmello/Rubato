// [cluster:cursor-vendor]
// 20260831-1150Z-cursor-native-checkpoint + read-image + Task 문구.
// 예전엔 cursor-agent.js 통파일을 한 바늘로 갈았다. senpi 2026.9.4-3 이
// Composer import·blob cap 을 넣자 그 바늘이 빗나갔고, checkpoint 메아리가
// 통째로 빠졌다. 캐시를 살리는 자리만 작은 바늘로 건다.
import { replaceOnce } from "./replace-once.mjs";

export function isCursorAgentUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/cursor-agent.js");
}

const MAPS_NEEDLE = `const conversationStateCache = new Map();
const conversationBlobStores = new Map();
/** Cache key -> the senpi session that owns it, so session teardown can evict. */`;

const MAPS_REPLACEMENT = `const conversationStateCache = new Map();
const conversationBlobStores = new Map();
/** Wire ids whose cache entry is a server conversation_checkpoint_update. */
const serverCheckpointIds = new Set();
/** First RequestContext per wire id — rebuilt overlays shift the prompt prefix. */
const frozenRequestContexts = new Map();
function pinRequestContext(conversationId, requestContextTools) {
    if (conversationId) {
        const existing = frozenRequestContexts.get(conversationId);
        if (existing)
            return existing;
    }
    const requestContext = create(RequestContextSchema, {
        rules: [],
        repositoryInfo: [],
        tools: requestContextTools,
        gitRepos: [],
        projectLayouts: [],
        mcpInstructions: [],
        fileContents: {},
        customSubagents: [],
    });
    if (conversationId)
        frozenRequestContexts.set(conversationId, requestContext);
    return requestContext;
}
/** Cache key -> the senpi session that owns it, so session teardown can evict. */`;

const FORGET_NEEDLE = `function forgetConversationCacheKey(conversationId) {
    conversationStateCache.delete(conversationId);
    conversationBlobStores.delete(conversationId);
    conversationCacheKeySessions.delete(conversationId);
}`;

const FORGET_REPLACEMENT = `function forgetConversationCacheKey(conversationId) {
    conversationStateCache.delete(conversationId);
    conversationBlobStores.delete(conversationId);
    conversationCacheKeySessions.delete(conversationId);
    serverCheckpointIds.delete(conversationId);
    frozenRequestContexts.delete(conversationId);
}`;

const CHECKPOINT_NEEDLE = `                const onConversationCheckpoint = (checkpoint) => {
                    attemptSawCheckpoint = true;
                    conversationStateCache.set(conversationId, checkpoint);
                };`;

const CHECKPOINT_REPLACEMENT = `                const onConversationCheckpoint = (checkpoint) => {
                    attemptSawCheckpoint = true;
                    conversationStateCache.set(conversationId, checkpoint);
                    serverCheckpointIds.add(conversationId);
                };`;

const ROTATE_NEEDLE = `                            const blobs = conversationBlobStores.get(conversationId);
                            if (blobs)
                                conversationBlobStores.set(decision.wireId, blobs);
                            registerConversationCacheKey(options?.sessionId, decision.wireId);`;

const ROTATE_REPLACEMENT = `                            const blobs = conversationBlobStores.get(conversationId);
                            if (blobs)
                                conversationBlobStores.set(decision.wireId, blobs);
                            if (serverCheckpointIds.has(conversationId))
                                serverCheckpointIds.add(decision.wireId);
                            const frozen = frozenRequestContexts.get(conversationId);
                            if (frozen)
                                frozenRequestContexts.set(decision.wireId, frozen);
                            registerConversationCacheKey(options?.sessionId, decision.wireId);`;

const DISPATCH_CALL_NEEDLE = `                            const dispatch = handleServerMessage(serverMessage, output, stream, state, blobStore, h2Request, options?.execHandlers, state.onToolResult, usageState, requestContextTools, onConversationCheckpoint).catch((error) => {`;

const DISPATCH_CALL_REPLACEMENT = `                            const dispatch = handleServerMessage(serverMessage, output, stream, state, blobStore, h2Request, options?.execHandlers, state.onToolResult, usageState, requestContextTools, onConversationCheckpoint, conversationId).catch((error) => {`;

const HANDLE_SERVER_NEEDLE = `export async function handleServerMessage(msg, output, stream, state, blobStore, h2Request, execHandlers, onToolResult, usageState, requestContextTools, onConversationCheckpoint) {`;

const HANDLE_SERVER_REPLACEMENT = `export async function handleServerMessage(msg, output, stream, state, blobStore, h2Request, execHandlers, onToolResult, usageState, requestContextTools, onConversationCheckpoint, conversationId) {`;

const EXEC_TRACK_NEEDLE = `        await stream.trackLocalWork(handleExecServerMessage(msg.message.value, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state));`;

const EXEC_TRACK_REPLACEMENT = `        await stream.trackLocalWork(handleExecServerMessage(msg.message.value, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state, conversationId));`;

const HANDLE_EXEC_NEEDLE = `async function handleExecServerMessage(execMsg, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state) {`;

const HANDLE_EXEC_REPLACEMENT = `async function handleExecServerMessage(execMsg, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state, conversationId) {`;

const EXEC_CONTEXT_NEEDLE = `        await dispatchExecServerMessage({
            execMsg,
            h2Request,
            execHandlers,
            onToolResult,
            requestContextTools,
            output,
            stream,
            state,
        });`;

const EXEC_CONTEXT_REPLACEMENT = `        await dispatchExecServerMessage({
            execMsg,
            h2Request,
            execHandlers,
            onToolResult,
            requestContextTools,
            output,
            stream,
            state,
            conversationId,
        });`;

const EXEC_DESTRUCTURE_NEEDLE = `    const { execMsg, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state } = context;`;

const EXEC_DESTRUCTURE_REPLACEMENT = `    const { execMsg, h2Request, execHandlers, onToolResult, requestContextTools, output, stream, state, conversationId } = context;`;

const REQUEST_CONTEXT_NEEDLE = `    if (execCase === "requestContextArgs") {
        const requestContext = create(RequestContextSchema, {
            rules: [],
            repositoryInfo: [],
            tools: requestContextTools,
            gitRepos: [],
            projectLayouts: [],
            mcpInstructions: [],
            fileContents: {},
            customSubagents: [],
        });`;

const REQUEST_CONTEXT_REPLACEMENT = `    if (execCase === "requestContextArgs") {
        const requestContext = pinRequestContext(conversationId, requestContextTools);`

const USER_ACTION_NEEDLE = `                value: create(UserMessageActionSchema, {
                    userMessage: createCursorUserMessage(userContent, userText),
                }),`;

const USER_ACTION_REPLACEMENT = `                value: create(UserMessageActionSchema, {
                    userMessage: createCursorUserMessage(userContent, userText),
                    requestContext: pinRequestContext(state.conversationId, buildMcpToolDefinitions(context.tools)),
                }),`;

const REBUILD_NEEDLE = `    // Always override \`rootPromptMessagesJson\` and \`turns\` with content freshly
    // built from \`context.messages\`: the server-echoed checkpoint replaces
    // historical user entries with empty placeholders.
    const conversationState = create(ConversationStateStructureSchema, {
        ...baseState,
        rootPromptMessagesJson,
        turns,
    });`;

const REBUILD_REPLACEMENT = `    // After the server has given us a conversation_checkpoint_update, echo that
    // snapshot. Rebuilding rootPrompt/turns from host messages changes the
    // model prefix and Cursor's prompt cache misses (T2 0% / later 16384).
    let conversationState;
    if (state.conversationState && serverCheckpointIds.has(state.conversationId)) {
        conversationState = state.conversationState;
    }
    else {
        conversationState = create(ConversationStateStructureSchema, {
            ...baseState,
            rootPromptMessagesJson,
            turns,
        });
    }`;

const READ_RESULT_NEEDLE = `function buildReadResultFromToolResult(path, toolResult, rangeApplied = false) {
    const text = toolResultToText(toolResult);
    if (toolResult.isError) {
        return buildReadErrorResult(path, text || "Read failed");
    }
    // Counting the payload is only the file's length when the payload is the
    // whole file: under a windowed read, answering a 20-line page of a 100-line
    // file with \`total_lines: 20\` tells a paginating server it reached the end.
    const totalLines = readTotalLinesFromDetails(toolResult) ?? (rangeApplied ? 0 : text ? text.split("\\n").length : 0);
    return create(ReadResultSchema, {
        result: {
            case: "success",
            value: create(ReadSuccessSchema, {
                path,
                totalLines,
                fileSize: BigInt(readFileSizeFromDetails(toolResult) ?? Buffer.byteLength(text, "utf-8")),
                truncated: toolResultWasTruncated(toolResult),
                output: { case: "content", value: text },
                rangeApplied,
            }),
        },
    });
}`;

const READ_RESULT_REPLACEMENT = `function buildReadResultFromToolResult(path, toolResult, rangeApplied = false) {
    const imageBytes = cursorReadImageBytes(toolResult);
    if (toolResult.isError) {
        return buildReadErrorResult(path, toolResultToText(toolResult) || "Read failed");
    }
    if (imageBytes) {
        return create(ReadResultSchema, {
            result: {
                case: "success",
                value: create(ReadSuccessSchema, {
                    path,
                    totalLines: 0,
                    fileSize: BigInt(readFileSizeFromDetails(toolResult) ?? imageBytes.byteLength),
                    truncated: toolResultWasTruncated(toolResult),
                    output: { case: "data", value: imageBytes },
                    rangeApplied,
                }),
            },
        });
    }
    // Counting the payload is only the file's length when the payload is the
    // whole file: under a windowed read, answering a 20-line page of a 100-line
    // file with \`total_lines: 20\` tells a paginating server it reached the end.
    const text = toolResultToText(toolResult);
    const totalLines = readTotalLinesFromDetails(toolResult) ?? (rangeApplied ? 0 : text ? text.split("\\n").length : 0);
    return create(ReadResultSchema, {
        result: {
            case: "success",
            value: create(ReadSuccessSchema, {
                path,
                totalLines,
                fileSize: BigInt(readFileSizeFromDetails(toolResult) ?? Buffer.byteLength(text, "utf-8")),
                truncated: toolResultWasTruncated(toolResult),
                output: { case: "content", value: text },
                rangeApplied,
            }),
        },
    });
}`;

const TASK_ARGS_IMPORT = 'import { keepUsableCursorTaskArgs } from "./cursor-task-args.js";\n';

/** Checkpoint echo, RequestContext pin, read images, Task 문구. */
export function injectCursorAgent(source, hrefs = {}) {
  const imageHref = hrefs.cursorReadImage ?? new URL("./cursor-read-image.mjs", import.meta.url).href;
  let next = replaceOnce(source, MAPS_NEEDLE, MAPS_REPLACEMENT, "cursor-checkpoint maps");
  next = replaceOnce(next, FORGET_NEEDLE, FORGET_REPLACEMENT, "cursor-checkpoint forget");
  next = replaceOnce(next, CHECKPOINT_NEEDLE, CHECKPOINT_REPLACEMENT, "cursor-checkpoint mark");
  next = replaceOnce(next, ROTATE_NEEDLE, ROTATE_REPLACEMENT, "cursor-checkpoint rotate");
  next = replaceOnce(next, DISPATCH_CALL_NEEDLE, DISPATCH_CALL_REPLACEMENT, "cursor-checkpoint dispatch call");
  next = replaceOnce(next, HANDLE_SERVER_NEEDLE, HANDLE_SERVER_REPLACEMENT, "cursor-checkpoint handleServer");
  next = replaceOnce(next, EXEC_TRACK_NEEDLE, EXEC_TRACK_REPLACEMENT, "cursor-checkpoint exec track");
  next = replaceOnce(next, HANDLE_EXEC_NEEDLE, HANDLE_EXEC_REPLACEMENT, "cursor-checkpoint handleExec");
  next = replaceOnce(next, EXEC_CONTEXT_NEEDLE, EXEC_CONTEXT_REPLACEMENT, "cursor-checkpoint exec context");
  next = replaceOnce(next, EXEC_DESTRUCTURE_NEEDLE, EXEC_DESTRUCTURE_REPLACEMENT, "cursor-checkpoint exec destructure");
  next = replaceOnce(next, REQUEST_CONTEXT_NEEDLE, REQUEST_CONTEXT_REPLACEMENT, "cursor-checkpoint pin exec context");
  next = replaceOnce(next, USER_ACTION_NEEDLE, USER_ACTION_REPLACEMENT, "cursor-checkpoint user action context");
  next = replaceOnce(next, REBUILD_NEEDLE, REBUILD_REPLACEMENT, "cursor-checkpoint echo");
  next = replaceOnce(
    next,
    TASK_ARGS_IMPORT,
    `import { keepUsableCursorTaskArgs } from "./cursor-task-args.js";\nimport { cursorReadImageBytes } from ${JSON.stringify(imageHref)};\n`,
    "cursor-read-image import",
  );
  next = replaceOnce(next, READ_RESULT_NEEDLE, READ_RESULT_REPLACEMENT, "cursor-read-image bytes");
  return replaceOnce(
    next,
    "error: `Subagents are ${NOT_IMPLEMENTED_SUFFIX}`",
    "error: `Cursor Task is not available in this client. Spawn with Agent using an exact model or preset. Board work uses team_task_*`",
    "cursor-task-is-not-a-subagent",
  );
}
