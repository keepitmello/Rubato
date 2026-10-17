import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ANTHROPIC_PICKER_IDS,
  CODEX_PICKER_IDS,
  CODEX_SUB_PICKER_IDS,
  OPENCODE_PICKER_IDS,
  XAI_PICKER_IDS,
  keepPickerIds,
  storedCredentialReader,
  withPickerIds,
  withSubAccountCopies,
} from "../../src/picker-catalog.mjs";

function model(id) {
  return { id, name: id };
}

// 피커 명단의 현재 세대 id 는 `picker-catalog.mjs` 가 소유한다 — 여기서 손으로 적으면
// 세대가 바뀔 때마다 깨진다.
const CURRENT_XAI = XAI_PICKER_IDS[0];
const [CURRENT_FABLE, CURRENT_OPUS, CURRENT_SONNET] = ANTHROPIC_PICKER_IDS;
const [CODEX_SOL, CODEX_LUNA, CODEX_ASTRA, CODEX_DAYBREAK] = CODEX_PICKER_IDS;
const [CODEX_SOL_SUB, CODEX_ASTRA_SUB] = CODEX_SUB_PICKER_IDS;

test("목록 순서로 남고, 없는 id 는 만들지 않는다", () => {
  const kept = keepPickerIds(
    [model("grok-4.3"), model(CURRENT_XAI), model("grok-4.5")],
    XAI_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [...XAI_PICKER_IDS]);
});

test("Anthropic 이전 세대와 dated id 는 빠진다", () => {
  const kept = keepPickerIds(
    [
      model("claude-sonnet-4-5"),
      model("claude-sonnet-5"),
      model("claude-opus-4-8"),
      model(CURRENT_OPUS),
      model(CURRENT_SONNET),
      model("claude-haiku-5-5-20251001"),
      model("claude-haiku-5-5"),
      model("claude-fable-5"),
      model(CURRENT_FABLE),
    ],
    ANTHROPIC_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [...ANTHROPIC_PICKER_IDS]);
});

test("Codex 피커는 base 만 남기고 Fast 는 /fast 다", () => {
  const kept = keepPickerIds(
    [
      model(CODEX_SOL),
      model(`${CODEX_SOL}-fast`),
      model(CODEX_ASTRA),
      model(`${CODEX_ASTRA}-fast`),
      model(`${CODEX_DAYBREAK}-fast`),
    ],
    CODEX_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [CODEX_SOL, CODEX_ASTRA]);
});

test("Codex 는 현재 세대 Sol·Luna·Astra·Daybreak 만 남긴다", () => {
  const kept = keepPickerIds(
    [
      model("gpt-5.4"),
      model("gpt-5.6-sol"),
      model("gpt-5.6-terra"),
      model("gpt-5.5"),
      model(CODEX_SOL),
      model(CODEX_LUNA),
      model(CODEX_ASTRA),
      model(CODEX_DAYBREAK),
    ],
    CODEX_PICKER_IDS,
  );
  assert.deepEqual(kept.map((entry) => entry.id), [
    CODEX_SOL,
    CODEX_LUNA,
    CODEX_ASTRA,
    CODEX_DAYBREAK,
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
    getModels: () => [model(CURRENT_OPUS), model("claude-sonnet-5")],
    filterModels: (models) => models.filter((entry) => entry.id === CURRENT_OPUS),
  });
  assert.deepEqual(provider.filterModels(provider.getModels()).map((entry) => entry.id), [CURRENT_OPUS]);
  assert.deepEqual(
    provider.filterModels(provider.getModels(), { accounts: [{ name: "default" }, { name: "sub" }] }).map((entry) => entry.id),
    [CURRENT_OPUS, `${CURRENT_OPUS}-sub`],
  );
  assert.ok(provider.getModels().some((entry) => entry.id === `${CURRENT_OPUS}-sub`));
});

