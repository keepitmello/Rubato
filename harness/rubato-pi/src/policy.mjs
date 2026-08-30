export const PIN = Object.freeze({
  engine: "0.1.0",
  senpi: "2026.8.22",
});

export const RUBATO_OWNED_COMPONENTS = Object.freeze([
  "ast-grep",
  "lsp",
  "task",
  "memory",
]);

export const DAG_RUBATO_OWNED_COMPONENTS = Object.freeze(
  RUBATO_OWNED_COMPONENTS.filter((name) => name !== "task"),
);

export const KNOWN_COMPONENTS = Object.freeze([
  "ast-grep",
  "lsp",
  "task",
  "memory",
]);

export function selectComponents(components, allow) {
  const allowed = new Set(allow);
  return components.filter((component) => allowed.has(component.name));
}

export function unexpectedComponents(names) {
  const known = new Set(KNOWN_COMPONENTS);
  return names.filter((name) => !known.has(name));
}
