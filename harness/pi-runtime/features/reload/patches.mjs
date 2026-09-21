const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.86.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[reload:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[reload:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `reload-veto:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

function patchExtensionTypes(source) {
  let next = replaceOnce(
    source,
    `export interface SessionBeforeForkEvent {
    type: "session_before_fork";
    entryId: string;
    position: "before" | "at";
}
/** Fired before context compaction (can be cancelled or customized) */`,
    `export interface SessionBeforeForkEvent {
    type: "session_before_fork";
    entryId: string;
    position: "before" | "at";
}
/** Fired before a full session reload tears down the current extension runtime. */
export interface SessionBeforeReloadEvent {
    type: "session_before_reload";
}
/** Fired before context compaction (can be cancelled or customized) */`,
    "types-event",
  );
  next = replaceOnce(
    next,
    "export type SessionEvent = SessionStartEvent | SessionInfoChangedEvent | SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionBeforeCompactEvent | SessionCompactEvent | SessionCompactFailedEvent | SessionShutdownEvent | SessionBeforeTreeEvent | SessionTreeEvent;",
    "export type SessionEvent = SessionStartEvent | SessionInfoChangedEvent | SessionBeforeSwitchEvent | SessionBeforeForkEvent | SessionBeforeReloadEvent | SessionBeforeCompactEvent | SessionCompactEvent | SessionCompactFailedEvent | SessionShutdownEvent | SessionBeforeTreeEvent | SessionTreeEvent;",
    "types-session-union",
  );
  next = replaceOnce(
    next,
    `export interface SessionBeforeForkResult {
    cancel?: boolean;
    skipConversationRestore?: boolean;
}
export interface SessionBeforeCompactResult {`,
    `export interface SessionBeforeForkResult {
    cancel?: boolean;
    skipConversationRestore?: boolean;
}
export interface SessionBeforeReloadResult {
    cancel?: boolean;
    /** Short actionable reason a host can show when reload is blocked. */
    reason?: string;
}
export interface ReloadVetoDecision {
    cancelled: boolean;
    reason?: string;
}
export interface SessionBeforeCompactResult {`,
    "types-result",
  );
  next = replaceOnce(
    next,
    `    on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): () => void;
    on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): () => void;`,
    `    on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): () => void;
    on(event: "session_before_reload", handler: ExtensionHandler<SessionBeforeReloadEvent, SessionBeforeReloadResult>): () => void;
    on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): () => void;`,
    "types-api-overload",
  );
  return next;
}

function patchRunnerRuntime(source) {
  return replaceOnce(
    source,
    `        return (event.type === "session_before_switch" ||
            event.type === "session_before_fork" ||
            event.type === "session_before_compact" ||`,
    `        return (event.type === "session_before_switch" ||
            event.type === "session_before_fork" ||
            event.type === "session_before_reload" ||
            event.type === "session_before_compact" ||`,
    "runner-cancellable-event",
  );
}

function patchRunnerTypes(source) {
  let next = replaceOnce(
    source,
    "SessionBeforeCompactResult, SessionBeforeForkResult, SessionBeforeSwitchResult, SessionBeforeTreeResult",
    "SessionBeforeCompactResult, SessionBeforeForkResult, SessionBeforeReloadResult, SessionBeforeSwitchResult, SessionBeforeTreeResult",
    "runner-result-import",
  );
  next = replaceOnce(
    next,
    `} ? SessionBeforeForkResult | undefined : TEvent extends {
    type: "session_before_compact";
} ? SessionBeforeCompactResult | undefined`,
    `} ? SessionBeforeForkResult | undefined : TEvent extends {
    type: "session_before_reload";
} ? SessionBeforeReloadResult | undefined : TEvent extends {
    type: "session_before_compact";
} ? SessionBeforeCompactResult | undefined`,
    "runner-result-map",
  );
  return next;
}

function patchExtensionIndexTypes(source) {
  return replaceOnce(
    source,
    "SessionBeforeForkEvent, SessionBeforeForkResult, SessionBeforeSwitchEvent",
    "SessionBeforeForkEvent, SessionBeforeForkResult, SessionBeforeReloadEvent, SessionBeforeReloadResult, ReloadVetoDecision, SessionBeforeSwitchEvent",
    "extension-index-exports",
  );
}

function patchAgentSessionRuntime(source) {
  let next = replaceOnce(
    source,
    `    async reload(options) {
        const oldRunner = this._extensionRunner;`,
    `    async reload(options) {
        const veto = await this.checkReloadVeto();
        if (veto.cancelled) {
            return veto;
        }
        const oldRunner = this._extensionRunner;`,
    "session-internal-gate",
  );
  next = replaceOnce(
    next,
    `            await this.extendResourcesFromExtensions("reload");
        }
    }
    // =========================================================================
    // Auto-Retry`,
    `            await this.extendResourcesFromExtensions("reload");
        }
        return { cancelled: false };
    }
    /** Probe the extension reload gate without tearing down any live runtime state. */
    async checkReloadVeto() {
        if (!this._extensionRunner.hasHandlers("session_before_reload")) {
            return { cancelled: false };
        }
        const result = await this._extensionRunner.emit({ type: "session_before_reload" });
        if (result?.cancel !== true) {
            return { cancelled: false };
        }
        return result.reason === undefined
            ? { cancelled: true }
            : { cancelled: true, reason: result.reason };
    }
    // =========================================================================
    // Auto-Retry`,
    "session-gate-method",
  );
  return next;
}