// A stale second credential slot (a re-login appends one) used to grow `[sub]` rows on any
// provider that was not named in the allowlist. xAI is single-account by design.
test("명단에 없는 프로바이더는 계정이 둘이어도 [sub] 행이 없다", () => {
  const provider = withSubAccountCopies({
    id: "xai",
    getModels: () => [model("grok-4.7")],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "login-2" }] };
  assert.deepEqual(provider.filterModels(provider.getModels(), credential).map((entry) => entry.id), ["grok-4.7"]);
  assert.deepEqual(provider.getModels().map((entry) => entry.id), ["grok-4.7"]);
});

test("Codex [sub] 는 Sol 과 Astra 만 붙는다", () => {
  const provider = withSubAccountCopies({
    id: "openai-codex",
    getModels: () => [model(CODEX_SOL), model(CODEX_LUNA), model(CODEX_ASTRA), model(CODEX_DAYBREAK)],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "sub" }] };
  assert.deepEqual(
    provider.filterModels(provider.getModels(), credential).map((entry) => entry.id),
    [CODEX_SOL, CODEX_LUNA, CODEX_ASTRA, CODEX_DAYBREAK, `${CODEX_SOL_SUB}-sub`, `${CODEX_ASTRA_SUB}-sub`],
  );
  const stored = provider.getModels().map((entry) => entry.id);
  assert.equal(stored.includes(`${CODEX_SOL}-sub`), true);
  assert.equal(stored.includes(`${CODEX_ASTRA}-sub`), true);
  assert.equal(stored.includes(`${CODEX_LUNA}-sub`), false);
  assert.equal(stored.includes(`${CODEX_DAYBREAK}-sub`), false);
});

test("Anthropic [sub] 는 Fable, Opus, Sonnet 만 붙는다", () => {
  const provider = withSubAccountCopies({
    id: "anthropic",
    getModels: () => [model(CURRENT_FABLE), model(CURRENT_OPUS), model(CURRENT_SONNET), model("claude-sonnet-5"), model("claude-haiku-5-5")],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "sub" }] };
  assert.deepEqual(
    provider.filterModels(provider.getModels(), credential).map((entry) => entry.id),
    [
      CURRENT_FABLE, CURRENT_OPUS, CURRENT_SONNET, "claude-sonnet-5", "claude-haiku-5-5",
      `${CURRENT_FABLE}-sub`, `${CURRENT_OPUS}-sub`, `${CURRENT_SONNET}-sub`,
    ],
  );
  const stored = provider.getModels().map((entry) => entry.id);
  assert.equal(stored.includes("claude-sonnet-5-sub"), false);
  assert.equal(stored.includes("claude-haiku-5-5-sub"), false);
});

test("세 번째 계정이 있으면 Anthropic 에 [sub2] 행을 붙인다", () => {
  const provider = withSubAccountCopies({
    id: "anthropic",
    getModels: () => [model(CURRENT_FABLE), model(CURRENT_OPUS), model(CURRENT_SONNET), model("claude-haiku-5-5")],
    filterModels: (models) => models,
  });
  const ids = (accounts) => provider.filterModels(provider.getModels(), { accounts }).map((entry) => entry.id);
  // 계정이 둘이면 [sub2] 는 없다.
  assert.equal(ids([{ name: "default" }, { name: "sub" }]).some((id) => id.endsWith("-sub2")), false);
  // 실제 저장소 모양: 기본·sub·로그인이 붙인 login-2.
  assert.deepEqual(ids([{ name: "default" }, { name: "sub" }, { name: "login-2" }]), [
    CURRENT_FABLE, CURRENT_OPUS, CURRENT_SONNET, "claude-haiku-5-5",
    `${CURRENT_FABLE}-sub`, `${CURRENT_OPUS}-sub`, `${CURRENT_SONNET}-sub`,
    `${CURRENT_FABLE}-sub2`, `${CURRENT_OPUS}-sub2`, `${CURRENT_SONNET}-sub2`,
  ]);
  const opusSub2 = provider.filterModels(provider.getModels(), { accounts: [{ name: "default" }, { name: "sub" }, { name: "sub2" }] })
    .find((entry) => entry.id === `${CURRENT_OPUS}-sub2`);
  assert.equal(opusSub2.name, `${CURRENT_OPUS} [sub2]`);
  assert.ok(provider.getModels().some((entry) => entry.id === `${CURRENT_OPUS}-sub2`));
});

