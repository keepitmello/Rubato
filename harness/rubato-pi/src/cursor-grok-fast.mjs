// Cursor Grok 4.6 을 피커에서 Fast 정체성으로 보여 주고, effort 변경이 Fast 를 유지하게 한다.
//
// pinned catalog-grouping 은 Fast 변형을 thinkingLevelMap 으로 묶지 않는다. 베이스
// `cursor-grok-4.6` 에서 effort 를 바꾸면 suffix 가 `cursor-grok-4.6-high` 로 가서
// Fast 가 풀린다. Fast 행을 따로 고르면 thinkingLevelMap 이 없어 effort 를 못 바꾼다.
//
// 그래서 피커에는 베이스 하나만 남기고 이름을 Fast 로 두며, stream 직전에
// thinkingSelection 을 해당 `*-{level}-fast` legacy variant 로 고정한다.

export const CURSOR_GROK_46_ID = "cursor-grok-4.6";
export const CURSOR_GROK_46_FAST_NAME = "Grok 4.6 Fast";
export const CURSOR_GROK_46_DEFAULT_LEVEL = "high";
const LEVEL_ORDER = Object.freeze(["high", "medium", "low", "xhigh"]);

export const CURSOR_GROK_46_FAST_BY_LEVEL = Object.freeze({
  low: "cursor-grok-4.6-low-fast",
  medium: "cursor-grok-4.6-medium-fast",
  high: "cursor-grok-4.6-high-fast",
  xhigh: "cursor-grok-4.6-xhigh-fast",
});

const FAST_SUFFIX = /-fast$/;
const FAST_VARIANT = /^cursor-grok-4\.6-.+-fast$/;

export function isCursorGrok46Base(model) {
  return model?.provider === "cursor" && model?.id === CURSOR_GROK_46_ID;
}

export function isCursorGrok46FastVariant(model) {
  return model?.provider === "cursor" && FAST_VARIANT.test(model?.id ?? "");
}

export function cursorGrok46FastVariantId(level, byLevel = CURSOR_GROK_46_FAST_BY_LEVEL) {
  return byLevel[level] ?? byLevel[defaultDiscoveredLevel(byLevel)];
}

export function discoveredCursorGrokFastByLevel(fastVariants) {
  const byLevel = {};
  for (const model of fastVariants ?? []) {
    const level = levelFromFastVariant(model.id);
    if (level && CURSOR_GROK_46_FAST_BY_LEVEL[level] === model.id) byLevel[level] = model.id;
  }
  return byLevel;
}

function defaultDiscoveredLevel(byLevel) {
  return LEVEL_ORDER.find((level) => byLevel?.[level]);
}

export function presentCursorGrokFast(models) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const kept = [];
  let base;
  const fastVariants = [];
  for (const model of models) {
    if (isCursorGrok46FastVariant(model) || (model?.provider === "cursor" && model?.id === `${CURSOR_GROK_46_ID}-fast`)) {
      fastVariants.push(model);
      continue;
    }
    if (isCursorGrok46Base(model)) {
      base = model;
      continue;
    }
    kept.push(model);
  }
  const presented = presentBase(base, fastVariants);
  if (presented) kept.push(presented);
  return kept;
}

/**
 * 세션 복원·기본 모델은 getModels() 저장분(cursor-grok-4.6) 그대로 온다.
 * Fast 정체성은 피커 filterModels 에만 있으므로, stream pin 처럼
 * catalog 에서 Fast 변형을 다시 붙여 표시용 객체를 만든다.
 * variant 가 없으면 저장분 그대로 둔다 — catalog 없는데 [fast] 를 붙이지 않는다.
 */
export function presentCursorGrokFastModel(model, catalog, modelId) {
  const stub = cursorGrok46Stub(model, modelId);
  if (!stub) return model;
  const models = Array.isArray(catalog) ? catalog : [];
  const hasBase = models.some(isCursorGrok46Base);
  const presented = presentCursorGrokFast(hasBase ? models : [stub, ...models]);
  return presented.find((entry) => entry?.provider === "cursor" && entry?.id === CURSOR_GROK_46_ID) ?? model;
}

function cursorGrok46Stub(model, modelId) {
  if (isCursorGrok46Base(model)) return model;
  const raw = model?.id ?? modelId;
  if (raw == null) return undefined;
  const text = String(raw);
  const provider = model?.provider ?? (text.includes("/") ? text.split("/")[0] : undefined);
  const id = text.split("/").pop().split(":", 1)[0];
  if (id !== CURSOR_GROK_46_ID) return undefined;
  if (provider && provider !== "cursor") return undefined;
  return { ...(model ?? {}), id, provider: "cursor" };
}

function presentBase(base, fastVariants) {
  const byLevel = discoveredCursorGrokFastByLevel(fastVariants);
  const representative = cursorGrok46FastVariantId(CURSOR_GROK_46_DEFAULT_LEVEL, byLevel);
  if (!representative) return base;
  const template = fastVariants.find((model) => model.id === representative) ?? base ?? fastVariants[0];
  if (!template) return undefined;
  return {
    ...template,
    id: CURSOR_GROK_46_ID,
    name: CURSOR_GROK_46_FAST_NAME,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: byLevel.low ? "low" : null,
      medium: byLevel.medium ? "medium" : null,
      high: byLevel.high ? "high" : null,
      xhigh: byLevel.xhigh ? "xhigh" : null,
      max: null,
    },
    upstreamModelId: representative,
    compat: {
      ...(template.compat ?? {}),
      cursorGrokFastByLevel: byLevel,
      cursorReasoning: {
        capabilityId: CURSOR_GROK_46_ID,
        representativeVariantId: representative,
      },
    },
  };
}

export function resolveCursorGrokFastByLevel(model, catalog) {
  const attached = model?.compat?.cursorGrokFastByLevel;
  if (attached && defaultDiscoveredLevel(attached)) return attached;
  return discoveredCursorGrokFastByLevel((catalog ?? []).filter(isCursorGrok46FastVariant));
}

export function pinCursorGrokFastSelection(model, options = {}, catalog) {
  if (!isCursorGrok46Base(model)) return { model, options };
  const byLevel = resolveCursorGrokFastByLevel(model, catalog);
  if (!defaultDiscoveredLevel(byLevel)) return { model, options };
  const selection = options.thinkingSelection;
  const alreadyFast = typeof selection?.legacyVariantId === "string" && FAST_SUFFIX.test(selection.legacyVariantId);
  const requested = byLevel[selection?.level]
    ? selection.level
    : alreadyFast
      ? levelFromFastVariant(selection.legacyVariantId)
      : CURSOR_GROK_46_DEFAULT_LEVEL;
  const level = byLevel[requested] ? requested : defaultDiscoveredLevel(byLevel);
  const legacyVariantId = byLevel[level];
  if (!legacyVariantId) return { model, options };
  if (alreadyFast && selection.legacyVariantId === legacyVariantId && selection.level === level) {
    return { model, options };
  }
  return {
    model,
    options: {
      ...options,
      thinkingSelection: {
        level,
        source: "legacy-variant",
        legacyVariantId,
      },
    },
  };
}

function levelFromFastVariant(id) {
  const match = String(id).match(/^cursor-grok-4\.6-(low|medium|high|xhigh)-fast$/);
  return match?.[1] ?? CURSOR_GROK_46_DEFAULT_LEVEL;
}
