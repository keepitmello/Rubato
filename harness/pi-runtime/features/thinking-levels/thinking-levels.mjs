const GRADED_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

function wireValue(level, map) {
  const mapped = map?.[level];
  return typeof mapped === "string" ? mapped : level;
}

function allowLevel(model, level, map, { supportsXhigh, supportsMax } = {}) {
  const mapped = map?.[level];
  if (mapped === null) return false;
  if (level === "xhigh") return typeof supportsXhigh === "function" ? supportsXhigh(model) : mapped !== undefined;
  if (level === "max") return typeof supportsMax === "function" ? supportsMax(model) : mapped !== undefined;
  return true;
}

export function supportedThinkingLevels(model, hooks = {}) {
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  const usedWire = new Set();
  const graded = [];
  for (const level of GRADED_LEVELS) {
    if (!allowLevel(model, level, map, hooks)) continue;
    const wire = wireValue(level, map);
    if (usedWire.has(wire)) continue;
    usedWire.add(wire);
    graded.push(level);
  }
  return graded;
}
