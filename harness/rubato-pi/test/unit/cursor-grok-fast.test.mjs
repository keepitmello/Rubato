import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CURSOR_GROK_FAST_NAME,
  cursorGrokFastVariantId,
  pinCursorGrokFastSelection,
  presentCursorGrokFast,
  presentCursorGrokFastModel,
} from "../../src/cursor-grok-fast.mjs";

// selection-descriptor 는 변형 id 를 alias 표에서 푼다. 그 표는 우리가 소유한
// `cursor/model-capabilities.js`(vendored)이고, 런타임에는 이 파일이 pinned pi-ai 의
// 같은 자리를 덮는다. 워크스페이스의 stock 사본을 읽으면 다른 세대의 표를 검사하게
// 된다 — 4.7 부터는 그 표에 grok 행이 없어서 핀이 풀린 것처럼 보인다.
const { resolveCursorSelectionDescriptor } = await import(
  fileURLToPath(new URL("../../../pi-runtime/features/providers/vendor/pi-ai/cursor/selection-descriptor.js", import.meta.url))
);

function grokBase() {
  return {
    id: "grok-4.7",
    name: "Cursor Grok 4.7",
    api: "cursor-agent",
    provider: "cursor",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
    upstreamModelId: "grok-4.7-medium",
    compat: {
      cursorReasoning: {
        capabilityId: "grok-4.7",
        representativeVariantId: "grok-4.7-medium",
      },
    },
  };
}

function grokFast(id) {
  return { id, name: id, api: "cursor-agent", provider: "cursor", reasoning: false, compat: {} };
}

test("피커에는 베이스 하나만 남고 이름이 Fast 다", () => {
  const presented = presentCursorGrokFast([
    { id: "composer-2.5", name: "Composer 2.5", provider: "cursor" },
    grokBase(),
    grokFast("grok-4.7-high-fast"),
    grokFast("grok-4.7-low-fast"),
    grokFast("grok-4.7-xhigh-fast"),
  ]);
  const grok = presented.filter((model) => String(model.id).includes("grok-4.7"));
  assert.equal(grok.length, 1);
  assert.equal(grok[0].id, "grok-4.7");
  assert.equal(grok[0].name, CURSOR_GROK_FAST_NAME);
  assert.deepEqual(grok[0].thinkingLevelMap.high, "high");
  assert.ok(presented.some((model) => model.id === "composer-2.5"));
});

test("베이스가 없고 Fast 변형만 있으면 묶어서 보여 준다", () => {
  const presented = presentCursorGrokFast([
    grokFast("grok-4.7-high-fast"),
    grokFast("grok-4.7-medium-fast"),
  ]);
  assert.equal(presented.length, 1);
  assert.equal(presented[0].id, "grok-4.7");
  assert.equal(presented[0].name, CURSOR_GROK_FAST_NAME);
  assert.equal(presented[0].thinkingLevelMap.high, "high");
  assert.equal(presented[0].thinkingLevelMap.medium, "medium");
  assert.equal(presented[0].thinkingLevelMap.xhigh, null);
});

function presentedGrok(fastIds) {
  return presentCursorGrokFast([grokBase(), ...fastIds.map(grokFast)])[0];
}

test("effort 를 바꾸면 wire id 가 Fast suffix 를 유지한다", () => {
  const model = presentedGrok(["grok-4.7-low-fast", "grok-4.7-medium-fast", "grok-4.7-high-fast", "grok-4.7-xhigh-fast"]);
  assert.equal(
    resolveCursorSelectionDescriptor(grokBase(), { level: "high", source: "explicit" }).modelId,
    "grok-4.7-high",
    "전제: 핀 없으면 effort 가 Fast 를 푼다",
  );

  for (const level of ["low", "medium", "high", "xhigh"]) {
    const { options } = pinCursorGrokFastSelection(model, {
      thinkingSelection: { level, source: "explicit" },
    });
    const resolved = resolveCursorSelectionDescriptor(model, options.thinkingSelection);
    assert.equal(resolved.modelId, cursorGrokFastVariantId(level), level);
    assert.deepEqual(resolved.parameters, []);
  }
});

test("effort 가 없으면 발견한 Fast 중 기본 high 로 고정한다", () => {
  const model = presentedGrok(["grok-4.7-high-fast"]);
  const { options } = pinCursorGrokFastSelection(model, {});
  assert.equal(options.thinkingSelection.legacyVariantId, "grok-4.7-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(model, options.thinkingSelection).modelId,
    "grok-4.7-high-fast",
  );
});

