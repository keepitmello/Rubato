import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";
const FEATURE_IMPORT = 'import { RequestRunTracker } from "../rubato-features/request-run/request-run-tracker.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[request-run:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[request-run:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`[request-run:${label}] expected anchor is missing (already patched)`);
  }
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `request-run:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

/**
 * This patch intentionally consumes the input-lifecycle and abort-provenance
 * seams. The feature catalog must order both dependencies before request-run.
 */
function patchAgentSessionRuntime(source) {
  unpatched(source, FEATURE_IMPORT, "agent-session");
  let next = replaceOnce(
    source,
    'import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";',
    `import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";\n${FEATURE_IMPORT}`,
    "session-import",
  );
  next = replaceOnce(
    next,
    `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    _followUpMessages = [];
    _inputLifecycle = new InputLifecycle();`,
    `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    _followUpMessages = [];
    _requestRunTracker = new RequestRunTracker();
    _inputLifecycle = new InputLifecycle();`,
    "session-state",
  );
  next = replaceOnce(
    next,
    `            type: "queue_update",
            steering: [...this._steeringMessages],
            followUp: [...this._followUpMessages],
        });`,
    `            type: "queue_update",
            steering: [...this._steeringMessages],
            followUp: [...this._followUpMessages],
            pendingInputs: this._requestRunTracker.snapshot().pendingInputs,
        });`,
    "queue-update",
  );
  next = replaceOnce(
    next,
    `    _handleAgentEvent = async (event) => {
        // When a user message starts, check if it's from either queue and remove it BEFORE emitting`,
    `    _handleAgentEvent = async (event) => {
        // Update the request ledger before extensions, RPC, or the TUI consume this event.
        this._requestRunTracker.observe(event);
        // When a user message starts, check if it's from either queue and remove it BEFORE emitting`,
    "event-observer",
  );
  next = replaceOnce(
    next,
    `    async _emitAgentSettled() {
        this._isAgentRunActive = false;
        try {
            await this._extensionRunner.emit({ type: "agent_settled" });`,
    `    async _emitAgentSettled() {
        this._isAgentRunActive = false;
        try {
            this._requestRunTracker.onAgentSettled();
            await this._extensionRunner.emit({ type: "agent_settled" });`,
    "settled-terminal",
  );
  next = replaceOnce(
    next,
    `        if (event.type === "agent_end") {
            try {
                this._emit(extensionEvent);`,
    `        if (event.type === "agent_end") {
            if (extensionEvent.aborted) {
                this._requestRunTracker.onInterrupted();
            }
            try {
                this._emit(extensionEvent);`,
    "agent-end-terminal",
  );
  next = replaceOnce(
    next,
    `    async _emitSessionAbort() {
        const event = { type: "session_abort" };
        await this._extensionRunner.emit(event);`,
    `    async _emitSessionAbort() {
        const event = { type: "session_abort" };
        this._requestRunTracker.onInterrupted();
        await this._extensionRunner.emit(event);`,
    "gap-terminal",
  );
  next = replaceOnce(
    next,
    `            this._inputLifecycle.bindMessage(inputId, userMessage, {
                delivery: "submit",
                text: expandedText,
                images: currentImages,
            });
            messages.push(userMessage);`,
    `            const inputRecord = this._inputLifecycle.bindMessage(inputId, userMessage, {
                delivery: "submit",
                text: expandedText,
                images: currentImages,
            });
            this._requestRunTracker.attachRecord(userMessage, inputRecord);
            messages.push(userMessage);`,
    "submit-record",
  );
  next = replaceOnce(
    next,
    `    async _queueSteer(text, images, inputId) {
        this._steeringMessages.push(text);
        this._emitQueueUpdate();
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        this._inputLifecycle.bindMessage(inputId, message, {
            delivery: "steer",
            text,
            images,
            pending: true,
        });
        this.agent.steer(message);
    }`,
    `    async _queueSteer(text, images, inputId) {
        this._steeringMessages.push(text);
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        const inputRecord = this._inputLifecycle.bindMessage(inputId, message, {
            delivery: "steer",
            text,
            images,
            pending: true,
        });
        this._requestRunTracker.attachRecord(message, inputRecord);
        this._requestRunTracker.enqueuePending(inputRecord);
        this._emitQueueUpdate();
        this.agent.steer(message);
    }`,
    "steer-record",
  );
  next = replaceOnce(
    next,
    `    async _queueFollowUp(text, images, inputId) {
        this._followUpMessages.push(text);
        this._emitQueueUpdate();
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        this._inputLifecycle.bindMessage(inputId, message, {
            delivery: "followUp",
            text,
            images,
            pending: true,
        });
        this.agent.followUp(message);
    }`,
    `    async _queueFollowUp(text, images, inputId) {
        this._followUpMessages.push(text);
        const content = [{ type: "text", text }];
        if (images) {
            content.push(...images);
        }
        const message = {
            role: "user",
            content,
            timestamp: Date.now(),
        };
        const inputRecord = this._inputLifecycle.bindMessage(inputId, message, {
            delivery: "followUp",
            text,
            images,
            pending: true,
        });
        this._requestRunTracker.attachRecord(message, inputRecord);
        this._requestRunTracker.enqueuePending(inputRecord);
        this._emitQueueUpdate();
        this.agent.followUp(message);
    }`,
    "followup-record",
  );
  next = replaceOnce(
    next,
    `        const steering = [...this._steeringMessages];
        const followUp = [...this._followUpMessages];
        this._abortProvenance.noteClearedQueue(steering.length > 0 || followUp.length > 0, options?.abortWillFollow === true);`,
    `        const steering = [...this._steeringMessages];
        const followUp = [...this._followUpMessages];
        this._requestRunTracker.clearPendingInputs();
        this._abortProvenance.noteClearedQueue(steering.length > 0 || followUp.length > 0, options?.abortWillFollow === true);`,
    "clear-pending",
  );
  next = replaceOnce(
    next,
    `    /** Number of pending messages (includes both steering and follow-up) */
    get pendingMessageCount() {`,
    `    requestTimelineSnapshot() {
        return this._requestRunTracker.snapshot();
    }
    readConversationPage(input = {}) {
        if (this._requestRunTracker.entries.length === 0) {
            this._requestRunTracker.rebuildFromMessages(this.agent?.state?.messages ?? []);
        }
        return this._requestRunTracker.readConversationPage(input);
    }
    getInteractiveInput(message) {
        return this._requestRunTracker.getRecord(message) ?? this._inputLifecycle.getMessageRecord(message);
    }
    updateQueuedInputDelivery(message, delivery) {
        return this._requestRunTracker.updatePendingDelivery(message, delivery);
    }
    clearPendingInteractiveInputs() {
        const cleared = this._requestRunTracker.clearPendingInputs();
        this.clearQueue();
        return cleared;
    }
    /** Number of pending messages (includes both steering and follow-up) */
    get pendingMessageCount() {`,
    "session-api",
  );
  return next;
}

