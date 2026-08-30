import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_PICKER_IDS,
  CODEX_PICKER_IDS,
  XAI_PICKER_IDS,
  keepPickerIds,
  withPickerIds,
} from "../../src/picker-catalog.mjs";

function model(id) {
  return { id, name: id };
}

test("목록 순서로 남고, 없는 id 는 만들지 않는다", () => {
  const kept = keepPickerIds(
    [model("grok-4.3"), model("grok-4.6"), model("grok-4.5")],
    XAI_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), ["grok-4.6"]);
});

test("Anthropic 이전 세대와 dated id 는 빠진다", () => {
  const kept = keepPickerIds(
    [
      model("claude-sonnet-4-5"),
      model("claude-sonnet-5"),
      model("claude-opus-4-8"),
      model("claude-opus-5"),
      model("claude-haiku-4-5-20251001"),
      model("claude-haiku-4-5"),
      model("claude-fable-5"),
    ],
    ANTHROPIC_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [...ANTHROPIC_PICKER_IDS]);
});

test("Codex 피커는 base 묶음 다음 Fast 묶음이다", () => {
  assert.deepEqual([...CODEX_PICKER_IDS], [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol-fast",
    "gpt-5.6-terra-fast",
    "gpt-5.6-luna-fast",
    "gpt-daybreak-blue-latest",
    "gpt-daybreak-blue-latest-fast",
  ]);
});

test("Codex 는 5.6과 Daybreak만 남긴다", () => {
  const kept = keepPickerIds(
    [model("gpt-5.4"), model("gpt-5.6-sol"), model("gpt-5.5"), model("gpt-daybreak-blue-latest")],
    CODEX_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), ["gpt-5.6-sol", "gpt-daybreak-blue-latest"]);
});

test("withPickerIds 는 native filter 뒤에 겹친다", () => {
  const provider = withPickerIds(
    {
      filterModels: (models) => models.filter((entry) => entry.id !== "drop-me"),
    },
    ["keep-me", "drop-me"],
  );
  assert.deepEqual(
    provider.filterModels([model("keep-me"), model("drop-me"), model("other")]).map((entry) => entry.id),
    ["keep-me"],
  );
});
