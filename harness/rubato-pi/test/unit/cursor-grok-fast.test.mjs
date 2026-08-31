import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  CURSOR_GROK_46_FAST_NAME,
  cursorGrok46FastVariantId,
  pinCursorGrokFastSelection,
  presentCursorGrokFast,
  presentCursorGrokFastModel,
} from "../../src/cursor-grok-fast.mjs";
import { senpiNested } from "../../src/engine-paths.mjs";

const piAi = (...segments) => pathToFileURL(join(senpiNested("@earendil-works/pi-ai"), ...segments)).href;
const { resolveCursorSelectionDescriptor } = await import(piAi("dist/cursor/selection-descriptor.js"));

function grokBase() {
  return {
    id: "cursor-grok-4.6",
    name: "Cursor Grok 4.6",
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
    upstreamModelId: "cursor-grok-4.6-medium",
    compat: {
      cursorReasoning: {
        capabilityId: "cursor-grok-4.6",
        representativeVariantId: "cursor-grok-4.6-medium",
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
    grokFast("cursor-grok-4.6-high-fast"),
    grokFast("cursor-grok-4.6-low-fast"),
    grokFast("cursor-grok-4.6-xhigh-fast"),
  ]);
  const grok = presented.filter((model) => String(model.id).includes("grok-4.6"));
  assert.equal(grok.length, 1);
  assert.equal(grok[0].id, "cursor-grok-4.6");
  assert.equal(grok[0].name, CURSOR_GROK_46_FAST_NAME);
  assert.deepEqual(grok[0].thinkingLevelMap.high, "high");
  assert.ok(presented.some((model) => model.id === "composer-2.5"));
});

test("베이스가 없고 Fast 변형만 있으면 묶어서 보여 준다", () => {
  const presented = presentCursorGrokFast([
    grokFast("cursor-grok-4.6-high-fast"),
    grokFast("cursor-grok-4.6-medium-fast"),
  ]);
  assert.equal(presented.length, 1);
  assert.equal(presented[0].id, "cursor-grok-4.6");
  assert.equal(presented[0].name, CURSOR_GROK_46_FAST_NAME);
  assert.equal(presented[0].thinkingLevelMap.high, "high");
  assert.equal(presented[0].thinkingLevelMap.medium, "medium");
  assert.equal(presented[0].thinkingLevelMap.xhigh, null);
});

function presentedGrok(fastIds) {
  return presentCursorGrokFast([grokBase(), ...fastIds.map(grokFast)])[0];
}

test("effort 를 바꾸면 wire id 가 Fast suffix 를 유지한다", () => {
  const model = presentedGrok(["cursor-grok-4.6-low-fast", "cursor-grok-4.6-medium-fast", "cursor-grok-4.6-high-fast", "cursor-grok-4.6-xhigh-fast"]);
  assert.equal(
    resolveCursorSelectionDescriptor(grokBase(), { level: "high", source: "explicit" }).modelId,
    "cursor-grok-4.6-high",
    "전제: 핀 없으면 effort 가 Fast 를 푼다",
  );

  for (const level of ["low", "medium", "high", "xhigh"]) {
    const { options } = pinCursorGrokFastSelection(model, {
      thinkingSelection: { level, source: "explicit" },
    });
    const resolved = resolveCursorSelectionDescriptor(model, options.thinkingSelection);
    assert.equal(resolved.modelId, cursorGrok46FastVariantId(level), level);
    assert.deepEqual(resolved.parameters, []);
  }
});

test("effort 가 없으면 발견한 Fast 중 기본 high 로 고정한다", () => {
  const model = presentedGrok(["cursor-grok-4.6-high-fast"]);
  const { options } = pinCursorGrokFastSelection(model, {});
  assert.equal(options.thinkingSelection.legacyVariantId, "cursor-grok-4.6-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(model, options.thinkingSelection).modelId,
    "cursor-grok-4.6-high-fast",
  );
});

test("catalog 에 Fast 행이 없어도 표시와 pin 은 Fast 다", () => {
  const presented = presentCursorGrokFast([grokBase()]);
  assert.equal(presented[0].name, CURSOR_GROK_46_FAST_NAME);
  const { options } = pinCursorGrokFastSelection(presented[0], {
    thinkingSelection: { level: "high", source: "explicit" },
  });
  assert.equal(options.thinkingSelection.legacyVariantId, "cursor-grok-4.6-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(presented[0], options.thinkingSelection).modelId,
    "cursor-grok-4.6-high-fast",
  );
});

