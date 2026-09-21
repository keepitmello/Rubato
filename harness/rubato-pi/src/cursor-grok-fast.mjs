// Cursor Grok 은 Rubato 에서 Fast 만 나간다. 피커·task·격리 child 모두 같다.
//
// pinned catalog-grouping 은 Fast 변형을 thinkingLevelMap 으로 묶지 않는다. 베이스
// `grok-4.7` 에서 effort 를 바꾸면 suffix 가 `grok-4.7-high` 로 가서 Fast 가 풀린다.
// Fast 행을 따로 고르면 thinkingLevelMap 이 없어 effort 를 못 바꾼다.
// 저장분·task 는 묶인 대표 `grok-4.7-medium` 을 leftover 로 들고 오기도 한다.
// catalog 에 Fast 행이 없으면 예전 pin 은 조용히 no-op 가 되어 non-fast 가 나갔다.
//
// 피커에는 베이스 하나만 남기고 이름을 Fast 로 두며, stream 직전에 thinkingSelection
// 을 해당 `*-{level}-fast` 로 고정한다. catalog 가 비어 있어도 알려진 Fast id 로
// 고정한다 — non-fast 가 나갈 수 있는 상태를 만들지 않는다.
//
// **버전은 이름이 아니라 값 하나가 소유한다.** Cursor 는 4.6→4.7 에서 네임스페이스까지
// 바꿨다 — `cursor-grok-4.6-*` 가 `grok-4.7-*` 가 됐다. 그래서 Fast id 와 정규식을
// 리터럴로 늘어놓지 않고 `CURSOR_GROK_ID` 에서 파생한다. 다음 세대는 여기 한 줄이다.

export const CURSOR_GROK_ID = "grok-4.7";
export const CURSOR_GROK_FAST_NAME = "Grok 4.7 Fast";
export const CURSOR_GROK_DEFAULT_LEVEL = "high";
const LEVEL_ORDER = Object.freeze(["high", "medium", "low", "xhigh"]);

/** id 를 정규식에 넣기 전에 메타문자를 막는다. 지금 값에는 없지만 파생의 전제다. */
const GROK_ID_PATTERN = CURSOR_GROK_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const CURSOR_GROK_FAST_BY_LEVEL = Object.freeze(
  Object.fromEntries(
    ["low", "medium", "high", "xhigh"].map((level) => [level, `${CURSOR_GROK_ID}-${level}-fast`]),
  ),
);

const FAST_SUFFIX = /-fast$/;
const FAST_VARIANT = new RegExp(`^${GROK_ID_PATTERN}-.+-fast$`);
const GROK_LEVEL = new RegExp(`^${GROK_ID_PATTERN}-(low|medium|high|xhigh)(?:-fast)?$`);
const LEVEL_FROM_FAST = new RegExp(`^${GROK_ID_PATTERN}-(low|medium|high|xhigh)-fast$`);

export function isCursorGrokBase(model) {
  return model?.provider === "cursor" && model?.id === CURSOR_GROK_ID;
}

export function isCursorGrokFastVariant(model) {
  return model?.provider === "cursor" && FAST_VARIANT.test(model?.id ?? "");
}

/** 피커 베이스, leftover 대표, Fast/non-fast variant. 전부 Fast pin 대상이다. */
export function isCursorGrokIdentity(model) {
  if (model?.provider !== "cursor") return false;
  const id = model?.id ?? "";
  return id === CURSOR_GROK_ID || id === `${CURSOR_GROK_ID}-fast` || GROK_LEVEL.test(id);
}

export function cursorGrokFastVariantId(level, byLevel = CURSOR_GROK_FAST_BY_LEVEL) {
  return byLevel[level] ?? byLevel[defaultDiscoveredLevel(byLevel)];
}

