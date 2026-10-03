const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as PACKAGE_VERSION } from "../../pi-version.mjs";

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
  patch("dist/core/extensions/types.d.ts", "abd9e9be0bf21b4c35621fe90b79af75c85b774e8b254b515d699785fda5962a", patchExtensionTypes),
  patch("dist/core/extensions/runner.js", "258f142bc56cc84d953ef6146222e5ff3a94cc908592a1b3d075d34bbcd68b36", patchRunnerRuntime),
  patch("dist/core/extensions/runner.d.ts", "6aef77e094e73abd7e508850e45c58e244ab2d5db6c4f6278d8652ea9ded2bb1", patchRunnerTypes),
  patch("dist/core/extensions/index.d.ts", "fe5661c6cd9a948293f0f1d1db5a052dcc60493f6b1f68349a7ab96987b10e40", patchExtensionIndexTypes),
  patch("dist/core/agent-session.js", "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab", patchAgentSessionRuntime),
  patch("dist/core/agent-session.d.ts", "2e50b35a37f9c7149c6297ae554b2d965bd74dbfcb8ccd7be44f13226ce497e7", patchAgentSessionTypes),
  patch("dist/modes/interactive/interactive-mode.js", "14508d43f3dd47faa6b10c4a6537740f1cf238eee3fc873a9e0648125214bbcc", patchInteractiveRuntime),
  patch("dist/modes/rpc/rpc-mode.js", "631697cd35928fc827f4a423538c43ff227b8cbf63c2a2f11060616f55eba6db", patchRpcModeRuntime),
  patch("dist/modes/rpc/rpc-types.d.ts", "68b6dc2e47a3969c09c961a40d0462473407b6786f3bd02715fa035e816e2af1", patchRpcTypes),
  patch("dist/modes/rpc/rpc-client.js", "6cbb7d183db13468af61af733013a97ee6f5547ccd44edb1f85647f8bd6f218c", patchRpcClientRuntime),
  patch("dist/modes/rpc/rpc-client.d.ts", "85ec53b3f019e0176bdbb8f843a213d8ae8aa0bba937dce40291e1315b762b1b", patchRpcClientTypes),
  patch("dist/index.d.ts", "b254e36846b1dcc64ce1a8ba72e23fb410df4aa4408ba8c23e69e5b3f934e3cc", patchPublicIndexTypes),
]);
