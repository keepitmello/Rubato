// Exposure is independent of execution: discovered tools still run directly,
// through the engine's existing validation, permission and result hooks.
export const CORE_TOOL_NAMES = Object.freeze(["read", "bash", "apply_patch", "todo", "tool_search"]);
const core = new Set(CORE_TOOL_NAMES);
const legacyEditors = new Set(["edit", "write"]);

export function withoutLegacyEditors(names) {
  return names.filter((name) => !legacyEditors.has(name));
}

export function withToolExposure(definition) {
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
