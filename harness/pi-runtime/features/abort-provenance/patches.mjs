import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";
const FEATURE_IMPORT = 'import { AbortProvenance } from "../rubato-features/abort-provenance/state.mjs";';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[abort-provenance:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[abort-provenance:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`[abort-provenance:${label}] expected anchor is missing (already patched)`);
  }
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `abort-provenance:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

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
    `    _retryAbortController = undefined;
    _retryAttempt = 0;
    // Bash execution state`,
    `    _retryAbortController = undefined;
    _retryAttempt = 0;
    _abortProvenance = new AbortProvenance();
    // Bash execution state`,
    "session-state",
  );
  next = replaceOnce(
    next,
    `        // Emit to extensions first
        await this._emitExtensionEvent(event);
        // Notify all listeners
        this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);`,
    `        // Compute retry intent once so extensions and session listeners see one event object.
        const agentEndWillRetry = event.type === "agent_end" && this._willRetryAfterAgentEnd(event);
        const extensionEvent = await this._emitExtensionEvent(event, agentEndWillRetry);
        // Keep the boundary open through synchronous AgentSession listeners. A user abort
        // racing either consumer joins this same event instead of emitting session_abort.
        if (event.type === "agent_end") {
            try {
                this._emit(extensionEvent);
            }
            finally {
                this._abortProvenance.closeAgentEndBoundary();
            }
        }
        else {
            this._emit(event);
        }`,
    "agent-event-boundary",
  );
  next = replaceOnce(
    next,
    `    async _emitExtensionEvent(event) {
        if (event.type === "agent_start") {`,
    `    async _emitExtensionEvent(event, agentEndWillRetry = false) {
        if (event.type === "agent_start") {`,
    "extension-event-signature",
  );
  next = replaceOnce(
    next,
    `        else if (event.type === "agent_end") {
            await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
        }`,
    `        else if (event.type === "agent_end") {
            const extensionEvent = this._abortProvenance.beginAgentEnd(event.messages, agentEndWillRetry);
            try {
                await this._extensionRunner.emit(extensionEvent);
            }
            finally {
                this._abortProvenance.endAgentEnd(extensionEvent);
            }
            return extensionEvent;
        }`,
    "extension-agent-end",
  );
  next = replaceOnce(
    next,
    `    async _handlePostAgentRun() {
        const msg = this._lastAssistantMessage;
        this._lastAssistantMessage = undefined;
        if (!msg) {
            return false;
        }
        if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
            return true;
        }
        if (msg.stopReason === "error" && this._retryAttempt > 0) {
            this._emit({
                type: "auto_retry_end",
                success: false,
                attempt: this._retryAttempt,
                finalError: msg.errorMessage,
            });
            this._retryAttempt = 0;
        }
        if (await this._checkCompaction(msg)) {
            return true;
        }
        // The agent loop drains both queues before emitting agent_end. Any messages
        // here were queued by agent_end extension handlers and need a continuation.
        return this.agent.hasQueuedMessages();
    }`,
    `    async _handlePostAgentRun() {
        const msg = this._lastAssistantMessage;
        this._lastAssistantMessage = undefined;
        if (!msg || this._abortProvenance.takeStopContinuation()) {
            return false;
        }
        if (this._isRetryableError(msg)) {
            const retryPrepared = await this._prepareRetry(msg);
            if (this._abortProvenance.takeStopContinuation()) {
                return false;
            }
            if (retryPrepared) {
                return true;
            }
        }
        if (msg.stopReason === "error" && this._retryAttempt > 0) {
            this._emit({
                type: "auto_retry_end",
                success: false,
                attempt: this._retryAttempt,
                finalError: msg.errorMessage,
            });
            this._retryAttempt = 0;
        }
        const compacted = await this._checkCompaction(msg);
        if (this._abortProvenance.takeStopContinuation()) {
            return false;
        }
        if (compacted) {
            return true;
        }
        // The agent loop drains both queues before emitting agent_end. Any messages
        // here were queued by agent_end extension handlers and need a continuation.
        return this.agent.hasQueuedMessages();
    }`,
    "post-run-stop",
  );
  next = replaceOnce(
    next,
    `    clearQueue() {
        const steering = [...this._steeringMessages];
        const followUp = [...this._followUpMessages];`,
    `    clearQueue(options) {
        const steering = [...this._steeringMessages];
        const followUp = [...this._followUpMessages];
        this._abortProvenance.noteClearedQueue(steering.length > 0 || followUp.length > 0, options?.abortWillFollow === true);`,
    "queue-gap-marker",
  );
  next = replaceOnce(
    next,
    `    /**
     * Abort current operation and wait for agent to become idle.
     */
    async abort() {
        this.abortRetry();
        this.abortCompaction();
        this.abortBranchSummary();
        this.agent.abort();
        await this.waitForIdle();
    }`,
    `    async _emitSessionAbort() {
        const event = { type: "session_abort" };
        await this._extensionRunner.emit(event);
        this._emit(event);
    }
    /**
     * Abort current operation and wait for agent to become idle.
     */
    async abort(source = "user") {
        const decision = this._abortProvenance.beginAbort(source, {
            agentActive: this.agent.state.isStreaming,
            sessionRunActive: this._isAgentRunActive,
            retrying: this._retryAbortController !== undefined,
            compacting: this.isCompacting,
            pendingMessages: this.pendingMessageCount > 0,
        });
        this.abortRetry();
        this.abortCompaction();
        this.abortBranchSummary();
        if (decision.abortCurrentAgent) {
            this.agent.abort();
        }
        await this.waitForIdle();
        if (decision.emitSessionAbort) {
            try {
                await this._emitSessionAbort();
            }
            finally {
                this._abortProvenance.finishGapAbort();
            }
        }
    }`,
    "abort-entry",
  );
  next = replaceOnce(
    next,
    `    async compact(customInstructions) {
        await this.abort();
        this._compactionAbortController = new AbortController();`,
    `    async compact(customInstructions) {
        await this.abort("system");
        this._compactionAbortController = new AbortController();`,
    "manual-compact-source",
  );
  return next;
}

