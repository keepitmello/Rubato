// Build-time capability selection only. Runtime extensions remain independently
// owned modules; this catalog does not replace Pi's extension/session harness.
const catalog = Object.freeze({
  reload: { requires: [], load: () => import("./features/reload/patches.mjs") },
  "tool-execution": { requires: [], load: () => import("./features/tool-execution/patches.mjs") },
  codemode: { requires: ["tool-execution"], load: () => import("./features/codemode/patches.mjs") },
  "service-tier": { requires: [], load: () => import("./features/service-tier/patches.mjs") },
  "input-lifecycle": { requires: [], load: () => import("./features/input-lifecycle/patches.mjs") },
  "abort-provenance": { requires: [], load: () => import("./features/abort-provenance/patches.mjs") },
  mcp: { requires: ["tool-execution"], load: async () => (await import("./features/mcp/feature.mjs")).mcpFeature },
  "tool-search": { requires: ["tool-execution"], load: () => import("./features/tool-search/patches.mjs") },
  "extension-rpc": { requires: [], load: () => import("./features/extension-rpc/patches.mjs") },
  "request-run": { requires: ["input-lifecycle", "abort-provenance"], load: () => import("./features/request-run/patches.mjs") },
  "mcp-producers": { requires: ["mcp"], load: async () => (await import("./features/mcp-producers/feature.mjs")).mcpProducersFeature },
  "session-catalog": { requires: [], load: () => import("./features/session-catalog/patches.mjs") },
  "session-picker": { requires: ["session-catalog"], load: () => import("./features/session-picker/patches.mjs") },
  "child-runtime": { requires: [], load: async () => (await import("./features/child-runtime/feature.mjs")).childRuntimeFeature },
  terminal: { requires: ["tool-execution"], load: () => import("./features/terminal/patches.mjs") },
  providers: { requires: [], load: () => import("./features/providers/patches.mjs") },
  "runtime-factories": { requires: [], load: () => import("./features/runtime-factories/patches.mjs") },
  "media-tools": { requires: ["tool-execution"], load: () => import("./features/media-tools/patches.mjs") },
  "video-in": { requires: ["tool-execution"], load: () => import("./features/video-in/patches.mjs") },
  "tool-guards": { requires: ["tool-execution"], load: async () => (await import("./features/tool-guards/feature.mjs")).toolGuardsFeature },
  "tool-policy": { requires: ["tool-execution"], load: async () => (await import("./features/tool-policy/feature.mjs")).toolPolicyFeature },
  "provider-execution": { requires: ["tool-execution", "providers"], load: async () => (await import("./features/provider-execution/patches.mjs")).providerExecutionFeature },
  "context-notes": { requires: [], load: () => import("./features/context-notes/patches.mjs") },
  "context-window": { requires: ["context-notes"], load: () => import("./features/context-window/patches.mjs") },
  "prompt-rules": { requires: [], load: () => import("./features/prompt-rules/feature.mjs") },
  "prompt-preset": { requires: [], load: () => import("./features/prompt-preset/feature.mjs") },
  compaction: { requires: [], load: () => import("./features/compaction/feature.mjs") },
  "config-reload": { requires: [], load: () => import("./features/config-reload/feature.mjs") },
  "user-commands-agent": { requires: [], load: async () => (await import("./features/user-commands-agent/feature.mjs")).userCommandsAgentFeature },
  "user-commands-session": { requires: ["session-catalog"], load: async () => (await import("./features/user-commands-session/feature.mjs")).feature },
});

export const PI_FEATURE_NAMES = Object.freeze(Object.keys(catalog));

/** Select explicit features plus their required hooks, once in dependency order. */
export async function loadPiFeatures(names) {
  if (!Array.isArray(names)) throw new TypeError("Pi feature selection must be an array");
  for (const name of names) {
    if (typeof name !== "string" || !Object.hasOwn(catalog, name)) throw new Error(`Unknown Pi feature: ${String(name)}`);
  }
  const selected = new Set();
  function select(name) {
    for (const dependency of catalog[name].requires) select(dependency);
    selected.add(name);
  }
  for (const name of names) select(name);
  return Promise.all([...selected].map(async (id) => {
    const { patches, files = [] } = await catalog[id].load();
    if (!Array.isArray(patches) || !Array.isArray(files)) throw new Error(`Invalid Pi feature manifest: ${id}`);
    return { id, patches, files };
  }));
}
