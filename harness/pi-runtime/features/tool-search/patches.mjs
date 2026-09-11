import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const VERSION = "0.85.1";

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
    `/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition`,
    `export type ToolExposure = "direct" | "search";
/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition`,
    "exposure-type",
  );
  next = replaceOnce(
    next,
    `    /** Description for LLM */
    description: string;
    /** Optional one-line snippet`,
    `    /** Description for LLM */
    description: string;
    /** Initial model exposure; search tools are catalogued but start inactive. */
    exposure?: ToolExposure;
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
    `/** Tool info with name, description, parameter schema, prompt guidelines, and source metadata. */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
    sourceInfo: SourceInfo;
};`,
    `/** Tool info with normalized exposure and source metadata. */
export type ToolInfo = Pick<ToolDefinition, "name" | "label" | "description" | "parameters" | "promptGuidelines"> & {
    sourceInfo: SourceInfo;
    exposure: ToolExposure;
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
    `        return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            promptGuidelines: definition.promptGuidelines,
            sourceInfo,
        }));`,
    `        return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => {
            const exposure = definition.exposure === "search" ? "search" : "direct";
            return {
                name: definition.name,
                label: definition.label,
                description: definition.description,
                parameters: definition.parameters,
                promptGuidelines: definition.promptGuidelines,
                sourceInfo,
                exposure,
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
    `        this._toolRegistry = toolRegistry;
        const nextActiveToolNames =`,
    `        this._toolRegistry = toolRegistry;
        const isDirectlyExposed = (name) => this._toolDefinitions.get(name)?.definition.exposure !== "search";
        const nextActiveToolNames =`,
    "direct-exposure-helper",
  );
  next = replaceOnce(
    next,
    `        else if (options?.includeAllExtensionTools) {
            for (const tool of wrappedExtensionTools) {
                nextActiveToolNames.push(tool.name);
            }
        }`,
    `        else if (options?.includeAllExtensionTools) {
            for (const tool of wrappedExtensionTools) {
                if (isDirectlyExposed(tool.name))
                    nextActiveToolNames.push(tool.name);
            }
        }`,
    "include-direct-only",
  );
  return replaceOnce(
    next,
    `                if (!previousRegistryNames.has(toolName)) {
                    nextActiveToolNames.push(toolName);
                }`,
    `                if (!previousRegistryNames.has(toolName) && isDirectlyExposed(toolName)) {
                    nextActiveToolNames.push(toolName);
                }`,
    "new-direct-only",
  );
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
    `export type { ToolExposure } from "./types.ts";
export { normalizeToolExposure } from "./types.ts";
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
    `export type { ToolExposure } from "./core/extensions/index.ts";
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
  patch("tool-search:core/extensions/types.d.ts", "dist/core/extensions/types.d.ts", "5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a", patchTypesDeclarations),
  patch("tool-search:core/agent-session.js", "dist/core/agent-session.js", "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f", patchAgentSession),
  patch("tool-search:core/extensions/index.js", "dist/core/extensions/index.js", "9a99fd14edb60079a3c604d6045cbad7d461c3ba1ce88331f5d549372f14c46d", patchExtensionRuntimeIndex),
  patch("tool-search:core/extensions/index.d.ts", "dist/core/extensions/index.d.ts", "dc9bd3202b8d84b580d7002efad6738465c50556e2b27624193a6505b453c87d", patchExtensionTypesIndex),
  patch("tool-search:index.js", "dist/index.js", "82cb4ea864f3d8816c06bc8f2f2d9a8d82d883297af179dc69d287d042834844", patchRootRuntimeIndex),
  patch("tool-search:index.d.ts", "dist/index.d.ts", "f1cb93477c7357d08b839c0663d079b8f9bb949079ed7b50a71f8d2945cece90", patchRootTypesIndex),
]);

export const toolSearchFeature = Object.freeze({ id: "tool-search", files, patches });
