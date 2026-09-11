/** Browser-safe Cursor history serialization. */
import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { CURSOR_COMPOSER_PROMPT, isCursorComposerModel } from "../../cursor/composer-prompt.js";
import { AgentConversationTurnStructureSchema, AssistantMessageSchema, ConversationStepSchema, ConversationTurnStructureSchema, McpArgsSchema, McpImageContentSchema, McpSuccessSchema, McpTextContentSchema, McpToolCallSchema, McpToolErrorSchema, McpToolResultContentItemSchema, McpToolResultSchema, SelectedContextSchema, SelectedImageSchema, ToolCallSchema, UserMessageSchema, } from "./gen/agent_pb.js";
function hashBytes(input) {
    const out = new Uint8Array(32);
    const b = typeof input === "string" ? new TextEncoder().encode(input) : input;
    for (let i = 0; i < b.length; i++)
        out[i % 32] = (out[i % 32] + b[i] + i) & 255;
    return out;
}
function createHash(input) {
    let data = typeof input === "string" ? input : new TextDecoder().decode(input);
    return {
        update(v) {
            data += typeof v === "string" ? v : new TextDecoder().decode(v);
            return this;
        },
        digest(format) {
            const b = hashBytes(data);
            return format === "hex" ? [...b].map((x) => x.toString(16).padStart(2, "0")).join("") : b;
        },
    };
}
function deterministicUuid(s) {
    const h = [...hashBytes(s)].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function randomUUID() {
    const h = [...hashBytes(String(Math.random()) + Date.now())].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function storeCursorBlob(m, d) {
    const id = hashBytes(d);
    m.set([...id].map((x) => x.toString(16).padStart(2, "0")).join(""), d);
    return id;
}
function readCursorBlob(m, id) {
    const d = m.get([...id].map((x) => x.toString(16).padStart(2, "0")).join(""));
    if (!d)
        throw Error("Cursor blob not found");
    return d;
}
function toolResultToText(r) {
    return r.content.map((i) => (i.type === "text" ? i.text : `[${i.mimeType} image]`)).join("\n");
}
/** Extract text content from a user message. */
function extractUserMessageText(msg) {
    if (msg.role !== "user")
        return "";
    const content = msg.content;
    if (typeof content === "string")
        return content.trim();
    const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    return text.trim();
}
function hasUserMessageImages(msg) {
    return msg.role === "user" && Array.isArray(msg.content) && msg.content.some((item) => item.type === "image");
}
function buildCursorRootPromptContent(content) {
    if (typeof content === "string") {
        const text = content.trim();
        return text ? [{ type: "text", text }] : [];
    }
    const parts = [];
    for (const item of content) {
        if (item.type === "text") {
            const text = item.text.trim();
            if (text) {
                parts.push({ type: "text", text });
            }
        }
        else {
            parts.push({ type: "image", image: `data:${item.mimeType};base64,${item.data}`, mediaType: item.mimeType });
        }
    }
    return parts;
}
function cursorUserContentKey(content) {
    if (typeof content === "string") {
        return content.trim();
    }
    const hash = createHash("sha256");
    for (const item of content) {
        hash.update(item.type);
        if (item.type === "text") {
            hash.update(item.text);
        }
        else {
            hash.update(item.mimeType);
            hash.update(item.data);
        }
    }
    return hash.digest("hex");
}
function buildCursorAssistantContent(msg) {
    const content = [];
    for (const item of msg.content) {
        if (item.type === "text") {
            if (item.text)
                content.push({ type: "text", text: item.text });
        }
        else if (item.type === "toolCall") {
            content.push({
                type: "tool-call",
                toolCallId: item.id,
                toolName: item.name,
                args: item.arguments,
            });
        }
        // Thinking is never replayed: Cursor manages reasoning server-side and
        // foreign/hidden reasoning must not leak into history as native thinking.
    }
    return content;
}
/**
 * Index of the last user message in `messages`, or -1 if none. Used to
 * exclude the current user turn from history builders — it goes in the
 * `userMessageAction`, not in history structures.
 */
function findLastUserMessageIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            return i;
        }
    }
    return -1;
}
/**
 * Build one Cursor system-message JSON blob per system prompt. When no system
 * prompt is provided, returns a single default greeting so we never emit an
 * empty `rootPromptMessagesJson` head.
 *
 * Composer models get their operating prefix as its own leading blob rather
 * than concatenated into the host prompt, so Cursor's per-blob prompt cache
 * keeps the prefix stable while the host prompt changes underneath it.
 */