function patchAgentSessionTypes(source) {
  unpatched(source, "export interface RequestTimelineSnapshot", "agent-session-types");
  let next = replaceOnce(
    source,
    `/** Session statistics for /session command */
export interface SessionStats {`,
    `export interface RequestRunInputRecord {
    id: string;
    delivery?: "submit" | "steer" | "followUp";
    source: "tui" | "remote" | "extension" | "unknown";
    text: string;
    imageCount: number;
    enqueuedAt: number;
    processedAt?: number;
    targetRequestRunId?: string;
}
export interface PendingInputSummary {
    id: string;
    delivery: "steer" | "followUp";
    textPreview: string;
    textLength: number;
    imageCount: number;
    enqueuedAt: string;
    source: RequestRunInputRecord["source"];
    targetRequestRunId?: string;
}
export interface RequestRunSummary {
    id: string;
    status: "running" | "awaiting_input" | "completed" | "interrupted" | "failed";
    rootUserMessageId: string;
    startedAt: string;
    completedAt?: string;
    finalMessageId?: string;
    lastProgressPreview?: string;
    progressMessageCount: number;
    toolCount: number;
    failedToolCount: number;
    steeringCount: number;
    failureMessage?: string;
}
export interface RequestTimelineSnapshot {
    schemaVersion: 1;
    runs: RequestRunSummary[];
    activeRequestRunId?: string;
    pendingInputs: PendingInputSummary[];
    hasOlder: boolean;
}
export interface RequestConversationPage {
    entries: Array<Record<string, unknown>>;
    requestRuns: RequestRunSummary[];
    nextBefore?: string;
}
/** Session statistics for /session command */
export interface SessionStats {`,
    "timeline-types",
  );
  next = replaceOnce(
    next,
    `    type: "queue_update";
    steering: readonly string[];
    followUp: readonly string[];
} | {`,
    `    type: "queue_update";
    steering: readonly string[];
    followUp: readonly string[];
    pendingInputs: readonly PendingInputSummary[];
} | {`,
    "queue-event-types",
  );
  next = replaceOnce(
    next,
    `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    private _followUpMessages;
    /** Messages queued to be included with the next user prompt as context ("asides"). */`,
    `    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    private _followUpMessages;
    private _requestRunTracker;
    /** Messages queued to be included with the next user prompt as context ("asides"). */`,
    "tracker-field",
  );
  next = replaceOnce(
    next,
    `    /** Number of pending messages (includes both steering and follow-up) */
    get pendingMessageCount(): number;`,
    `    requestTimelineSnapshot(): RequestTimelineSnapshot;
    readConversationPage(input?: {
        before?: string;
        limit?: number;
    }): RequestConversationPage;
    getInteractiveInput(message: AgentMessage): RequestRunInputRecord | undefined;
    updateQueuedInputDelivery(message: AgentMessage, delivery: "steer" | "followUp"): RequestRunInputRecord | undefined;
    clearPendingInteractiveInputs(): {
        clearedIds: string[];
    };
    /** Number of pending messages (includes both steering and follow-up) */
    get pendingMessageCount(): number;`,
    "session-api-types",
  );
  return next;
}

