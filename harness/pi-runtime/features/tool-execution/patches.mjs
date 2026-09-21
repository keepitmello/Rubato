import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.86.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[tool-execution:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[tool-execution:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName: PACKAGE_NAME, version: PACKAGE_VERSION, path, preimageSha256, apply });
}

function patchTypesRuntime(source) {
  return replaceOnce(
    source,
    `export function isToolCallEventType(toolName, event) {
    return event.toolName === toolName;
}
//# sourceMappingURL=types.js.map`,
    `export function isToolCallEventType(toolName, event) {
    return event.toolName === toolName;
}
export class ExecuteToolError extends Error {
    code;
    toolName;
    activeToolNames;
    constructor(code, toolName, message, activeToolNames) {
        super(message);
        this.name = "ExecuteToolError";
        this.code = code;
        this.toolName = toolName;
        this.activeToolNames = activeToolNames;
    }
}
//# sourceMappingURL=types.js.map`,
    "types-runtime-error",
  );
}

function patchTypesDeclarations(source) {
  let next = replaceOnce(
    source,
    `    /** Register a custom command. */
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;`,
    `    /** Register an owner that can activate a known inactive tool on demand. */
    registerLazyToolActivator(activator: LazyToolActivator): void;
    /** Execute a registered tool through Pi validation and middleware hooks. */
    executeTool(toolName: string, params: unknown, options?: ExecuteToolOptions): Promise<ExecuteToolResult>;
    /** Register a custom command. */
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;`,
    "api-methods",
  );
  next = replaceOnce(
    next,
    `export type GetActiveToolsHandler = () => string[];`,
    `export interface ExecuteToolOptions {
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
    activateInactiveTool?: boolean;
    /** Preserve a provider-owned call id when execution is bridged mid-stream. */
    toolCallId?: string;
}
export type ExecuteToolResult = AgentToolResult & { readonly isError: boolean };
export type ExecuteToolErrorCode = "unknown_tool" | "inactive_tool" | "invalid_params" | "blocked";
export declare class ExecuteToolError extends Error {
    readonly code: ExecuteToolErrorCode;
    readonly toolName: string;
    readonly activeToolNames: string[];
    constructor(code: ExecuteToolErrorCode, toolName: string, message: string, activeToolNames: string[]);
}
export type ExecuteToolHandler = (toolName: string, params: unknown, options?: ExecuteToolOptions) => Promise<ExecuteToolResult>;
export type LazyToolActivator = (toolName: string) => boolean;
export type RegisterLazyToolActivatorHandler = (activator: LazyToolActivator) => void;
export type GetActiveToolsHandler = () => string[];`,
    "handler-types",
  );
  next = replaceOnce(
    next,
    `    pendingNativeProviderRegistrations: Array<{
        provider: Provider;
        extensionPath: string;
    }>;
    /** Throws when this extension instance is stale after runtime replacement. */`,
    `    pendingNativeProviderRegistrations: Array<{
        provider: Provider;
        extensionPath: string;
    }>;
    /** Activators registered before AgentSession binds this runtime. */
    pendingLazyToolActivators: LazyToolActivator[];
    /** Register immediately after bind, or queue before bind. */
    registerLazyToolActivator: RegisterLazyToolActivatorHandler;
    /** Throws when this extension instance is stale after runtime replacement. */`,
    "runtime-state",
  );
  next = replaceOnce(
    next,
    `    setLabel: SetLabelHandler;
    getActiveTools: GetActiveToolsHandler;`,
    `    setLabel: SetLabelHandler;
    executeTool: ExecuteToolHandler;
    getActiveTools: GetActiveToolsHandler;`,
    "actions",
  );
  return next;
}

function patchLoader(source) {
  let next = replaceOnce(
    source,
    `        setLabel: notInitialized,
        getActiveTools: notInitialized,`,
    `        setLabel: notInitialized,
        executeTool: () => Promise.reject(new Error("Extension runtime not initialized")),
        getActiveTools: notInitialized,`,
    "runtime-execute",
  );
  next = replaceOnce(
    next,
    `        pendingNativeProviderRegistrations: [],
        assertActive,`,
    `        pendingNativeProviderRegistrations: [],
        pendingLazyToolActivators: [],
        registerLazyToolActivator: (activator) => runtime.pendingLazyToolActivators.push(activator),
        assertActive,`,
    "runtime-lazy",
  );
  next = replaceOnce(
    next,
    `        registerTool(tool) {
            assertActive();
            if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
                throw new Error(\`Tool "\${tool.name}" registered by extension "\${extension.path}" must define an object parameter schema.\`);
            }
            extension.tools.set(tool.name, {
                definition: tool,
                sourceInfo: extension.sourceInfo,
            });
            runtime.refreshTools();
        },
        registerCommand(name, options) {`,
    `        registerTool(tool) {
            assertActive();
            if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
                throw new Error(\`Tool "\${tool.name}" registered by extension "\${extension.path}" must define an object parameter schema.\`);
            }
            extension.tools.set(tool.name, {
                definition: tool,
                sourceInfo: extension.sourceInfo,
            });
            runtime.refreshTools();
        },
        registerLazyToolActivator(activator) {
            assertActive();
            runtime.registerLazyToolActivator(activator);
        },
        registerCommand(name, options) {`,
    "api-lazy",
  );
  return replaceOnce(
    next,
    `        getActiveTools() {
            assertActive();
            return runtime.getActiveTools();
        },`,
    `        executeTool(toolName, params, options) {
            assertActive();
            return runtime.executeTool(toolName, params, options);
        },
        getActiveTools() {
            assertActive();
            return runtime.getActiveTools();
        },`,
    "api-execute",
  );
}