export function buildCursorSystemPromptJsons(systemPrompt, modelId) {
    const trimmed = systemPrompt?.trim();
    const host = trimmed
        ? [JSON.stringify({ role: "system", content: trimmed })]
        : [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
    if (modelId !== undefined && isCursorComposerModel(modelId)) {
        return [JSON.stringify({ role: "system", content: CURSOR_COMPOSER_PROMPT }), ...host];
    }
    return host;
}
/**
 * Build `ConversationStateStructure.rootPromptMessagesJson` blob IDs for the
 * system prompt plus prior conversation history, as JSON blobs matching
 * Cursor's internal Vercel-AI-SDK-shaped message format.
 *
 * Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build the
 * actual model prompt; `turns[]` is UI/display metadata. The active user
 * message is excluded because it is sent in the action.
 */
function buildRootPromptMessagesJson(messages, systemPromptIds, blobStore, activeUserMessageIndex = findLastUserMessageIndex(messages)) {
    const entries = [...systemPromptIds];
    const pushJson = (obj) => {
        const bytes = new TextEncoder().encode(JSON.stringify(obj));
        entries.push(storeCursorBlob(blobStore, bytes));
    };
    for (let i = 0; i < messages.length; i++) {
        if (i === activeUserMessageIndex)
            break;
        const msg = messages[i];
        if (msg.role === "user") {
            const content = buildCursorRootPromptContent(msg.content);
            if (content.length === 0)
                continue;
            pushJson({ role: "user", content });
        }
        else if (msg.role === "assistant") {
            const content = buildCursorAssistantContent(msg);
            if (content.length === 0)
                continue;
            pushJson({ role: "assistant", content });
        }
        else if (msg.role === "toolResult") {
            // Emit even when the result text is empty: the assistant `tool-call`
            // is already in history, so dropping the pair would replay an
            // orphaned call.
            pushJson({
                role: "tool",
                id: msg.toolCallId,
                content: [
                    {
                        type: "tool-result",
                        toolName: msg.toolName,
                        toolCallId: msg.toolCallId,
                        result: toolResultToText(msg),
                        ...(msg.isError ? { isError: true } : {}),
                    },
                ],
            });
        }
    }
    return entries;
}
function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isJsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (!isPlainRecord(value))
        return false;
    for (const key in value) {
        if (!isJsonValue(value[key]))
            return false;
    }
    return true;
}
function encodeCursorMcpArguments(toolCall) {
    const encoded = {};
    for (const name in toolCall.arguments) {
        const value = toolCall.arguments[name];
        if (value === undefined)
            continue;
        if (!isJsonValue(value)) {
            throw new Error(`Cursor tool argument ${toolCall.name}.${name} is not JSON-serializable`);
        }
        encoded[name] = toBinary(ValueSchema, fromJson(ValueSchema, value));
    }
    return encoded;
}
function createCursorMcpResult(result) {
    if (result.isError) {
        return create(McpToolResultSchema, {
            result: {
                case: "error",
                value: create(McpToolErrorSchema, { error: toolResultToText(result) }),
            },
        });
    }
    return create(McpToolResultSchema, {
        result: {
            case: "success",
            value: create(McpSuccessSchema, {
                content: result.content.map((item) => item.type === "text"
                    ? create(McpToolResultContentItemSchema, {
                        content: { case: "text", value: create(McpTextContentSchema, { text: item.text }) },
                    })
                    : create(McpToolResultContentItemSchema, {
                        content: {
                            case: "image",
                            value: create(McpImageContentSchema, {
                                data: Uint8Array.from(Uint8Array.from(atob(item.data), (c) => c.charCodeAt(0))),
                                mimeType: item.mimeType,
                            }),
                        },
                    })),
            }),
        },
    });
}
function createCursorToolCallStep(toolCall, result) {
    const mcpCall = create(McpToolCallSchema, {
        args: create(McpArgsSchema, {
            name: toolCall.name,
            args: encodeCursorMcpArguments(toolCall),
            toolCallId: toolCall.id,
            providerIdentifier: "pi-agent",
            toolName: toolCall.name,
        }),
        ...(result ? { result: createCursorMcpResult(result) } : {}),
    });
    return create(ConversationStepSchema, {
        message: {
            case: "toolCall",
            value: create(ToolCallSchema, {
                tool: { case: "mcpToolCall", value: mcpCall },
                toolCallId: toolCall.id,
            }),
        },
    });
}
/**
 * Convert context.messages to Cursor's ConversationTurnStructure blob IDs.
 * Groups messages into turns: each turn is a user message followed by the
 * assistant's response. Excludes the active user message (which goes in the
 * action).
 */
