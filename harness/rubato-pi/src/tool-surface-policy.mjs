// Exposure is independent of execution: discovered tools still run directly,
// through the engine's existing validation, permission and result hooks.
export const CORE_TOOL_NAMES = Object.freeze(["read", "bash", "apply_patch", "todo", "tool_search"]);
const core = new Set(CORE_TOOL_NAMES);
const legacyEditors = new Set(["edit", "write"]);

// Prompt hint words and the names the role prompts actually use. Indexed at name-field
// weight, so a query copied from TOOL_GUIDELINES hits the tool it named.
export const SEARCH_HINT_KEYWORDS = Object.freeze({
  Agent: ["agents", "child agent"],
  AgentSend: ["agents"],
  AgentOutput: ["agents"],
  AgentCancel: ["agents"],
  team_create: ["teams"],
  team_send: ["teams"],
  memory: ["memory", "durable facts"],
  memory_apply_patch: ["memory"],
  eval: ["eval", "persistent kernel"],
  lsp_find_references: ["code analysis", "callers", "references"],
  lsp_goto_definition: ["code analysis", "definition"],
  lsp_symbols: ["code analysis"],
  monitor: ["terminal control"],
  bash_output: ["terminal control"],
  bash_input: ["terminal control"],
  bash_resize: ["terminal control"],
  kill_bash: ["terminal control"],
  web_search: ["web"],
  webfetch: ["web"],
});

function withSearchHints(definition) {
  const extra = SEARCH_HINT_KEYWORDS[definition.name];
  if (!extra) return definition;
  return { ...definition, searchKeywords: [...new Set([...(definition.searchKeywords ?? []), ...extra])] };
}

export function withoutLegacyEditors(names) {
  return names.filter((name) => !legacyEditors.has(name));
}

export function withToolExposure(definition) {
  definition = withSearchHints(definition);
  if (definition.name === "apply_patch" && definition.promptGuidelines) {
    definition = { ...definition, promptGuidelines: definition.promptGuidelines.filter((line) =>
      line !== "After apply_patch succeeds, do not re-read the edited files just to confirm the patch applied.") };
  }
  if (legacyEditors.has(definition.name)) {
    return { ...definition, exposure: "search", allowLazyActivation: false };
  }
  // An extension's explicit denial is authoritative, including mode-gated tools.
  if (definition.allowLazyActivation === false) return definition;
  if (core.has(definition.name)) return definition;
  return { ...definition, exposure: "search" };
}