function patchAgentSessionTypes(source) {
  return replaceOnce(
    source,
    `    reload(options?: {
        beforeSessionStart?: () => void | Promise<void>;
    }): Promise<void>;
    /**
     * Check if an error is retryable`,
    `    reload(options?: {
        beforeSessionStart?: () => void | Promise<void>;
    }): Promise<{
        cancelled: boolean;
        reason?: string;
    }>;
    /** Probe the cancellable extension reload gate without reloading. */
    checkReloadVeto(): Promise<{
        cancelled: boolean;
        reason?: string;
    }>;
    /**
     * Check if an error is retryable`,
    "session-types",
  );
}

function patchInteractiveRuntime(source) {
  let next = replaceOnce(
    source,
    `        if (this.session.isCompacting) {
            this.showWarning("Wait for compaction to finish before reloading.");
            return;
        }
        this.resetExtensionUI();
        const reloadBox = new Container();`,
    `        if (this.session.isCompacting) {
            this.showWarning("Wait for compaction to finish before reloading.");
            return;
        }
        // Check before replacing the editor. AgentSession.reload() checks again
        // immediately before teardown, which closes the race after this UI probe.
        const veto = await this.session.checkReloadVeto();
        if (veto.cancelled) {
            this.showWarning(veto.reason ?? "Reload blocked by an extension.");
            return;
        }
        const reloadBox = new Container();`,
    "interactive-precheck",
  );
  next = replaceOnce(
    next,
    `            if (chatRestoredBeforeSessionStart) {
                return;
            }
            this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();`,
    `            if (chatRestoredBeforeSessionStart) {
                return;
            }
            // Defer destructive UI cleanup until the internal veto check has passed.
            this.resetExtensionUI();
            this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();`,
    "interactive-deferred-reset",
  );
  next = replaceOnce(
    next,
    `        try {
            await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
            restoreChatBeforeSessionStart();`,
    `        try {
            const reloadResult = await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
            if (reloadResult.cancelled) {
                dismissReloadBox(previousEditor);
                reloadBoxDismissed = true;
                this.showWarning(reloadResult.reason ?? "Reload blocked by an extension.");
                return;
            }
            restoreChatBeforeSessionStart();`,
    "interactive-race-result",
  );
  return next;
}

function patchRpcModeRuntime(source) {
  return replaceOnce(
    source,
    `            case "abort": {
                await session.abort();
                return success(id, "abort");
            }
            case "clear_queue": {`,
    `            case "abort": {
                await session.abort();
                return success(id, "abort");
            }
            case "reload": {
                return success(id, "reload", await session.reload());
            }
            case "check_reload_veto": {
                return success(id, "check_reload_veto", await session.checkReloadVeto());
            }
            case "clear_queue": {`,
    "rpc-command-routing",
  );
}

function patchRpcTypes(source) {
  let next = replaceOnce(
    source,
    `} | {
    id?: string;
    type: "abort";
} | {
    id?: string;
    type: "clear_queue";`,
    `} | {
    id?: string;
    type: "abort";
} | {
    id?: string;
    type: "reload";
} | {
    id?: string;
    type: "check_reload_veto";
} | {
    id?: string;
    type: "clear_queue";`,
    "rpc-command-types",
  );
  next = replaceOnce(
    next,
    `} | {
    id?: string;
    type: "response";
    command: "abort";
    success: true;
} | {
    id?: string;
    type: "response";
    command: "clear_queue";`,
    `} | {
    id?: string;
    type: "response";
    command: "abort";
    success: true;
} | {
    id?: string;
    type: "response";
    command: "reload" | "check_reload_veto";
    success: true;
    data: {
        cancelled: boolean;
        reason?: string;
    };
} | {
    id?: string;
    type: "response";
    command: "clear_queue";`,
    "rpc-response-types",
  );
  return next;
}