function patchAgentSessionTypes(source) {
  unpatched(source, 'type: "session_abort";', "agent-session-types");
  let next = replaceOnce(
    source,
    `    type: "agent_end";
    messages: AgentMessage[];
    willRetry: boolean;
} | {
    type: "agent_settled";
} | {`,
    `    type: "agent_end";
    messages: AgentMessage[];
    willRetry: boolean;
    aborted?: boolean;
    abortSource?: "user" | "system" | "provider";
} | {
    type: "agent_settled";
} | {
    type: "session_abort";
} | {`,
    "session-event-types",
  );
  next = replaceOnce(
    next,
    `    clearQueue(): {
        steering: string[];
        followUp: string[];
    };`,
    `    clearQueue(options?: {
        abortWillFollow: boolean;
    }): {
        steering: string[];
        followUp: string[];
    };`,
    "clear-queue-options",
  );
  next = replaceOnce(
    next,
    `    /**
     * Abort current operation and wait for agent to become idle.
     */
    abort(): Promise<void>;`,
    `    private _emitSessionAbort;
    /**
     * Abort current operation and wait for agent to become idle.
     */
    abort(): Promise<void>;`,
    "session-abort-method",
  );
  return next;
}

function patchExtensionTypes(source) {
  unpatched(source, "export interface SessionAbortEvent", "extension-types");
  let next = replaceOnce(
    source,
    `export interface SessionShutdownEvent {
    type: "session_shutdown";
    reason: "quit" | "reload" | "new" | "resume" | "fork";
    /** Destination session file when shutting down due to session replacement. */
    targetSessionFile?: string;
}
/** Preparation data for tree navigation */`,
    `export interface SessionShutdownEvent {
    type: "session_shutdown";
    reason: "quit" | "reload" | "new" | "resume" | "fork";
    /** Destination session file when shutting down due to session replacement. */
    targetSessionFile?: string;
}
/** Fired when a user aborts retry, compaction, or queued work outside an agent_end boundary. */
export interface SessionAbortEvent {
    type: "session_abort";
}
/** Preparation data for tree navigation */`,
    "types-session-abort-event",
  );
  next = replaceOnce(
    next,
    "| SessionCompactFailedEvent | SessionShutdownEvent | SessionBeforeTreeEvent | SessionTreeEvent;",
    "| SessionCompactFailedEvent | SessionShutdownEvent | SessionAbortEvent | SessionBeforeTreeEvent | SessionTreeEvent;",
    "types-session-union",
  );
  next = replaceOnce(
    next,
    `export interface AgentEndEvent {
    type: "agent_end";
    messages: AgentMessage[];
}`,
    `export interface AgentEndEvent {
    type: "agent_end";
    messages: AgentMessage[];
    /** True when this run ended through an abort rather than normal completion. */
    aborted?: boolean;
    /** Whether the session will automatically retry after this boundary. */
    willRetry?: boolean;
    abortSource?: "user" | "system" | "provider";
}`,
    "types-agent-end",
  );
  next = replaceOnce(
    next,
    `    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
    on(event: "session_before_tree"`,
    `    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
    on(event: "session_abort", handler: ExtensionHandler<SessionAbortEvent>): void;
    on(event: "session_before_tree"`,
    "types-api-overload",
  );
  return next;
}

function patchExtensionIndexTypes(source) {
  unpatched(source, "SessionAbortEvent", "extension-index-types");
  return replaceOnce(
    source,
    "SessionInfoChangedEvent, SessionShutdownEvent, SessionStartEvent",
    "SessionInfoChangedEvent, SessionAbortEvent, SessionShutdownEvent, SessionStartEvent",
    "extension-index-export",
  );
}

function patchPublicIndexTypes(source) {
  unpatched(source, "SessionAbortEvent", "public-index-types");
  return replaceOnce(
    source,
    "SessionInfoChangedEvent, SessionShutdownEvent, SessionStartEvent",
    "SessionInfoChangedEvent, SessionAbortEvent, SessionShutdownEvent, SessionStartEvent",
    "public-index-export",
  );
}

export const files = Object.freeze([
  Object.freeze({
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path: "dist/rubato-features/abort-provenance/state.mjs",
    sourcePath: fileURLToPath(new URL("./state.mjs", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("dist/core/agent-session.js", "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "db3bfd2ae08eda4936d8807656f06120e6e62672d6a7798bccba486a0dc994ea", patchAgentSessionTypes),
  patch("dist/core/extensions/types.d.ts", "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a", patchExtensionTypes),
  patch("dist/core/extensions/index.d.ts", "dc9bd3202b8d84b580d7002efad6738465c50556e2b27624193a6505b453c87d", patchExtensionIndexTypes),
  patch("dist/index.d.ts", "f1cb93477c7357d08b839c0663d079b8f9bb949079ed7b50a71f8d2945cece90", patchPublicIndexTypes),
]);
