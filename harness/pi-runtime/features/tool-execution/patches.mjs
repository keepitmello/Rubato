import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";

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
            extension.tools.set(tool.name, {
                definition: tool,
                sourceInfo: extension.sourceInfo,
            });
            runtime.refreshTools();
        },
        registerCommand(name, options) {`,
    `        registerTool(tool) {
            assertActive();
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
    `import { contentText } from "@earendil-works/pi-ai";`,
    `import { contentText, validateToolArguments } from "@earendil-works/pi-ai";`,
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
    `export type { AgentEndEvent,`,
    `export type { ExecuteToolErrorCode, ExecuteToolHandler, ExecuteToolOptions, ExecuteToolResult, LazyToolActivator, RegisterLazyToolActivatorHandler } from "./core/extensions/index.ts";
export type { AgentEndEvent,`,
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
  patch("tool-execution:core/extensions/types.d.ts", "dist/core/extensions/types.d.ts", "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a", patchTypesDeclarations),
  patch("tool-execution:core/extensions/loader.js", "dist/core/extensions/loader.js", "a1393de916487a2c47107ac7239f3139dcdb938705f88ba1ea5a954b3c8bb483", patchLoader),
  patch("tool-execution:core/extensions/runner.js", "dist/core/extensions/runner.js", "0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61", patchRunner),
  patch("tool-execution:core/agent-session.js", "dist/core/agent-session.js", "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f", patchAgentSession),
  patch("tool-execution:core/agent-session.d.ts", "dist/core/agent-session.d.ts", "db3bfd2ae08eda4936d8807656f06120e6e62672d6a7798bccba486a0dc994ea", patchAgentSessionDeclarations),
  patch("tool-execution:core/extensions/index.js", "dist/core/extensions/index.js", "9a99fd14edb60079a3c604d6045cbad7d461c3ba1ce88331f5d549372f14c46d", patchExtensionRuntimeIndex),
  patch("tool-execution:core/extensions/index.d.ts", "dist/core/extensions/index.d.ts", "dc9bd3202b8d84b580d7002efad6738465c50556e2b27624193a6505b453c87d", patchExtensionTypesIndex),
  patch("tool-execution:index.js", "dist/index.js", "82cb4ea864f3d8816c06bc8f2f2d9a8d82d883297af179dc69d287d042834844", patchRootRuntimeIndex),
  patch("tool-execution:index.d.ts", "dist/index.d.ts", "f1cb93477c7357d08b839c0663d079b8f9bb949079ed7b50a71f8d2945cece90", patchRootTypesIndex),
]);

export const toolExecutionFeature = Object.freeze({ id: "tool-execution", files, patches });