export function discoveredCursorGrokFastByLevel(fastVariants) {
  const byLevel = {};
  for (const model of fastVariants ?? []) {
    const level = levelFromFastVariant(model.id);
    if (level && CURSOR_GROK_FAST_BY_LEVEL[level] === model.id) byLevel[level] = model.id;
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
    if (isCursorGrokFastVariant(model) || (model?.provider === "cursor" && model?.id === `${CURSOR_GROK_ID}-fast`)) {
      fastVariants.push(model);
      continue;
    }
    if (isCursorGrokBase(model)) {
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
 * 세션 복원·기본 모델은 getModels() 저장분(grok-4.7) 그대로 온다.
 * Fast 정체성은 피커 filterModels 에만 있으므로, stream pin 처럼
 * catalog 에서 Fast 변형을 다시 붙여 표시용 객체를 만든다.
 * catalog 가 비어도 Fast 로 표시한다 — wire 가 Fast 로 나가기 때문이다.
 */
export function presentCursorGrokFastModel(model, catalog, modelId) {
  const stub = cursorGrokStub(model, modelId);
  if (!stub) return model;
  const models = Array.isArray(catalog) ? catalog : [];
  const hasBase = models.some(isCursorGrokBase);
  const presented = presentCursorGrokFast(hasBase ? models : [stub, ...models]);
  return presented.find((entry) => entry?.provider === "cursor" && entry?.id === CURSOR_GROK_ID) ?? model;
}

function cursorGrokStub(model, modelId) {
  if (isCursorGrokBase(model)) return model;
  const raw = model?.id ?? modelId;
  if (raw == null) return undefined;
  const text = String(raw);
  const provider = model?.provider ?? (text.includes("/") ? text.split("/")[0] : undefined);
  const id = text.split("/").pop().split(":", 1)[0];
  if (id !== CURSOR_GROK_ID) return undefined;
  if (provider && provider !== "cursor") return undefined;
  return { ...(model ?? {}), id, provider: "cursor" };
}

function presentBase(base, fastVariants) {
  const discovered = discoveredCursorGrokFastByLevel(fastVariants);
  const byLevel = defaultDiscoveredLevel(discovered) ? discovered : { ...CURSOR_GROK_FAST_BY_LEVEL };
  const representative = cursorGrokFastVariantId(CURSOR_GROK_DEFAULT_LEVEL, byLevel);
  if (!representative) return base;
  const template = fastVariants.find((model) => model.id === representative) ?? base ?? fastVariants[0];
  if (!template) return undefined;
  return {
    ...template,
    id: CURSOR_GROK_ID,
    name: CURSOR_GROK_FAST_NAME,
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
        capabilityId: CURSOR_GROK_ID,
        representativeVariantId: representative,
      },
    },
  };
}

export function resolveCursorGrokFastByLevel(model, catalog) {
  const attached = model?.compat?.cursorGrokFastByLevel;
  if (attached && defaultDiscoveredLevel(attached)) return attached;
  const models = Array.isArray(catalog) ? catalog : [];
  const discovered = discoveredCursorGrokFastByLevel(models.filter(isCursorGrokFastVariant));
  if (defaultDiscoveredLevel(discovered)) return discovered;
  return CURSOR_GROK_FAST_BY_LEVEL;
}

export function pinCursorGrokFastSelection(model, options = {}, catalog) {
  if (!isCursorGrokIdentity(model)) return { model, options };
  const byLevel = resolveCursorGrokFastByLevel(model, catalog);
  if (!defaultDiscoveredLevel(byLevel)) return { model, options };
  const selection = options.thinkingSelection;
  const alreadyFast = typeof selection?.legacyVariantId === "string" && FAST_SUFFIX.test(selection.legacyVariantId);
  const requested = byLevel[selection?.level]
    ? selection.level
    : alreadyFast
      ? levelFromFastVariant(selection.legacyVariantId)
      : CURSOR_GROK_DEFAULT_LEVEL;
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
  const match = String(id).match(LEVEL_FROM_FAST);
  return match?.[1] ?? CURSOR_GROK_DEFAULT_LEVEL;
}
