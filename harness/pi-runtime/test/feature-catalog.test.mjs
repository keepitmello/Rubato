import assert from "node:assert/strict";
import test from "node:test";
import { loadPiFeatures, PI_FEATURE_NAMES } from "../feature-catalog.mjs";

test("catalog adds required tool hooks once before codemode without enabling unrelated features", async () => {
  const features = await loadPiFeatures(["codemode", "reload", "tool-execution", "codemode"]);
  // 뿌리는 카탈로그 키 순서로 돌고, 의존은 DFS 가 먼저 넣는다. 그래서 넘긴 순서를
  // 뒤집어도 결과가 같다 — 이 단언이 그 계약을 고정한다.
  assert.deepEqual(features.map(({ id }) => id), ["reload", "tool-execution", "codemode"]);
  assert.deepEqual(
    (await loadPiFeatures(["tool-execution", "codemode", "reload"])).map(({ id }) => id),
    ["reload", "tool-execution", "codemode"],
  );
  assert.ok(features[0].patches.length > 0);
  assert.ok(features[2].files.length > 0);
  assert.equal(features[2].patches.length, 0);
  assert.equal(PI_FEATURE_NAMES.includes("service-tier"), true);
  assert.deepEqual(await loadPiFeatures([]), []);
});

test("catalog rejects unknown or malformed selections before loading feature code", async () => {
  for (const names of [["reload", "unknown"], ["__proto__"], [null], "reload"]) {
    await assert.rejects(loadPiFeatures(names), /feature/);
  }
});