function patchRpcRuntime(source) {
  unpatched(source, "requestTimeline: session.requestTimelineSnapshot()", "rpc-runtime");
  return replaceOnce(
    source,
    `                    messageCount: session.messages.length,
                    pendingMessageCount: session.pendingMessageCount,
                };`,
    `                    messageCount: session.messages.length,
                    pendingMessageCount: session.pendingMessageCount,
                    requestTimeline: session.requestTimelineSnapshot(),
                };`,
    "get-state",
  );
}

function patchRpcTypes(source) {
  unpatched(source, "requestTimeline: RequestTimelineSnapshot", "rpc-types");
  let next = replaceOnce(
    source,
    `import type { SessionStats } from "../../core/agent-session.ts";`,
    `import type { RequestTimelineSnapshot, SessionStats } from "../../core/agent-session.ts";`,
    "timeline-import",
  );
  next = replaceOnce(
    next,
    `    messageCount: number;
    pendingMessageCount: number;
}`,
    `    messageCount: number;
    pendingMessageCount: number;
    requestTimeline: RequestTimelineSnapshot;
}`,
    "state-type",
  );
  return next;
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/rubato-features/request-run/request-run-tracker.mjs",
    sourcePath: fileURLToPath(new URL("../../../rubato-pi/src/transforms/request-run-tracker.mjs", import.meta.url)),
  }),
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/rubato-features/request-run/assistant-phase.mjs",
    sourcePath: fileURLToPath(new URL("../../../rubato-pi/src/transforms/assistant-phase.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("dist/core/agent-session.js", "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "db3bfd2ae08eda4936d8807656f06120e6e62672d6a7798bccba486a0dc994ea", patchAgentSessionTypes),
  patch("dist/modes/rpc/rpc-mode.js", "e7e4724aa55c5aac73cf36793653b26736200e5c59d58373990fc31028f86477", patchRpcRuntime),
  patch("dist/modes/rpc/rpc-types.d.ts", "e968e5be01dc7ad9615f938ae867ef136fa495f13dcf169942e9f781a299d9eb", patchRpcTypes),
]);

export const feature = Object.freeze({ id: "request-run", patches, files });
