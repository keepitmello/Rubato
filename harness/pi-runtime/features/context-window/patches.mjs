const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[context-window:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[context-window:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function unpatched(source, marker, label) {
  if (source.includes(marker)) {
    throw new Error(`[context-window:${label}] expected pristine feature seam`);
  }
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `context-window:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

function patchAgentSessionRuntime(source) {
  const importLine = 'import { assertTransitionCommit, notesTurnMessages } from "../rubato-features/context-notes/src/context-notes/engine-gate.mjs";';
  unpatched(source, importLine, "agent-session-runtime");
  let next = replaceOnce(
    source,
    'import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";',
    `import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";\n${importLine}`,
    "session-import",
  );
  next = replaceOnce(
    next,
    `    _resolveIdleWait;
    /** Tracks pending steering messages for UI display. Removed when delivered. */`,
    `    _resolveIdleWait;
    _messageRevision = 0;
    _messageRevisionLeaf;
    _messageRevisionLength = -1;
    _messageRevisionTail;
    /** Tracks pending steering messages for UI display. Removed when delivered. */`,
    "revision-state",
  );
  next = replaceOnce(
    next,
    `    _resolveIdleWaitIfIdle() {
        if (!this.isIdle || !this._resolveIdleWait) {
            return;
        }
        const resolve = this._resolveIdleWait;
        this._idleWaitPromise = undefined;
        this._resolveIdleWait = undefined;
        resolve();
    }
    async _emitAgentSettled() {`,
    `    _resolveIdleWaitIfIdle() {
        if (!this.isIdle || !this._resolveIdleWait) {
            return;
        }
        const resolve = this._resolveIdleWait;
        this._idleWaitPromise = undefined;
        this._resolveIdleWait = undefined;
        resolve();
    }
    /**
     * Return a monotonic token for the current persisted leaf and live message tail.
     * The lazy observation also catches direct SessionManager writes by extensions.
     */
    getMessageRevision() {
        const messages = this.agent.state.messages;
        const leaf = this.sessionManager.getLeafId();
        const length = messages.length;
        const tail = messages[length - 1];
        if (leaf !== this._messageRevisionLeaf ||
            length !== this._messageRevisionLength ||
            tail !== this._messageRevisionTail) {
            this._messageRevision++;
            this._messageRevisionLeaf = leaf;
            this._messageRevisionLength = length;
            this._messageRevisionTail = tail;
        }
        return this._messageRevision;
    }
    async _emitAgentSettled() {`,
    "revision-api",
  );
  next = replaceOnce(
    next,
    `            const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
            const nextContext = previousSnapshot?.context ?? context;
            return {
                ...previousSnapshot,
                context: {
                    ...nextContext,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,`,
    `            const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
            const nextContext = previousSnapshot?.context ?? context;
            const liveWindowMessages = notesTurnMessages(turn, this.agent.state.messages, this.sessionManager.getSessionId());
            return {
                ...previousSnapshot,
                context: {
                    ...nextContext,
                    messages: liveWindowMessages ?? nextContext.messages,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,`,
    "next-turn-live-window",
  );
  next = replaceOnce(
    next,
    `    /** Generate Pi's built-in compaction summary for manual and automatic compaction. */
    async _runDefaultCompaction(preparation, requestModel, apiKey, headers, customInstructions, signal, env, reason) {`,
    `    /**
     * Commit a controller-prepared context window without a summarizer/provider call.
     * No callback or await occurs between the final revision/leaf check and the
     * persisted append plus live-state replacement.
     */
    async applyCompaction(precomputed, options = { reason: "extension" }) {
        const reason = options.reason ?? "extension";
        const signal = options.signal;
        const expectedRevision = options.expectedRevision;
        const isStale = () => signal?.aborted === true ||
            (expectedRevision !== undefined && expectedRevision !== this.getMessageRevision());
        if (isStale()) {
            return { applied: false, reason: "stale" };
        }
        if (this.isCompacting) {
            return { applied: false, reason: "rejected" };
        }
        try {
            assertTransitionCommit({ precomputed, controller: signal ? { signal } : undefined }, this.sessionManager);
        }
        catch {
            return { applied: false, reason: signal?.aborted ? "stale" : "rejected" };
        }
        const controller = new AbortController();
        const abortController = () => controller.abort();
        signal?.addEventListener("abort", abortController, { once: true });
        this._compactionAbortController = controller;
        let committed = false;
        let started = false;
        try {
            if (isStale() || controller.signal.aborted) {
                return { applied: false, reason: "stale" };
            }
            try {
                assertTransitionCommit({ precomputed, controller }, this.sessionManager);
            }
            catch {
                return { applied: false, reason: controller.signal.aborted ? "stale" : "rejected" };
            }
            const compactionEntryId = this.sessionManager.appendCompaction(
                precomputed.summary,
                precomputed.firstKeptEntryId,
                precomputed.tokensBefore,
                precomputed.details,
                true,
                precomputed.usage,
            );
            committed = true;
            const compactionEntry = this.sessionManager.getEntry(compactionEntryId);
            if (compactionEntry?.type !== "compaction") {
                throw new Error("Compaction entry was not saved");
            }
            const sessionContext = this.sessionManager.buildSessionContext();
            this.agent.state.messages = sessionContext.messages;
            precomputed.estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);
            this.getMessageRevision();
            // A precomputed window has no generation phase. Publish start only
            // after its atomic commit so synchronous listeners cannot mutate the
            // checked source between validation and persistence.
            this._emit({ type: "compaction_start", reason });
            started = true;
            await this._extensionRunner.emit({
                type: "session_compact",
                compactionEntry,
                fromExtension: true,
                reason,
                willRetry: false,
            });
            this._emit({ type: "compaction_end", reason, result: precomputed, aborted: false, willRetry: false });
            return { applied: true, reason: "ok" };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (committed && !started) this._emit({ type: "compaction_start", reason });
            this._emit({
                type: "compaction_end",
                reason,
                result: undefined,
                aborted: controller.signal.aborted,
                willRetry: false,
                errorMessage: controller.signal.aborted ? undefined : "Compaction failed: " + errorMessage,
            });
            await this._emitSessionCompactFailed({
                reason,
                errorMessage: controller.signal.aborted ? undefined : "Compaction failed: " + errorMessage,
                aborted: controller.signal.aborted,
                willRetry: false,
                fromExtension: true,
            });
            if (committed) throw error;
            return { applied: false, reason: "rejected" };
        }
        finally {
            signal?.removeEventListener("abort", abortController);
            if (this._compactionAbortController === controller) this._compactionAbortController = undefined;
            this._resolveIdleWaitIfIdle();
        }
    }
    /** Generate Pi's built-in compaction summary for manual and automatic compaction. */
    async _runDefaultCompaction(preparation, requestModel, apiKey, headers, customInstructions, signal, env, reason) {`,
    "atomic-apply",
  );
  next = replaceOnce(
    next,
    `            getContextUsage: () => this.getContextUsage(),
            compact: (options) => {`,
    `            getContextUsage: () => this.getContextUsage(),
            getMessageRevision: () => this.getMessageRevision(),
            applyCompaction: (precomputed, options) => this.applyCompaction(precomputed, options),
            compact: (options) => {`,
    "extension-bindings",
  );
  return next;
}

function patchAgentSessionTypes(source) {
  let next = replaceOnce(
    source,
    `    type: "compaction_start";
    reason: "manual" | "threshold" | "overflow";`,
    `    type: "compaction_start";
    reason: "manual" | "threshold" | "overflow" | "extension";`,
    "compaction-start-reason",
  );
  next = replaceOnce(
    next,
    `    type: "compaction_end";
    reason: "manual" | "threshold" | "overflow";`,
    `    type: "compaction_end";
    reason: "manual" | "threshold" | "overflow" | "extension";`,
    "compaction-end-reason",
  );
  next = replaceOnce(
    next,
    `    private _resolveIdleWait;
    /** Tracks pending steering messages for UI display. Removed when delivered. */`,
    `    private _resolveIdleWait;
    private _messageRevision;
    private _messageRevisionLeaf;
    private _messageRevisionLength;
    private _messageRevisionTail;
    /** Tracks pending steering messages for UI display. Removed when delivered. */`,
    "revision-fields",
  );
  next = replaceOnce(
    next,
    `    private _resolveIdleWaitIfIdle;
    private _emitAgentSettled;`,
    `    private _resolveIdleWaitIfIdle;
    getMessageRevision(): number;
    private _emitAgentSettled;`,
    "revision-method",
  );
  next = replaceOnce(
    next,
    `    private _runDefaultCompaction;
    private _clearManualCompactionState;`,
    `    applyCompaction(precomputed: CompactionResult, options: {
        reason: "extension";
        expectedRevision?: number;
        signal?: AbortSignal;
    }): Promise<{
        applied: true;
        reason: "ok";
    } | {
        applied: false;
        reason: "stale" | "rejected";
    }>;
    private _runDefaultCompaction;
    private _clearManualCompactionState;`,
    "apply-method",
  );
  return next;
}

function patchMessagesRuntime(source) {
  const marker = 'import { notesAwareSummaryMessage } from "../rubato-features/context-notes/src/context-notes/engine-gate.mjs";';
  unpatched(source, marker, "messages-runtime");
  let next = `${marker}\n${source}`;
  next = replaceOnce(
    next,
    `export function createCompactionSummaryMessage(summary, tokensBefore, timestamp) {
    return {`,
    `export function createCompactionSummaryMessage(summary, tokensBefore, timestamp) {
    const windowMessage = notesAwareSummaryMessage(summary, timestamp);
    if (windowMessage) return windowMessage;
    return {`,
    "window-carrier",
  );
  return next;
}

function patchMessagesTypes(source) {
  let next = replaceOnce(
    source,
    `import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";`,
    `import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";`,
    "user-message-import",
  );
  next = replaceOnce(
    next,
    `export declare function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string): CompactionSummaryMessage;`,
    `export declare function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string): CompactionSummaryMessage | UserMessage;`,
    "window-carrier-return",
  );
  return next;
}

function patchSdkRuntime(source) {
  const marker = 'import { assertSessionReady } from "../rubato-features/context-notes/src/context-notes/engine-gate.mjs";';
  unpatched(source, marker, "sdk-runtime");
  let next = replaceOnce(
    source,
    'import { AgentSession } from "./agent-session.js";',
    `import { AgentSession } from "./agent-session.js";\n${marker}`,
    "sdk-admission-import",
  );
  next = replaceOnce(
    next,
    `        transformContext: async (messages) => {
            const runner = extensionRunnerRef.current;
            if (!runner)
                return messages;
            return runner.emitContext(messages);
        },`,
    `        transformContext: async (messages) => {
            const runner = extensionRunnerRef.current;
            const transformed = runner ? await runner.emitContext(messages) : messages;
            // emitContext reports extension failures and continues. The history-notes
            // owner must still fail closed immediately before the provider call.
            assertSessionReady(sessionManager, transformed, { abort: () => agent.abort() });
            return transformed;
        },`,
    "provider-admission",
  );
  return next;
}

function patchSettingsRuntime(source) {
  const marker = 'import { installSettingsGate } from "../rubato-features/context-notes/src/context-notes/engine-gate.mjs";';
  unpatched(source, marker, "settings-runtime");
  return `${marker}\n${source}\ninstallSettingsGate(SettingsManager);\n`;
}

function patchExtensionTypes(source) {
  let next = replaceOnce(
    source,
    `export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: CompactionResult) => void;
    onError?: (error: Error) => void;
}
/**
 * Context passed to extension event handlers.`,
    `export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: CompactionResult) => void;
    onError?: (error: Error) => void;
}
export interface ApplyCompactionOptions {
    reason: "extension";
    expectedRevision?: number;
    signal?: AbortSignal;
}
export type ApplyCompactionResult = {
    applied: true;
    reason: "ok";
} | {
    applied: false;
    reason: "stale" | "rejected";
};
/**
 * Context passed to extension event handlers.`,
    "apply-types",
  );
  next = replaceOnce(
    next,
    `    /** Trigger compaction without awaiting completion. */
    compact(options?: CompactOptions): void;
    /** Get the current effective system prompt. */`,
    `    /** Trigger compaction without awaiting completion. */
    compact(options?: CompactOptions): void;
    /** Current revision of the persisted leaf and live message tail. */
    getMessageRevision(): number;
    /** Atomically apply a controller-prepared context window at a matching revision. */
    applyCompaction(precomputed: CompactionResult, options: ApplyCompactionOptions): Promise<ApplyCompactionResult>;
    /** Get the current effective system prompt. */`,
    "context-api",
  );
  next = replaceOnce(
    next,
    `    getContextUsage: () => ContextUsage | undefined;
    compact: (options?: CompactOptions) => void;
    getSystemPrompt: () => string;`,
    `    getContextUsage: () => ContextUsage | undefined;
    compact: (options?: CompactOptions) => void;
    getMessageRevision: () => number;
    applyCompaction: (precomputed: CompactionResult, options: ApplyCompactionOptions) => Promise<ApplyCompactionResult>;
    getSystemPrompt: () => string;`,
    "context-actions",
  );
  next = next.replaceAll(
    `reason: "manual" | "threshold" | "overflow";`,
    `reason: "manual" | "threshold" | "overflow" | "extension";`,
  );
  return next;
}

function patchRunnerRuntime(source) {
  let next = replaceOnce(
    source,
    `    compactFn = () => { };
    getSystemPromptFn = () => "";`,
    `    compactFn = () => { };
    getMessageRevisionFn = () => 0;
    applyCompactionFn = async () => ({ applied: false, reason: "rejected" });
    getSystemPromptFn = () => "";`,
    "runner-fields",
  );
  next = replaceOnce(
    next,
    `        this.compactFn = contextActions.compact;
        this.getSystemPromptFn = contextActions.getSystemPrompt;`,
    `        this.compactFn = contextActions.compact;
        this.getMessageRevisionFn = contextActions.getMessageRevision;
        this.applyCompactionFn = contextActions.applyCompaction;
        this.getSystemPromptFn = contextActions.getSystemPrompt;`,
    "runner-bind",
  );
  next = replaceOnce(
    next,
    `            compact: (options) => {
                runner.assertActive();
                runner.compactFn(options);
            },
            getSystemPrompt: () => {`,
    `            compact: (options) => {
                runner.assertActive();
                runner.compactFn(options);
            },
            getMessageRevision: () => {
                runner.assertActive();
                return runner.getMessageRevisionFn();
            },
            applyCompaction: (precomputed, options) => {
                runner.assertActive();
                return runner.applyCompactionFn(precomputed, options);
            },
            getSystemPrompt: () => {`,
    "runner-context",
  );
  return next;
}

function patchRunnerTypes(source) {
  return replaceOnce(
    source,
    `    private compactFn;
    private getSystemPromptFn;`,
    `    private compactFn;
    private getMessageRevisionFn;
    private applyCompactionFn;
    private getSystemPromptFn;`,
    "runner-fields",
  );
}

function patchExtensionIndexTypes(source) {
  return replaceOnce(
    source,
    `AgentStartEvent, AgentToolResult`,
    `AgentStartEvent, AgentToolResult, ApplyCompactionOptions, ApplyCompactionResult`,
    "extension-index-exports",
  );
}

function patchPublicIndexTypes(source) {
  return replaceOnce(
    source,
    `AgentStartEvent, AgentToolResult`,
    `AgentStartEvent, AgentToolResult, ApplyCompactionOptions, ApplyCompactionResult`,
    "public-index-exports",
  );
}

export const files = Object.freeze([]);

export const patches = Object.freeze([
  patch("dist/core/agent-session.js", "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "db3bfd2ae08eda4936d8807656f06120e6e62672d6a7798bccba486a0dc994ea", patchAgentSessionTypes),
  patch("dist/core/messages.js", "a4e4865e343bf87f8078f75ff179a2a77cd7c2700cf8473476bd4dc5ed36adb6", patchMessagesRuntime),
  patch("dist/core/messages.d.ts", "fdd51b8371984b68f2631f9f64f1259ac77f2d5153068ce75d6158bca27e7a66", patchMessagesTypes),
  patch("dist/core/sdk.js", "6969bd56ba8e1628cd033bb15cb15fe38299f00b5ad84f4f8ef37a33a98681c9", patchSdkRuntime),
  patch("dist/core/settings-manager.js", "ee4f52d1dd4f1c18d5d814be4ba260ddf7fe40b7b70c2f0732a30a8b287111ad", patchSettingsRuntime),
  patch("dist/core/extensions/types.d.ts", "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a", patchExtensionTypes),
  patch("dist/core/extensions/runner.js", "0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61", patchRunnerRuntime),
  patch("dist/core/extensions/runner.d.ts", "5e6f5e8e5dffccc0f7e235964a75ac181d2c6e06b924e149370ad688a31d7193", patchRunnerTypes),
  patch("dist/core/extensions/index.d.ts", "dc9bd3202b8d84b580d7002efad6738465c50556e2b27624193a6505b453c87d", patchExtensionIndexTypes),
  patch("dist/index.d.ts", "f1cb93477c7357d08b839c0663d079b8f9bb949079ed7b50a71f8d2945cece90", patchPublicIndexTypes),
]);

export const feature = Object.freeze({ id: "context-window", patches, files });
