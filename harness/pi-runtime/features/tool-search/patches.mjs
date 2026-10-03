import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
import { PI_VERSION as VERSION } from "../../pi-version.mjs";

/**
 * The tools the model sees from the first request. Every other extension tool starts
 * inactive and is catalogued for tool_search; activating one declares it mid-conversation
 * (`toolsAdded`), which Anthropic (`tool_addition`) and Codex (`additional_tools`) load
 * without touching the cached prefix. Before this, all ~50 tools rode in every prefix
 * (Opus 5.5: 20.1k of a 27.7k first request, 2026-09-24).
 *
 * The policy only fills in tools that declare nothing. Out of scope: a declared `exposure`
 * (memory's `memory.tool_exposure` defaults to "direct"), engine builtins (grep/find/ls/
 * edit/write stay registered-but-inactive and uncatalogued), MCP tools (their server's
 * exposure owns them), `allowLazyActivation: false` tools, and tools an owner activates
 * itself (the terminal extension keeps bash's companions on for background sessions).
 */
export const DIRECT_TOOL_NAMES = Object.freeze(["read", "bash", "apply_patch", "todo", "tool_search"]);

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[tool-search:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[tool-search:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(id, path, preimageSha256, apply) {
  return Object.freeze({ id, packageName: PACKAGE_NAME, version: VERSION, path, preimageSha256, apply });
}

function patchTypesRuntime(source) {
  return replaceOnce(
    source,
    `export function defineTool(tool) {`,
    `export function normalizeToolExposure(definition) {
    const exposure = definition.exposure === "search" ? "search" : "direct";
    return {
        exposure,
        searchText: exposure === "search" ? definition.searchText : undefined,
        searchKeywords: definition.searchKeywords ?? [],
        searchGroup: definition.searchGroup,
        allowLazyActivation: definition.allowLazyActivation !== false,
    };
}
export function defineTool(tool) {`,
    "normalize-runtime",
  );
}

function patchTypesDeclarations(source) {
  let next = replaceOnce(
    source,
    // 0.99 declares its own ToolExposure; Rubato's \`search\` joins that union.
    `export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";`,
    `/** \`search\` (Rubato): catalogued for tool_search and inactive until it loads the tool. */
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden" | "search";`,
    "exposure-type",
  );
  next = replaceOnce(
    next,
    `    /** Description for LLM */
    description: string;
    /** Optional one-line snippet`,
    `    /** Description for LLM */
    description: string;
    /** Supplemental capability text indexed by tool_search. */
    searchText?: string;
    /** Synonyms indexed with tool names. */
    searchKeywords?: readonly string[];
    /** Catalog group filter. */
    searchGroup?: string;
    /** Hard stop for lazy activation. Defaults to true. */
    allowLazyActivation?: boolean;
    /** Optional one-line snippet`,
    "definition-fields",
  );
  next = replaceOnce(
    next,
    `export declare function defineTool<TParams`,
    `export declare function normalizeToolExposure(definition: Pick<ToolDefinition, "exposure" | "searchText" | "searchKeywords" | "searchGroup" | "allowLazyActivation">): {
    exposure: ToolExposure;
    searchText?: string;
    searchKeywords: readonly string[];
    searchGroup?: string;
    allowLazyActivation: boolean;
};
export declare function defineTool<TParams`,
    "normalize-declaration",
  );
  return replaceOnce(
    next,
    `export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
    exposure: ToolExposure;
    namespace?: ToolNamespace;
    annotations?: ToolAnnotations;
    sourceInfo: SourceInfo;
};`,
    `/** Tool info with normalized exposure and source metadata. */
export type ToolInfo = Pick<ToolDefinition, "name" | "label" | "description" | "parameters" | "promptGuidelines"> & {
    namespace?: ToolNamespace;
    annotations?: ToolAnnotations;
    sourceInfo: SourceInfo;
    /** Effective exposure after the Rubato tool surface policy. */
    exposure: ToolExposure;
    /** Exposure the definition itself declared. */
    declaredExposure: ToolExposure;
    searchText?: string;
    searchKeywords: readonly string[];
    searchGroup?: string;
    allowLazyActivation: boolean;
};`,
    "tool-info",
  );
}

function patchAgentSession(source) {
  let next = replaceOnce(
    source,
    `export class AgentSession {`,
    `// Rubato tool surface policy; the list is DIRECT_TOOL_NAMES in features/tool-search/patches.mjs.
const RUBATO_DIRECT_TOOL_NAMES = new Set(${JSON.stringify(DIRECT_TOOL_NAMES)});
function rubatoToolExposure(definition, sourceInfo) {
    if (definition?.exposure === "search" || definition?.exposure === "direct")
        return definition.exposure;
    if (!definition || sourceInfo?.source === "builtin" || definition.mcpExposure !== undefined || definition.allowLazyActivation === false)
        return "direct";
    return RUBATO_DIRECT_TOOL_NAMES.has(definition.name) ? "direct" : "search";
}
// Measurement only (pi-1-0-upgrade outcome 4): with pi's built-in tool_search enabled through
// RUBATO_PI_BUILTIN_EXTENSIONS, the tools our policy files for search are \`deferred\` to pi
// instead, so the built-in searches the same set. Unset, nothing changes.
const RUBATO_NATIVE_TOOL_SEARCH = (process.env.RUBATO_PI_BUILTIN_EXTENSIONS ?? "").split(",").some((name) => name.trim() === "tool-search");
export class AgentSession {`,
    "surface-policy",
  );
  next = replaceOnce(
    next,
    `        return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            promptGuidelines: definition.promptGuidelines,
            exposure: this._getToolExposure(definition.name),
            ...(definition.namespace ? { namespace: definition.namespace } : {}),
            ...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
            sourceInfo,
        }));`,
    `        return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => {
            const exposure = RUBATO_NATIVE_TOOL_SEARCH ? this._getToolExposure(definition.name) : rubatoToolExposure(definition, sourceInfo);
            return {
                name: definition.name,
                label: definition.label,
                description: definition.description,
                parameters: definition.parameters,
                promptGuidelines: definition.promptGuidelines,
                ...(definition.namespace ? { namespace: definition.namespace } : {}),
                ...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
                sourceInfo,
                exposure,
                declaredExposure: definition.exposure === "search" ? "search" : "direct",
                searchText: exposure === "search" ? definition.searchText : undefined,
                searchKeywords: definition.searchKeywords ?? [],
                searchGroup: definition.searchGroup,
                allowLazyActivation: definition.allowLazyActivation !== false,
            };
        });`,
    "catalog-metadata",
  );
  next = replaceOnce(
    next,
    `    _getToolExposure(name) {
        return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
    }`,
    `    _getToolExposure(name) {
        if (RUBATO_NATIVE_TOOL_SEARCH) {
            const entry = this._toolDefinitions.get(name);
            if (rubatoToolExposure(entry?.definition, entry?.sourceInfo) === "search")
                return "deferred";
        }
        return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
    }`,
    "native-search-measurement",
  );
  // 1.0 funnels both auto-activation paths (all extension tools at startup, tools new to a
  // refresh) through _isActivatedOnRegistration, so the policy hooks there instead of the
  // two loops 0.86 had. Explicitly named tools (--tools) still activate, as before.
  next = replaceOnce(
    next,
    `    _isActivatedOnRegistration(name) {
        return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;`,
    `    _isActivatedOnRegistration(name) {
        const entry = this._toolDefinitions.get(name);
        if (rubatoToolExposure(entry?.definition, entry?.sourceInfo) === "search")
            return false;
        return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;`,
    "registration-direct-only",
  );
  return next;
}

function patchExtensionRuntimeIndex(source) {
  return replaceOnce(
    source,
    `export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.js";`,
    `export { normalizeToolExposure } from "./types.js";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.js";`,
    "runtime-export",
  );
}

function patchExtensionTypesIndex(source) {
  return replaceOnce(
    source,
    `export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";`,
    `export { normalizeToolExposure } from "./types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";`,
    "types-export",
  );
}

function patchRootRuntimeIndex(source) {
  return replaceOnce(
    source,
    `export { convertToLlm } from "./core/messages.js";`,
    `export { normalizeToolExposure } from "./core/extensions/index.js";
export { convertToLlm } from "./core/messages.js";`,
    "runtime-export",
  );
}

function patchRootTypesIndex(source) {
  return replaceOnce(
    source,
    `export type { ReadonlyFooterDataProvider }`,
    `export { normalizeToolExposure } from "./core/extensions/index.ts";
export type { ReadonlyFooterDataProvider }`,
    "type-export",
  );
}

const RUNTIME_FILES = ["bm25.mjs", "index.mjs", "marker.mjs", "service.mjs", "tool.mjs", "THIRD_PARTY_NOTICES.md"];

export const files = Object.freeze(RUNTIME_FILES.map((name) => Object.freeze({
  target: "runtime",
  version: VERSION,
  path: `rubato-features/tool-search/${name}`,
  sourcePath: fileURLToPath(new URL(`./${name}`, import.meta.url)),
})));

export const patches = Object.freeze([
  patch("tool-search:core/extensions/types.js", "dist/core/extensions/types.js", "447039081a7808371e07d85bacc719a11eea7b66f291b9949de33ef952a809fc", patchTypesRuntime),
  patch("tool-search:core/extensions/types.d.ts", "dist/core/extensions/types.d.ts", "abd9e9be0bf21b4c35621fe90b79af75c85b774e8b254b515d699785fda5962a", patchTypesDeclarations),
  patch("tool-search:core/agent-session.js", "dist/core/agent-session.js", "35ca1dabd54d98c236c9601b569c2856b726ade392d06b2eaaf50158f48913ab", patchAgentSession),
  patch("tool-search:core/extensions/index.js", "dist/core/extensions/index.js", "9a99fd14edb60079a3c604d6045cbad7d461c3ba1ce88331f5d549372f14c46d", patchExtensionRuntimeIndex),
  patch("tool-search:core/extensions/index.d.ts", "dist/core/extensions/index.d.ts", "fe5661c6cd9a948293f0f1d1db5a052dcc60493f6b1f68349a7ab96987b10e40", patchExtensionTypesIndex),
  patch("tool-search:index.js", "dist/index.js", "5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30", patchRootRuntimeIndex),
  patch("tool-search:index.d.ts", "dist/index.d.ts", "b254e36846b1dcc64ce1a8ba72e23fb410df4aa4408ba8c23e69e5b3f934e3cc", patchRootTypesIndex),
]);

export const toolSearchFeature = Object.freeze({ id: "tool-search", files, patches });
