import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_PICKER_IDS,
  CODEX_PICKER_IDS,
  OPENCODE_PICKER_IDS,
  XAI_PICKER_IDS,
  keepPickerIds,
  withPickerIds,
  withSubAccountCopies,
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
      model("claude-fable-5-1"),
    ],
    ANTHROPIC_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [...ANTHROPIC_PICKER_IDS]);
});

test("Codex 피커는 base 만 남기고 Fast 는 /fast 다", () => {
  assert.deepEqual([...CODEX_PICKER_IDS], [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-daybreak-blue-latest",
  ]);
  const kept = keepPickerIds(
    [
      model("gpt-5.6-sol"),
      model("gpt-5.6-sol-fast"),
      model("gpt-6-astra"),
      model("gpt-6-astra-fast"),
      model("gpt-daybreak-blue-latest-fast"),
    ],
    CODEX_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), ["gpt-5.6-sol", "gpt-6-astra"]);
});

test("Codex 는 5.6과 Astra, Daybreak만 남긴다", () => {
  const kept = keepPickerIds(
    [
      model("gpt-5.4"),
      model("gpt-5.6-sol"),
      model("gpt-5.5"),
      model("gpt-6-astra"),
      model("gpt-daybreak-blue-latest"),
    ],
    CODEX_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [
    "gpt-5.6-sol",
    "gpt-6-astra",
    "gpt-daybreak-blue-latest",
  ]);
});

test("OpenCode 피커는 Muse Spark 1.3 Contributor Free 만 남긴다", () => {
  assert.deepEqual([...OPENCODE_PICKER_IDS], ["muse-spark-1.3-contributor-free"]);
  const kept = keepPickerIds(
    [model("muse-spark-1.2"), model("muse-spark-1.3-contributor-free"), model("gpt-5.4")],
    OPENCODE_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), ["muse-spark-1.3-contributor-free"]);
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

test("두 번째 계정이 있으면 피커에 [sub] 행을 붙인다", () => {
  const provider = withSubAccountCopies({
    id: "anthropic",
    getModels: () => [model("claude-opus-5"), model("claude-sonnet-5")],
    filterModels: (models) => models.filter((entry) => entry.id === "claude-opus-5"),
  });
  assert.deepEqual(provider.filterModels(provider.getModels()).map((entry) => entry.id), ["claude-opus-5"]);
  assert.deepEqual(
    provider.filterModels(provider.getModels(), { accounts: [{ name: "default" }, { name: "sub" }] }).map((entry) => entry.id),
    ["claude-opus-5", "claude-opus-5-sub"],
  );
  assert.ok(provider.getModels().some((entry) => entry.id === "claude-opus-5-sub"));
});

// A stale second credential slot (a re-login appends one) used to grow `[sub]` rows on any
// provider that was not named in the allowlist. xAI is single-account by design.
test("명단에 없는 프로바이더는 계정이 둘이어도 [sub] 행이 없다", () => {
  const provider = withSubAccountCopies({
    id: "xai",
    getModels: () => [model("grok-4.6")],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "login-2" }] };
  assert.deepEqual(provider.filterModels(provider.getModels(), credential).map((entry) => entry.id), ["grok-4.6"]);
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["grok-4.6"]);
});

test("Codex [sub] 는 Sol 과 Astra 만 붙는다", () => {
  const provider = withSubAccountCopies({
    id: "openai-codex",
    getModels: () => [model("gpt-5.6-sol"), model("gpt-5.6-terra"), model("gpt-5.6-luna"), model("gpt-6-astra"), model("gpt-daybreak-blue-latest")],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "sub" }] };
  assert.deepEqual(
    provider.filterModels(provider.getModels(), credential).map((entry) => entry.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-daybreak-blue-latest", "gpt-5.6-sol-sub", "gpt-6-astra-sub"],
  );
  const stored = provider.getModels().map((entry) => entry.id);
  assert.equal(stored.includes("gpt-5.6-sol-sub"), true);
  assert.equal(stored.includes("gpt-6-astra-sub"), true);
  assert.equal(stored.includes("gpt-5.6-terra-sub"), false);
  assert.equal(stored.includes("gpt-5.6-luna-sub"), false);
  assert.equal(stored.includes("gpt-daybreak-blue-latest-sub"), false);
});

test("Anthropic [sub] 는 Fable 과 Opus 만 붙는다", () => {
  const provider = withSubAccountCopies({
    id: "anthropic",
    getModels: () => [model("claude-fable-5-1"), model("claude-opus-5"), model("claude-sonnet-5"), model("claude-haiku-4-5")],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "sub" }] };
  assert.deepEqual(
    provider.filterModels(provider.getModels(), credential).map((entry) => entry.id),
    ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1-sub", "claude-opus-5-sub"],
  );
  const stored = provider.getModels().map((entry) => entry.id);
  assert.equal(stored.includes("claude-sonnet-5-sub"), false);
  assert.equal(stored.includes("claude-haiku-4-5-sub"), false);
});