function patchRpcClientRuntime(source) {
  return replaceOnce(
    source,
    `    async abort() {
        await this.send({ type: "abort" });
    }
    /**
     * Clear queued steering`,
    `    async abort() {
        await this.send({ type: "abort" });
    }
    async reload() {
        return this.getData(await this.send({ type: "reload" }));
    }
    async checkReloadVeto() {
        return this.getData(await this.send({ type: "check_reload_veto" }));
    }
    /**
     * Clear queued steering`,
    "rpc-client-methods",
  );
}

function patchRpcClientTypes(source) {
  return replaceOnce(
    source,
    `    /**
     * Abort current operation.
     */
    abort(): Promise<void>;
    /**
     * Clear queued steering`,
    `    /**
     * Abort current operation.
     */
    abort(): Promise<void>;
    /** Reload resources, or return the extension veto that kept the session intact. */
    reload(): Promise<{
        cancelled: boolean;
        reason?: string;
    }>;
    /** Probe the reload gate without reloading. */
    checkReloadVeto(): Promise<{
        cancelled: boolean;
        reason?: string;
    }>;
    /**
     * Clear queued steering`,
    "rpc-client-types",
  );
}

function patchPublicIndexTypes(source) {
  // 0.86 added the *Result sibling exports to the public entry point.
  return replaceOnce(
    source,
    "SessionBeforeForkEvent, SessionBeforeForkResult, SessionBeforeSwitchEvent",
    "SessionBeforeForkEvent, SessionBeforeForkResult, SessionBeforeReloadEvent, SessionBeforeReloadResult, ReloadVetoDecision, SessionBeforeSwitchEvent",
    "public-index-exports",
  );
}

export const patches = Object.freeze([
  patch("dist/core/extensions/types.d.ts", "a4d5b8774fa8015b8a3274614f1398a6aeeffdd888c122910439666955dc2a52", patchExtensionTypes),
  patch("dist/core/extensions/runner.js", "07a94efe560e6a460a415b2188c1c3c69ca151bd163c9b5f05347caf8403ace2", patchRunnerRuntime),
  patch("dist/core/extensions/runner.d.ts", "fc0f81468c51bacfc093ac09974aa8e8053ca463e205eb66a1c63b0b655f61b9", patchRunnerTypes),
  patch("dist/core/extensions/index.d.ts", "5b294bd70da0744cb18a45d1cfb774237986c047ec1996e03f24a9605efdd4ab", patchExtensionIndexTypes),
  patch("dist/core/agent-session.js", "edaff7055ced7d49d25135c92415fbbfd9c14c4a29be5a79510ab9216045d6d9", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "423bdca09eabd78aa1e729136dd9a1e2fff3b8116c6bc2d3fee3337b269a8432", patchAgentSessionTypes),
  patch("dist/modes/interactive/interactive-mode.js", "8c9275944466afe2df78dcf02f2f6c83f6bc46fb0fdbd7257a3ef9d1da1ed027", patchInteractiveRuntime),
  patch("dist/modes/rpc/rpc-mode.js", "bdd94e753e6d19731d9fb9ea370462d095d64f1e78bddd7651320663fa57c4ff", patchRpcModeRuntime),
  patch("dist/modes/rpc/rpc-types.d.ts", "e968e5be01dc7ad9615f938ae867ef136fa495f13dcf169942e9f781a299d9eb", patchRpcTypes),
  patch("dist/modes/rpc/rpc-client.js", "5be2be46c82959fdc452a06cb64c4412098193d33b67c26a4a99b8fbf70f2f26", patchRpcClientRuntime),
  patch("dist/modes/rpc/rpc-client.d.ts", "467fbcf2e2922c2f260bd66ad438f8ca2955718aca353ed75cf9586d5bc1ec86", patchRpcClientTypes),
  patch("dist/index.d.ts", "44bf19d2716cb18382aa6bd0ae88b7e03ee50ae75b56acb6d11beb40dfe99dea", patchPublicIndexTypes),
]);