test("발견하지 않은 Fast variant id 는 만들지 않는다", () => {
  const model = presentCursorGrokFast([grokFast("cursor-grok-4.6-medium-fast")])[0];
  assert.equal(model.id, "cursor-grok-4.6");
  assert.equal(model.name, CURSOR_GROK_46_FAST_NAME);
  assert.equal(model.thinkingLevelMap.high, null);
  assert.equal(model.thinkingLevelMap.medium, "medium");
  assert.equal(model.upstreamModelId, "cursor-grok-4.6-medium-fast");
  const { options } = pinCursorGrokFastSelection(model, {
    thinkingSelection: { level: "high", source: "explicit" },
  });
  assert.equal(options.thinkingSelection.legacyVariantId, "cursor-grok-4.6-medium-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(model, options.thinkingSelection).modelId,
    "cursor-grok-4.6-medium-fast",
  );
});

test("저장분 베이스도 catalog 에 Fast 가 있으면 pin 한다", () => {
  const catalog = [grokBase(), grokFast("cursor-grok-4.6-high-fast"), grokFast("cursor-grok-4.6-xhigh-fast")];
  const options = { thinkingSelection: { level: "high", source: "explicit" } };
  const { options: pinned } = pinCursorGrokFastSelection(grokBase(), options, catalog);
  assert.equal(pinned.thinkingSelection.legacyVariantId, "cursor-grok-4.6-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(grokBase(), pinned.thinkingSelection).modelId,
    "cursor-grok-4.6-high-fast",
  );
});

test("저장분 베이스는 catalog 에 없는 Fast id 를 만들지 않는다", () => {
  const catalog = [grokBase(), grokFast("cursor-grok-4.6-medium-fast")];
  const { options } = pinCursorGrokFastSelection(
    grokBase(),
    { thinkingSelection: { level: "high", source: "explicit" } },
    catalog,
  );
  assert.equal(options.thinkingSelection.legacyVariantId, "cursor-grok-4.6-medium-fast");
});

test("다른 모델은 손대지 않는다", () => {
  const model = { id: "composer-2.5", provider: "cursor" };
  const options = { thinkingSelection: { level: "high", source: "explicit" } };
  assert.deepEqual(pinCursorGrokFastSelection(model, options), { model, options });
});

test("저장분 베이스도 catalog 에 Fast 가 있으면 표시 정체성이 Fast 다", () => {
  const catalog = [grokBase(), grokFast("cursor-grok-4.6-high-fast"), grokFast("cursor-grok-4.6-medium-fast")];
  const presented = presentCursorGrokFastModel(grokBase(), catalog);
  assert.equal(presented.id, "cursor-grok-4.6");
  assert.equal(presented.name, CURSOR_GROK_46_FAST_NAME);
  assert.ok(presented.compat.cursorGrokFastByLevel.high);
});

test("catalog 에 Fast 행이 없어도 표시 정체성은 Fast 다", () => {
  const presented = presentCursorGrokFastModel(grokBase(), [grokBase()]);
  assert.equal(presented.name, CURSOR_GROK_46_FAST_NAME);
  assert.equal(presented.compat.cursorGrokFastByLevel.high, "cursor-grok-4.6-high-fast");
});

test("묶인 대표 leftover 와 빈 catalog 도 high-fast 로 덮는다", () => {
  const leftover = {
    thinkingSelection: { level: "high", source: "legacy-variant", legacyVariantId: "cursor-grok-4.6-medium" },
  };
  const { options } = pinCursorGrokFastSelection(grokBase(), leftover, [grokBase()]);
  assert.equal(options.thinkingSelection.legacyVariantId, "cursor-grok-4.6-high-fast");
  assert.equal(
    resolveCursorSelectionDescriptor(grokBase(), options.thinkingSelection).modelId,
    "cursor-grok-4.6-high-fast",
  );
});

test("non-fast variant 모델 id 도 Fast 로 다시 핀다", () => {
  const medium = { ...grokBase(), id: "cursor-grok-4.6-medium", name: "cursor-grok-4.6-medium" };
  const { options } = pinCursorGrokFastSelection(medium, {
    thinkingSelection: { level: "high", source: "explicit" },
  });
  assert.equal(options.thinkingSelection.legacyVariantId, "cursor-grok-4.6-high-fast");
});