function buildConversationTurns(messages, blobStore, activeUserMessageIndex = findLastUserMessageIndex(messages)) {
    const turns = [];
    const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
    const toolResults = new Map();
    const pairedToolCallIds = new Set();
    for (let index = 0; index < historyEnd; index++) {
        const message = messages[index];
        if (message.role === "toolResult") {
            toolResults.set(message.toolCallId, message);
        }
        else if (message.role === "assistant") {
            for (const item of message.content) {
                if (item.type === "toolCall")
                    pairedToolCallIds.add(item.id);
            }
        }
    }
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role !== "user") {
            i++;
            continue;
        }
        if (i === activeUserMessageIndex)
            break;
        const userText = extractUserMessageText(msg);
        if (userText.length === 0 && !hasUserMessageImages(msg)) {
            i++;
            continue;
        }
        const userMessage = createCursorUserMessage(msg.content, userText, deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`));
        const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage));
        const stepBlobIds = [];
        i++;
        while (i < messages.length && messages[i].role !== "user") {
            const stepMsg = messages[i];
            if (stepMsg.role === "assistant") {
                for (const item of stepMsg.content) {
                    let step;
                    if (item.type === "text") {
                        if (!item.text)
                            continue;
                        step = create(ConversationStepSchema, {
                            message: {
                                case: "assistantMessage",
                                value: create(AssistantMessageSchema, { text: item.text }),
                            },
                        });
                    }
                    else if (item.type === "thinking") {
                        // Foreign/hidden reasoning never leaks into Cursor's turn
                        // history as native thinking.
                        continue;
                    }
                    else if (item.type === "toolCall") {
                        step = createCursorToolCallStep(item, toolResults.get(item.id));
                    }
                    else {
                        continue;
                    }
                    stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
                }
            }
            else if (stepMsg.role === "toolResult" && !pairedToolCallIds.has(stepMsg.toolCallId)) {
                const text = toolResultToText(stepMsg);
                if (text) {
                    const prefix = stepMsg.isError ? "[Tool Error]" : "[Tool Result]";
                    const step = create(ConversationStepSchema, {
                        message: {
                            case: "assistantMessage",
                            value: create(AssistantMessageSchema, { text: `${prefix}\n${text}` }),
                        },
                    });
                    stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
                }
            }
            i++;
        }
        const agentTurn = create(AgentConversationTurnStructureSchema, {
            userMessage: userMessageBlobId,
            steps: stepBlobIds,
        });
        const turn = create(ConversationTurnStructureSchema, {
            turn: {
                case: "agentConversationTurn",
                value: agentTurn,
            },
        });
        turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
    }
    return turns;
}
/** Exported for tests: decodes Cursor history blobs built from conversation messages. */
export function buildCursorHistoryForTest(messages, activeUserMessageIndex = findLastUserMessageIndex(messages)) {
    const blobStore = new Map();
    const rootPromptMessagesJson = buildRootPromptMessagesJson(messages, [], blobStore, activeUserMessageIndex).map((blobId) => JSON.parse(new TextDecoder().decode(readCursorBlob(blobStore, blobId))));
    const turnUserMessagesJson = [];
    const turnStepMessagesJson = [];
    for (const turnBlobId of buildConversationTurns(messages, blobStore, activeUserMessageIndex)) {
        const turn = fromBinary(ConversationTurnStructureSchema, readCursorBlob(blobStore, turnBlobId));
        if (turn.turn.case !== "agentConversationTurn") {
            continue;
        }
        const userMessage = fromBinary(UserMessageSchema, readCursorBlob(blobStore, turn.turn.value.userMessage));
        turnUserMessagesJson.push(toJson(UserMessageSchema, userMessage));
        turnStepMessagesJson.push(turn.turn.value.steps.map((stepBlobId) => {
            const step = fromBinary(ConversationStepSchema, readCursorBlob(blobStore, stepBlobId));
            return toJson(ConversationStepSchema, step);
        }));
    }
    return { rootPromptMessagesJson, turnUserMessagesJson, turnStepMessagesJson };
}
function createCursorUserMessage(content, text, messageId = randomUUID()) {
    const images = typeof content === "string" ? [] : extractImages(content);
    return create(UserMessageSchema, {
        text,
        messageId,
        ...(images.length > 0
            ? {
                selectedContext: create(SelectedContextSchema, {
                    selectedImages: images,
                }),
            }
            : {}),
    });
}
function extractImages(content) {
    return content
        .filter((item) => item.type === "image")
        .map((image) => create(SelectedImageSchema, {
        uuid: randomUUID(),
        mimeType: image.mimeType,
        dataOrBlobId: {
            case: "data",
            value: Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)),
        },
    }));
}
export function measureCursorHistorySerializedBytes(messages, activeUserMessageIndex = findLastUserMessageIndex(messages)) {
    return buildCursorHistoryWireBytesForTest(messages, activeUserMessageIndex).reduce((total, bytes) => total + bytes.byteLength, 0);
}
export function buildCursorHistoryWireBytesForTest(messages, activeUserMessageIndex = findLastUserMessageIndex(messages)) {
    const blobStore = new Map();
    buildRootPromptMessagesJson(messages, [], blobStore, activeUserMessageIndex);
    buildConversationTurns(messages, blobStore, activeUserMessageIndex);
    return [...blobStore.values()];
}
//# sourceMappingURL=measure.js.map