/**
 * Shift+Tab / picker 에 올릴 thinking 칸.
 *
 * 업스트림 `getSupportedThinkingLevels` 는 맵이 `null` 로 막지 않은
 * `off`·`minimal` 을 항상 칸에 넣는다. Rubato 순환은 thinking 단계만 쓴다.
 *
 * 규칙:
 * - `low`/`medium`/`high` 는 기본 칸. 맵이 `null` 이면 뺀다.
 * - `xhigh`/`max` 는 업스트림 `supportsXhigh`/`supportsMax` 를 그대로 따른다.
 * - `off`/`minimal` 은 공식 GPT-5.6 맵에 있어도 칸에 넣지 않는다.
 */

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
