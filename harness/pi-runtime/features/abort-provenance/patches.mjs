import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as PACKAGE_VERSION } from "../../pi-version.mjs";
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
`,
    `    _retryAbortController = undefined;
    _retryAttempt = 0;
    _abortProvenance = new AbortProvenance();
`,
    "session-state",
  );
  next = replaceOnce(
    next,
    `        // Emit to extensions first, then notify public listeners.
        await this._emitExtensionEvent(event);
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
  // 0.86 added its own `_agentRunAbortRequested` guard at the same decision points. The
  // patch keeps upstream's guards verbatim and interleaves ours: `takeStopContinuation()`
  // is also armed by a provider-aborted agent_end, which no `abort()` call covers.
  next = replaceOnce(
    next,
    `    async _handlePostAgentRun() {
        const message = this._lastAssistantMessage;
        const toolResults = this._lastAssistantToolResults;
        this._lastAssistantMessage = undefined;
        this._lastAssistantToolResults = [];
        if (this._agentRunAbortRequested) {
            this._finishCancelledRetry();
            return false;
        }
        if (!message)
            return this.agent.hasQueuedMessages();
        if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
            if (this._agentRunAbortRequested)
                this._finishCancelledRetry();
            this._failedResponse = message;
            return !this._agentRunAbortRequested;
        }
        if (this._agentRunAbortRequested) {
            this._finishCancelledRetry();
            return false;
        }
        if (message.stopReason === "error" && this._retryAttempt > 0) {
            this._emit({
                type: "auto_retry_end",
                success: false,
                attempt: this._retryAttempt,
                finalError: message.errorMessage,
            });
            this._retryAttempt = 0;
        }
        if (await this._checkCompaction(message, true, toolResults)) {
            return !this._agentRunAbortRequested;
        }
        // The low-level loop drains both queues before agent_end. Messages queued by
        // agent_end handlers require a fresh run before pre-settlement handlers fire.
        return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
    }`,
    `    async _handlePostAgentRun() {
        const message = this._lastAssistantMessage;
        const toolResults = this._lastAssistantToolResults;
        this._lastAssistantMessage = undefined;
        this._lastAssistantToolResults = [];
        // The flag belongs to this post-run decision. Consume it up front so the early
        // returns below cannot leak it into the next run, then re-check it after every
        // await where a fresh abort can land.
        const stopContinuation = this._abortProvenance.takeStopContinuation();
        if (this._agentRunAbortRequested) {
            this._finishCancelledRetry();
            return false;
        }
        if (stopContinuation) {
            return false;
        }
        if (!message)
            return this.agent.hasQueuedMessages();
        if (this._isRetryableError(message)) {
            const retryPrepared = await this._prepareRetry(message);
            if (this._abortProvenance.takeStopContinuation()) {
                return false;
            }
            if (this._agentRunAbortRequested) {
                this._finishCancelledRetry();
                return false;
            }
            if (retryPrepared) {
                this._failedResponse = message;
                return true;
            }
        }
        if (this._agentRunAbortRequested) {
            this._finishCancelledRetry();
            return false;
        }
        if (message.stopReason === "error" && this._retryAttempt > 0) {
            this._emit({
                type: "auto_retry_end",
                success: false,
                attempt: this._retryAttempt,
                finalError: message.errorMessage,
            });
            this._retryAttempt = 0;
        }
        const compacted = await this._checkCompaction(message, true, toolResults);
        if (this._abortProvenance.takeStopContinuation()) {
            return false;
        }
        if (compacted) {
            return !this._agentRunAbortRequested;
        }
        // The low-level loop drains both queues before agent_end. Messages queued by
        // agent_end handlers require a fresh run before pre-settlement handlers fire.
        return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
    }`,
    "post-run-stop",
  );
  // 1.0 skips _handlePostAgentRun entirely once \`_agentRunAbortRequested\` is set, so a
  // stop armed by an abort that joined this run's agent_end boundary was never consumed and
  // silently cancelled the next run's first retry. The flag only governs this run.
  next = replaceOnce(
    next,
    `        finally {
            if (this._agentRunAbortRequested)
                this._finishCancelledRetry();
            this._failedResponse = undefined;`,
    `        finally {
            this._abortProvenance.takeStopContinuation();
            if (this._agentRunAbortRequested)
                this._finishCancelledRetry();
            this._failedResponse = undefined;`,
    "run-scoped-stop",
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
        if (this._isAgentRunActive) {
            this._agentRunAbortRequested = true;
        }
        this.abortRetry();
        this.abortCompaction();
        this.abortBranchSummary();
        if (this._isBeforeSettle)
            this._abortDuringBeforeSettle = true;
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
        // 0.86 owns this flag; a system abort must arm it the same way a user abort does.
        if (this._isAgentRunActive) {
            this._agentRunAbortRequested = true;
        }
        this.abortRetry();
        if (this.isCompacting) {
            this.abortCompaction();
        }
        this.abortBranchSummary();
        // 1.0: an abort during the agent_before_settle boundary must stop its continuation
        // whether or not an agent request is still streaming.
        if (this._isBeforeSettle)
            this._abortDuringBeforeSettle = true;
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
    `    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
`,
    `    on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
    on(event: "session_abort", handler: ExtensionHandler<SessionAbortEvent>): () => void;
`,
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
  patch("dist/core/agent-session.js", "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "2e50b35a37f9c7149c6297ae554b2d965bd74dbfcb8ccd7be44f13226ce497e7", patchAgentSessionTypes),
  patch("dist/core/extensions/types.d.ts", "abd9e9be0bf21b4c35621fe90b79af75c85b774e8b254b515d699785fda5962a", patchExtensionTypes),
  patch("dist/core/extensions/index.d.ts", "fe5661c6cd9a948293f0f1d1db5a052dcc60493f6b1f68349a7ab96987b10e40", patchExtensionIndexTypes),
  patch("dist/index.d.ts", "b254e36846b1dcc64ce1a8ba72e23fb410df4aa4408ba8c23e69e5b3f934e3cc", patchPublicIndexTypes),
]);