function patchRunner(source) {
  return replaceOnce(
    source,
    `        this.runtime.setLabel = actions.setLabel;
        this.runtime.getActiveTools = actions.getActiveTools;`,
    `        this.runtime.setLabel = actions.setLabel;
        this.runtime.executeTool = actions.executeTool;
        this.runtime.registerLazyToolActivator = actions.registerLazyToolActivator;
        for (const activator of this.runtime.pendingLazyToolActivators) {
            actions.registerLazyToolActivator(activator);
        }
        this.runtime.pendingLazyToolActivators = [];
        this.runtime.getActiveTools = actions.getActiveTools;`,
    "bind-actions",
  );
}

function patchAgentSession(source) {
  let next = replaceOnce(
    source,
    `import { contentText, getCurrentSystemMessage, retryDelayMs } from "@earendil-works/pi-ai";`,
    `import { contentText, getCurrentSystemMessage, retryDelayMs, validateToolArguments } from "@earendil-works/pi-ai";`,
    "validation-import",
  );
  next = replaceOnce(
    next,
    `import { ExtensionRunner, wrapRegisteredTools, } from "./extensions/index.js";`,
    `import { ExecuteToolError, ExtensionRunner, wrapRegisteredTools, } from "./extensions/index.js";
import { executeRegisteredTool } from "../../../../../rubato-features/tool-execution/runtime.mjs";`,
    "runtime-import",
  );
  next = replaceOnce(
    next,
    `    _toolRegistry = new Map();
    _toolDefinitions = new Map();`,
    `    _toolRegistry = new Map();
    _lazyToolActivators = [];
    _toolDefinitions = new Map();`,
    "activator-field",
  );
  next = replaceOnce(
    next,
    `    getToolDefinition(name) {
        return this._toolDefinitions.get(name)?.definition;
    }
    /**
     * Set active tools by name.`,
    `    getToolDefinition(name) {
        return this._toolDefinitions.get(name)?.definition;
    }
    /** Execute one registered tool through normal validation and middleware. */
    async executeTool(toolName, params, options) {
        return executeRegisteredTool(this, toolName, params, options, { validateToolArguments, ExecuteToolError });
    }
    /**
     * Set active tools by name.`,
    "execute-method",
  );
  next = replaceOnce(
    next,
    `            setLabel: (entryId, label) => {
                this.sessionManager.appendLabelChange(entryId, label);
            },
            getActiveTools: () => this.getActiveToolNames(),`,
    `            setLabel: (entryId, label) => {
                this.sessionManager.appendLabelChange(entryId, label);
            },
            executeTool: (toolName, params, options) => this.executeTool(toolName, params, options),
            registerLazyToolActivator: (activator) => this._lazyToolActivators.push(activator),
            getActiveTools: () => this.getActiveToolNames(),`,
    "bind-actions",
  );
  next = replaceOnce(
    next,
    `    setActiveToolsByName(toolNames) {
        const tools = [];`,
    `    setActiveToolsByName(toolNames) {
        // apply_patch is the model-facing editor; keep edit/write registered
        // for exec-bridge, but never put them on the request. Only where
        // apply_patch exists: senpi ships it, the stock engine does not, and
        // dropping edit/write there left the model with no way to write a file
        // at all.
        if (this._toolRegistry.has("apply_patch"))
            toolNames = toolNames.filter((name) => name !== "edit" && name !== "write");
        const tools = [];`,
    "single-editor",
  );
  return replaceOnce(
    next,
    `    _buildRuntime(options) {
        const autoResizeImages`,
    `    _buildRuntime(options) {
        this._lazyToolActivators = [];
        const autoResizeImages`,
    "runtime-reset",
  );
}

function patchAgentSessionDeclarations(source) {
  let next = replaceOnce(
    source,
    `    private _toolRegistry;
    private _toolDefinitions;`,
    `    private _toolRegistry;
    private _lazyToolActivators;
    private _toolDefinitions;`,
    "field",
  );
  return replaceOnce(
    next,
    `    getToolDefinition(name: string): ToolDefinition | undefined;
    /**
     * Set active tools by name.`,
    `    getToolDefinition(name: string): ToolDefinition | undefined;
    /** Execute one registered tool through normal validation and middleware. */
    executeTool(toolName: string, params: unknown, options?: import("./extensions/types.js").ExecuteToolOptions): Promise<import("./extensions/types.js").ExecuteToolResult>;
    /**
     * Set active tools by name.`,
    "method",
  );
}

