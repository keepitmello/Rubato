import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { senpiNested } from "../../src/engine-paths.mjs";
import {
  ASTRA_CODEX_PRELUDE,
  injectAstraCodex,
  isAstraCodexUrl,
} from "../../src/transforms/misc-astra-codex.mjs";

const { applyAstraConfigurationUpdate, isAstraConfigurationUpdateModel } = new Function(
  `${ASTRA_CODEX_PRELUDE}; return { applyAstraConfigurationUpdate, isAstraConfigurationUpdateModel };`,
)();

const ASTRA = { id: "gpt-6-astra" };
const ASTRA_FAST = { id: "gpt-6-astra-fast", upstreamModelId: "gpt-6-astra" };
const TERRA = { id: "gpt-5.6-terra" };

function body(input = [{ role: "user", content: "hi" }], effort = "low") {
  return { model: "gpt-6-astra", input, reasoning: { effort, summary: "auto" } };
}

function updates(input) {
  return input.filter((item) => item?.type === "configuration_update");
}

function withoutUpdate(input) {
  return input.filter((item) => item?.type !== "configuration_update");
}

function withoutInput(b) {
  const { input: _input, previous_response_id: _prev, ...rest } = b;
  return rest;
}

test("모델 게이트: non-Astra 는 손대지 않는다", () => {
  assert.equal(isAstraConfigurationUpdateModel(ASTRA), true);
  assert.equal(isAstraConfigurationUpdateModel(ASTRA_FAST), true);
  assert.equal(isAstraConfigurationUpdateModel(TERRA), false);
  assert.equal(isAstraConfigurationUpdateModel(undefined), false);
  const b = body();
  const snapshot = JSON.parse(JSON.stringify(b));
  assert.equal(applyAstraConfigurationUpdate(b, TERRA, "s-gate", "high"), b);
  assert.deepEqual(b, snapshot);
});

test("첫 요청은 그대로, effort 변경은 최상위 고정 + update 삽입", () => {
  const first = body();
  applyAstraConfigurationUpdate(first, ASTRA, "s-1", "low");
  assert.equal(updates(first.input).length, 0);
  assert.equal(first.reasoning.effort, "low");

  const second = body(
    [...first.input, { role: "assistant", content: "draft" }, { role: "user", content: "go deeper" }],
    "low",
  );
  applyAstraConfigurationUpdate(second, ASTRA, "s-1", "high");
  assert.equal(second.reasoning.effort, "low");
  const found = updates(second.input);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { type: "configuration_update", reasoning: { effort: "high" } });
  assert.equal(second.input.indexOf(found[0]) + 1, second.input.length - 1);
});

test("같은 effort 반복(툴 루프)에도 update 는 하나만", () => {
  // NOTE: update 아이템은 세션 메시지에 남지 않고 매 빌드마다 새로 파생된다.
  const start = body([{ role: "user", content: "hi" }], "low");
  applyAstraConfigurationUpdate(start, ASTRA, "s-2", "low");
  const loop = body(
    [{ role: "user", content: "hi" }, { role: "assistant", content: "w" }, { role: "user", content: "hi2" }],
    "low",
  );
  applyAstraConfigurationUpdate(loop, ASTRA, "s-2", "high");
  assert.equal(updates(loop.input).length, 1);
  const loop2 = body([...withoutUpdate(loop.input), { role: "assistant", content: "w2" }], "low");
  applyAstraConfigurationUpdate(loop2, ASTRA, "s-2", "high");
  assert.equal(updates(loop2.input).length, 1);
});

test("effort 복귀하면 update 없이 최상위 그대로", () => {
  const start = body([{ role: "user", content: "hi" }], "low");
  applyAstraConfigurationUpdate(start, ASTRA, "s-3", "low");
  const hi = body([...start.input, { role: "user", content: "more" }], "low");
  applyAstraConfigurationUpdate(hi, ASTRA, "s-3", "high");
  assert.equal(updates(hi.input).length, 1);
  const back = body([...withoutUpdate(hi.input), { role: "user", content: "ok" }], "low");
  applyAstraConfigurationUpdate(back, ASTRA, "s-3", "low");
  assert.equal(updates(back.input).length, 0);
  assert.equal(back.reasoning.effort, "low");
});

test("히스토리 축소(컴팩션)는 base 를 다시 고정한다", () => {
  const start = body(
    [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    "low",
  );
  applyAstraConfigurationUpdate(start, ASTRA, "s-4", "low");
  const compacted = body([{ role: "user", content: "c" }], "low");
  applyAstraConfigurationUpdate(compacted, ASTRA, "s-4", "high");
  assert.equal(updates(compacted.input).length, 0);
  assert.equal(compacted.reasoning.effort, "high");
});

test("null/undefined effort 와 user 없는 입력은 안전하게", () => {
  const b = body();
  const snapshot = JSON.parse(JSON.stringify(b));
  applyAstraConfigurationUpdate(b, ASTRA, "s-5", null);
  applyAstraConfigurationUpdate(b, ASTRA, "s-5", undefined);
  assert.deepEqual(b, snapshot);

  const anchor = body([{ role: "user", content: "hi" }], "low");
  applyAstraConfigurationUpdate(anchor, ASTRA, "s-6", "low");
  const noUser = { model: "gpt-6-astra", input: [{ role: "assistant", content: "w" }], reasoning: { effort: "low" } };
  applyAstraConfigurationUpdate(noUser, ASTRA, "s-6", "high");
  const found = updates(noUser.input);
  assert.equal(found.length, 1);
  assert.equal(noUser.input[noUser.input.length - 1], found[0]);
});

test("effort 가 바뀌어도 캐시 델타 비교 대상은 같다", () => {
  const low = body([{ role: "user", content: "hi" }], "low");
  applyAstraConfigurationUpdate(low, ASTRA, "s-7", "low");
  const high = body([{ role: "user", content: "hi" }], "low");
  applyAstraConfigurationUpdate(high, ASTRA, "s-7", "high");
  high.input = withoutUpdate(high.input);
  assert.deepEqual(withoutInput(high), withoutInput(low));
});

test("실제 엔진 소스에 패치가 걸리고 두 번 걸면 던진다", () => {
  const source = readFileSync(
    senpiNested("@earendil-works/pi-ai/dist/api/openai-codex-responses.js"),
    "utf8",
  );
  assert.match(source, /function buildRequestBody\(model, context, options, cacheSessionId/);
  assert.match(source, /if \(options\?\.temperature !== undefined\) \{\n\s+body\.temperature = options\.temperature;\n\s+\}/);
  const next = injectAstraCodex(source);
  assert.match(next, /configuration_update/);
  assert.match(next, /isAstraConfigurationUpdateModel\(model\)/);
  assert.doesNotMatch(next, /if \(options\?\.temperature !== undefined\) \{\n\s+body\.temperature/);
  assert.throws(() => injectAstraCodex(next));
  assert.equal(
    isAstraCodexUrl("file:///x/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"),
    true,
  );
  assert.equal(
    isAstraCodexUrl("file:///x/@earendil-works/pi-ai/dist/api/openai-codex-responses.lazy.js"),
    false,
  );
});
