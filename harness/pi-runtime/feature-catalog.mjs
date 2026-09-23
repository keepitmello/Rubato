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
  "session-transport": { requires: ["extension-rpc"], load: () => import("./features/session-transport/patches.mjs") },
  // session-picker must reach dist/cli/session-picker.js before session-ui:
  // session-ui only wires its close hook into finish() when the picker has
  // already introduced it, and otherwise inserts a line that breaks the
  // picker's own anchor. Catalog order is the staging order.
  "session-catalog": { requires: [], load: () => import("./features/session-catalog/patches.mjs") },
  "session-picker": { requires: ["session-catalog"], load: () => import("./features/session-picker/patches.mjs") },
  // remote-surface 가 먼저여야 session-ui 의 그 자리 패치가 걸린다 — 이유는
  // session-ui/patches.mjs 의 해당 가드 옆에 적어 뒀다. 선언하지 않으면 합성
  // 순서가 뒤집힐 때 조용히 건너뛰고 hosted 배선이 꺼진 후보가 나온다.
  "session-ui": { requires: ["session-transport", "remote-surface"], load: () => import("./features/session-ui/patches.mjs") },
  "request-run": { requires: ["input-lifecycle", "abort-provenance"], load: () => import("./features/request-run/patches.mjs") },
  "mcp-producers": { requires: ["mcp"], load: async () => (await import("./features/mcp-producers/feature.mjs")).mcpProducersFeature },
  "session-title": { requires: [], load: async () => (await import("./features/session-title/feature.mjs")).sessionTitleFeature },
 "adapter-hooks": { requires: [], load: async () => (await import("./features/adapter-hooks/feature.mjs")).adapterHooksFeature },
  "parity-gaps": { requires: [], load: () => import("./features/parity-gaps/feature.mjs") },
  "child-runtime": { requires: ["session-prompt"], load: async () => (await import("./features/child-runtime/feature.mjs")).childRuntimeFeature },
  terminal: { requires: ["tool-execution"], load: () => import("./features/terminal/patches.mjs") },
  providers: { requires: [], load: () => import("./features/providers/patches.mjs") },
  "runtime-factories": { requires: [], load: () => import("./features/runtime-factories/patches.mjs") },
  "media-tools": { requires: ["tool-execution", "session-prompt"], load: () => import("./features/media-tools/patches.mjs") },
  "video-in": { requires: ["tool-execution"], load: () => import("./features/video-in/patches.mjs") },
  "tool-guards": { requires: ["tool-execution"], load: async () => (await import("./features/tool-guards/feature.mjs")).toolGuardsFeature },
  "tool-policy": { requires: ["tool-execution"], load: async () => (await import("./features/tool-policy/feature.mjs")).toolPolicyFeature },
  "provider-execution": { requires: ["tool-execution", "providers"], load: async () => (await import("./features/provider-execution/patches.mjs")).providerExecutionFeature },
  "session-prompt": { requires: [], load: () => import("./features/session-prompt/patches.mjs") },
  "context-notes": { requires: ["session-prompt"], load: () => import("./features/context-notes/patches.mjs") },
  "context-window": { requires: ["context-notes"], load: () => import("./features/context-window/patches.mjs") },
  "prompt-rules": { requires: ["session-prompt"], load: () => import("./features/prompt-rules/feature.mjs") },
  compaction: { requires: [], load: () => import("./features/compaction/feature.mjs") },
  "config-reload": { requires: [], load: () => import("./features/config-reload/feature.mjs") },
  "user-commands-agent": { requires: [], load: async () => (await import("./features/user-commands-agent/feature.mjs")).userCommandsAgentFeature },
  "user-commands-session": { requires: ["session-catalog"], load: async () => (await import("./features/user-commands-session/feature.mjs")).feature },
  "remote-surface": { requires: ["request-run"], load: async () => (await import("./features/remote-surface/feature.mjs")).feature },
  "tui-input": { requires: [], load: () => import("./features/tui-input/patches.mjs") },
  "turn-chrome": { requires: [], load: () => import("./features/turn-chrome/patches.mjs") },
  statusline: { requires: [], load: () => import("./features/statusline/patches.mjs") },
  "startup-chrome": { requires: ["statusline"], load: () => import("./features/startup-chrome/patches.mjs") },
  "tui-autocomplete": { requires: [], load: () => import("./features/tui-autocomplete/patches.mjs") },
  "model-picker": { requires: [], load: () => import("./features/model-picker/patches.mjs") },
  "thinking-levels": { requires: [], load: () => import("./features/thinking-levels/patches.mjs") },
  "transcript-cache": { requires: [], load: () => import("./features/transcript-cache/patches.mjs") },
  "title-guard": { requires: [], load: () => import("./features/title-guard/patches.mjs") },
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
  // 뿌리는 **카탈로그 키 순서**로 돈다. 호출자가 넘긴 순서를 그대로 쓰면 같은
  // 집합을 뒤집어 넘겼을 때만 깨지는 함정이 생긴다 — 예: session-ui 가
  // session-picker 보다 먼저 dist/cli/session-picker.js 를 만져
  // `session-picker:startup-finish` 앵커가 사라진다 (2026-09-20 실측).
  //
  // 순서를 정하는 것은 카탈로그 인덱스가 아니라 `requires` 다. 인덱스로
  // 정렬하면 의존이 무시돼서, session-ui 가 자기보다 뒤에 선언된
  // remote-surface 의 삽입을 못 보고 조용히 건너뛰는 협착이 생긴다 (같은 날
  // 실측). DFS 가 의존을 먼저 넣고, 그 뿌리 순서만 카탈로그가 고정한다.
  const requested = new Set(names);
  for (const name of Object.keys(catalog)) {
    if (requested.has(name)) select(name);
  }
  return Promise.all([...selected].map(async (id) => {
    const { patches, files = [] } = await catalog[id].load();
    if (!Array.isArray(patches) || !Array.isArray(files)) throw new Error(`Invalid Pi feature manifest: ${id}`);
    return { id, patches, files };
  }));
}