test("Codex 는 계정이 셋이어도 [sub2] 행이 없다", () => {
  const provider = withSubAccountCopies({
    id: "openai-codex",
    getModels: () => [model(CODEX_SOL), model(CODEX_ASTRA)],
    filterModels: (models) => models,
  });
  const credential = { accounts: [{ name: "default" }, { name: "sub" }, { name: "login-2" }] };
  assert.deepEqual(
    provider.filterModels(provider.getModels(), credential).map((entry) => entry.id),
    [CODEX_SOL, CODEX_ASTRA, `${CODEX_SOL}-sub`, `${CODEX_ASTRA}-sub`],
  );
  assert.equal(provider.getModels().some((entry) => entry.id.endsWith("-sub2")), false);
});

// 엔진은 등록 직후 getModels() 를 거르지 않고 피커 스냅샷을 만든다. 계정이 둘인 기기에서
// 그 스냅샷에 [sub2] 가 섞여 T3 와 에이전트 모델 목록에 떴다(2026-10-13).
test("저장된 계정 수만큼만 getModels 에 계정 행을 넣는다", () => {
  const stored = { accounts: [{ name: "login-2" }] };
  const provider = withSubAccountCopies({
    id: "anthropic",
    getModels: () => [model(CURRENT_OPUS), model("claude-haiku-5-5")],
    filterModels: (models) => models,
  }, { readStoredCredential: (providerId) => (providerId === "anthropic" ? stored : null) });
  assert.deepEqual(provider.getModels().map((entry) => entry.id), [CURRENT_OPUS, "claude-haiku-5-5", `${CURRENT_OPUS}-sub`]);

  stored.accounts = [];
  assert.deepEqual(provider.getModels().map((entry) => entry.id), [CURRENT_OPUS, "claude-haiku-5-5"]);

  stored.accounts = [{ name: "sub" }, { name: "login-2" }];
  assert.equal(provider.getModels().some((entry) => entry.id === `${CURRENT_OPUS}-sub2`), true);
});

test("저장분을 모르면 getModels 는 계정 행을 전부 넣는다", () => {
  const provider = withSubAccountCopies({
    id: "anthropic",
    getModels: () => [model(CURRENT_OPUS)],
    filterModels: (models) => models,
  }, { readStoredCredential: () => undefined });
  assert.deepEqual(provider.getModels().map((entry) => entry.id), [CURRENT_OPUS, `${CURRENT_OPUS}-sub`, `${CURRENT_OPUS}-sub2`]);
});

test("storedCredentialReader 는 파일이 바뀔 때 다시 읽고, 깨진 파일엔 직전 값을 쓴다", () => {
  const dir = mkdtempSync(join(tmpdir(), "picker-auth-"));
  const authPath = join(dir, "auth.json");
  try {
    const read = storedCredentialReader(authPath);
    assert.equal(read("anthropic"), null, "파일이 없으면 저장분 없음");
    writeFileSync(authPath, JSON.stringify({ anthropic: { accounts: [{ name: "login-2" }] } }));
    assert.deepEqual(read("anthropic"), { accounts: [{ name: "login-2" }] });
    assert.equal(read("xai"), null);
    writeFileSync(authPath, "{ half written");
    assert.deepEqual(read("anthropic"), { accounts: [{ name: "login-2" }] });
    writeFileSync(authPath, JSON.stringify({ anthropic: { accounts: [] } }));
    assert.deepEqual(read("anthropic"), { accounts: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
