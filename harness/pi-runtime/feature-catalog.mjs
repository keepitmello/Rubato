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