test("catalog 에 Fast 행이 없어도 표시와 pin 은 Fast 다", () => {
  const presented = presentCursorGrokFast([grokBase()]);
  assert.equal(presented[0].name, CURSOR_GROK_FAST_NAME);
  const { options } = pinCursorGrokFastSelection(presented[0], {
    thinkingSelection: { level: "high", source: "explicit" },
  });
  assert.equal(options.thinkingSelection.legacyVariantId, "grok-4.7-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(presented[0], options.thinkingSelection).modelId,
    "grok-4.7-high-fast",
  );
});

test("발견하지 않은 Fast variant id 는 만들지 않는다", () => {
  const model = presentCursorGrokFast([grokFast("grok-4.7-medium-fast")])[0];
  assert.equal(model.id, "grok-4.7");
  assert.equal(model.name, CURSOR_GROK_FAST_NAME);
  assert.equal(model.thinkingLevelMap.high, null);
  assert.equal(model.thinkingLevelMap.medium, "medium");
  assert.equal(model.upstreamModelId, "grok-4.7-medium-fast");
  const { options } = pinCursorGrokFastSelection(model, {
    thinkingSelection: { level: "high", source: "explicit" },
  });
  assert.equal(options.thinkingSelection.legacyVariantId, "grok-4.7-medium-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(model, options.thinkingSelection).modelId,
    "grok-4.7-medium-fast",
  );
});

test("저장분 베이스도 catalog 에 Fast 가 있으면 pin 한다", () => {
  const catalog = [grokBase(), grokFast("grok-4.7-high-fast"), grokFast("grok-4.7-xhigh-fast")];
  const options = { thinkingSelection: { level: "high", source: "explicit" } };
  const { options: pinned } = pinCursorGrokFastSelection(grokBase(), options, catalog);
  assert.equal(pinned.thinkingSelection.legacyVariantId, "grok-4.7-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(grokBase(), pinned.thinkingSelection).modelId,
    "grok-4.7-high-fast",
  );
});

test("저장분 베이스는 catalog 에 없는 Fast id 를 만들지 않는다", () => {
  const catalog = [grokBase(), grokFast("grok-4.7-medium-fast")];
  const { options } = pinCursorGrokFastSelection(
    grokBase(),
    { thinkingSelection: { level: "high", source: "explicit" } },
    catalog,
  );
  assert.equal(options.thinkingSelection.legacyVariantId, "grok-4.7-medium-fast");
});

test("다른 모델은 손대지 않는다", () => {
  const model = { id: "composer-2.5", provider: "cursor" };
  const options = { thinkingSelection: { level: "high", source: "explicit" } };
  assert.deepEqual(pinCursorGrokFastSelection(model, options), { model, options });
});

test("저장분 베이스도 catalog 에 Fast 가 있으면 표시 정체성이 Fast 다", () => {
  const catalog = [grokBase(), grokFast("grok-4.7-high-fast"), grokFast("grok-4.7-medium-fast")];
  const presented = presentCursorGrokFastModel(grokBase(), catalog);
  assert.equal(presented.id, "grok-4.7");
  assert.equal(presented.name, CURSOR_GROK_FAST_NAME);
  assert.ok(presented.compat.cursorGrokFastByLevel.high);
});

test("catalog 에 Fast 행이 없어도 표시 정체성은 Fast 다", () => {
  const presented = presentCursorGrokFastModel(grokBase(), [grokBase()]);
  assert.equal(presented.name, CURSOR_GROK_FAST_NAME);
  assert.equal(presented.compat.cursorGrokFastByLevel.high, "grok-4.7-high-fast");
});

test("묶인 대표 leftover 와 빈 catalog 도 high-fast 로 덮는다", () => {
  const leftover = {
    thinkingSelection: { level: "high", source: "legacy-variant", legacyVariantId: "grok-4.7-medium" },
  };
  const { options } = pinCursorGrokFastSelection(grokBase(), leftover, [grokBase()]);
  assert.equal(options.thinkingSelection.legacyVariantId, "grok-4.7-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(grokBase(), options.thinkingSelection).modelId,
    "grok-4.7-high-fast",
  );
});

test("non-fast variant 모델 id 도 Fast 로 다시 핀다", () => {
  const medium = { ...grokBase(), id: "grok-4.7-medium", name: "grok-4.7-medium" };
  const { options } = pinCursorGrokFastSelection(medium, {
    thinkingSelection: { level: "high", source: "explicit" },
  });
  assert.equal(options.thinkingSelection.legacyVariantId, "grok-4.7-high-fast");
});