function patchExtensionRuntimeIndex(source) {
  return replaceOnce(
    source,
    `export { defineTool, isBashToolResult,`,
    `export { ExecuteToolError, defineTool, isBashToolResult,`,
    "runtime-export",
  );
}

function patchExtensionTypesIndex(source) {
  let next = replaceOnce(
    source,
    `export { defineTool, isBashToolResult,`,
    `export { ExecuteToolError, defineTool, isBashToolResult,`,
    "value-export",
  );
  return replaceOnce(
    next,
    `export type { AfterProviderResponseEvent,`,
    `export type { ExecuteToolErrorCode, ExecuteToolHandler, ExecuteToolOptions, ExecuteToolResult, LazyToolActivator, RegisterLazyToolActivatorHandler, AfterProviderResponseEvent,`,
    "type-export",
  );
}

function patchRootRuntimeIndex(source) {
  return replaceOnce(
    source,
    `export { createExtensionRuntime, defineTool,`,
    `export { createExtensionRuntime, ExecuteToolError, defineTool,`,
    "runtime-export",
  );
}

function patchRootTypesIndex(source) {
  let next = replaceOnce(
    source,
    `export { createExtensionRuntime, defineTool,`,
    `export { createExtensionRuntime, ExecuteToolError, defineTool,`,
    "value-export",
  );
  return replaceOnce(
    next,
    `export type { AfterProviderResponseEvent, AgentEndEvent,`,
    `export type { ExecuteToolErrorCode, ExecuteToolHandler, ExecuteToolOptions, ExecuteToolResult, LazyToolActivator, RegisterLazyToolActivatorHandler } from "./core/extensions/index.ts";
export type { AfterProviderResponseEvent, AgentEndEvent,`,
    "type-export",
  );
}

export const files = Object.freeze([
  Object.freeze({
    target: "runtime",
    version: PACKAGE_VERSION,
    path: "rubato-features/tool-execution/runtime.mjs",
    sourcePath: fileURLToPath(new URL("./runtime.mjs", import.meta.url)),
  }),
  Object.freeze({
    target: "runtime",
    version: PACKAGE_VERSION,
    path: "rubato-features/tool-execution/THIRD_PARTY_NOTICES.md",
    sourcePath: fileURLToPath(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url)),
  }),
]);

export const patches = Object.freeze([
  patch("tool-execution:core/extensions/types.js", "dist/core/extensions/types.js", "447039081a7808371e07d85bacc719a11eea7b66f291b9949de33ef952a809fc", patchTypesRuntime),
  patch("tool-execution:core/extensions/types.d.ts", "dist/core/extensions/types.d.ts", "a4d5b8774fa8015b8a3274614f1398a6aeeffdd888c122910439666955dc2a52", patchTypesDeclarations),
  patch("tool-execution:core/extensions/loader.js", "dist/core/extensions/loader.js", "81106b07522aaf9197858c4679fecd7fbd23c346376d6e1f2cc3dd5294d543f4", patchLoader),
  patch("tool-execution:core/extensions/runner.js", "dist/core/extensions/runner.js", "07a94efe560e6a460a415b2188c1c3c69ca151bd163c9b5f05347caf8403ace2", patchRunner),
  patch("tool-execution:core/agent-session.js", "dist/core/agent-session.js", "edaff7055ced7d49d25135c92415fbbfd9c14c4a29be5a79510ab9216045d6d9", patchAgentSession),
  patch("tool-execution:core/agent-session.d.ts", "dist/core/agent-session.d.ts", "423bdca09eabd78aa1e729136dd9a1e2fff3b8116c6bc2d3fee3337b269a8432", patchAgentSessionDeclarations),
  patch("tool-execution:core/extensions/index.js", "dist/core/extensions/index.js", "9a99fd14edb60079a3c604d6045cbad7d461c3ba1ce88331f5d549372f14c46d", patchExtensionRuntimeIndex),
  patch("tool-execution:core/extensions/index.d.ts", "dist/core/extensions/index.d.ts", "5b294bd70da0744cb18a45d1cfb774237986c047ec1996e03f24a9605efdd4ab", patchExtensionTypesIndex),
  patch("tool-execution:index.js", "dist/index.js", "82cb4ea864f3d8816c06bc8f2f2d9a8d82d883297af179dc69d287d042834844", patchRootRuntimeIndex),
  patch("tool-execution:index.d.ts", "dist/index.d.ts", "44bf19d2716cb18382aa6bd0ae88b7e03ee50ae75b56acb6d11beb40dfe99dea", patchRootTypesIndex),
]);

export const toolExecutionFeature = Object.freeze({ id: "tool-execution", files, patches });
