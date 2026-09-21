import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.86.1";

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
  // 0.86 renders the system prompt from `systemPromptOptions` instead of passing a
  // `context.systemPrompt` override here, so the old anchor's tail is gone. The intent is
  // unchanged: swap the provider context's messages for the live history-notes window.
  next = replaceOnce(
    next,
    `            const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
            const nextContext = previousSnapshot?.context ?? context;`,
    `            const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
            const nextContext = previousSnapshot?.context ?? context;
            const liveWindowMessages = notesTurnMessages(turn, this.agent.state.messages, this.sessionManager.getSessionId());`,
    "next-turn-live-window",
  );
  next = replaceOnce(
    next,
    `            return {
                ...previousSnapshot,
                context: {
                    ...nextContext,
                    tools: this.agent.state.tools.slice(),
                },`,
    `            return {
                ...previousSnapshot,
                context: {
                    ...nextContext,
                    messages: liveWindowMessages ?? nextContext.messages,
                    tools: this.agent.state.tools.slice(),
                },`,
    "next-turn-live-window-apply",
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
  next = replaceOnce(
    next,
    `    _expandSkillCommand(text) {
        if (!text.startsWith("/skill:"))
            return text;`,
    `    _expandSkillCommand(text) {
        const expandOne = (raw) => {
            const spaceIndex = raw.indexOf(" ");
            const skillName = spaceIndex === -1 ? raw.slice(7) : raw.slice(7, spaceIndex);
            const args = spaceIndex === -1 ? "" : raw.slice(spaceIndex + 1).trim();
            const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
            if (!skill)
                return raw;
            try {
                const content = readFileSync(skill.filePath, "utf-8");
                const body = stripFrontmatter(content).trim();
                const skillBlock = \`<skill name="\${skill.name}" location="\${skill.filePath}">\\nReferences are relative to \${skill.baseDir}.\\n\\n\${body}\\n</skill>\`;
                return args ? \`\${skillBlock}\\n\\n\${args}\` : skillBlock;
            }
            catch (err) {
                this._extensionRunner.emitError({
                    extensionPath: skill.filePath,
                    event: "skill_expansion",
                    error: err instanceof Error ? err.message : String(err),
                });
                return raw;
            }
        };
        if (text.startsWith("/skill:") || text.startsWith("\$skill:"))
            return expandOne(text.startsWith("\$skill:") ? \`/skill:\${text.slice(7)}\` : text);
        return text.replace(/(^|\\s)([$/])skill:([a-zA-Z][a-zA-Z0-9:_-]*)(?=\\s|$)/g, (whole, lead, sigil, name) => {
            const expanded = expandOne(\`/skill:\${name}\`);
            return expanded === \`/skill:\${name}\` ? whole : \`\${lead}\${expanded}\`;
        });`,
    "inline-skill",
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
  const remapImport = 'import { remapHiddenCustomTurns } from "../rubato-features/context-window/remap-hidden-custom-turns.mjs";';
  unpatched(source, marker, "messages-runtime");
  unpatched(source, remapImport, "messages-remap");
  unpatched(source, "remapHiddenCustomTurns(messages", "messages-convertToLlm");
  let next = `${marker}\n${remapImport}\n${source}`;
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
  next = replaceOnce(
    next,
    `export function convertToLlm(messages) {
    return messages
        .map((m) => {`,
    `export function convertToLlm(messages) {
    return remapHiddenCustomTurns(messages, (m) => {`,
    "convertToLlm-remap",
  );
  next = replaceOnce(
    next,
    `    })
        .filter((m) => m !== undefined);
}`,
    `    });
}`,
    "convertToLlm-remap-close",
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

const ownedFile = (path, sourcePath) => Object.freeze({
  target: "package",
  packageName: PACKAGE_NAME,
  version: PACKAGE_VERSION,
  path,
  sourcePath,
});

export const files = Object.freeze([
  ownedFile(
    "dist/rubato-features/context-window/remap-hidden-custom-turns.mjs",
    fileURLToPath(new URL("./remap-hidden-custom-turns.mjs", import.meta.url)),
  ),
]);

export const patches = Object.freeze([
  patch("dist/core/agent-session.js", "edaff7055ced7d49d25135c92415fbbfd9c14c4a29be5a79510ab9216045d6d9", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "423bdca09eabd78aa1e729136dd9a1e2fff3b8116c6bc2d3fee3337b269a8432", patchAgentSessionTypes),
  patch("dist/core/messages.js", "8688b3f6eb28865f779cac998bd4754d1a4f08703200dfe0dd5a799aa0d42ef6", patchMessagesRuntime),
  patch("dist/core/messages.d.ts", "fdd51b8371984b68f2631f9f64f1259ac77f2d5153068ce75d6158bca27e7a66", patchMessagesTypes),
  patch("dist/core/sdk.js", "3417c58edc5c02a4ae71a3604bbd04688d1741e0203497bf082a748ca843d850", patchSdkRuntime),
  patch("dist/core/settings-manager.js", "5368b155ec26d88374cec9e66b8e588b5041a0fb0047414f70b34e13892c4f48", patchSettingsRuntime),
  patch("dist/core/extensions/types.d.ts", "a4d5b8774fa8015b8a3274614f1398a6aeeffdd888c122910439666955dc2a52", patchExtensionTypes),
  patch("dist/core/extensions/runner.js", "07a94efe560e6a460a415b2188c1c3c69ca151bd163c9b5f05347caf8403ace2", patchRunnerRuntime),
  patch("dist/core/extensions/runner.d.ts", "fc0f81468c51bacfc093ac09974aa8e8053ca463e205eb66a1c63b0b655f61b9", patchRunnerTypes),
  patch("dist/core/extensions/index.d.ts", "5b294bd70da0744cb18a45d1cfb774237986c047ec1996e03f24a9605efdd4ab", patchExtensionIndexTypes),
  patch("dist/index.d.ts", "44bf19d2716cb18382aa6bd0ae88b7e03ee50ae75b56acb6d11beb40dfe99dea", patchPublicIndexTypes),
]);

export const feature = Object.freeze({ id: "context-window", patches, files });
