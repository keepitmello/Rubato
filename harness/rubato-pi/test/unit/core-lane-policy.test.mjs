import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { senpiDir } from "../../src/engine-paths.mjs";
import {
  injectCompactionIndexReason,
  injectLanePolicy,
  isCompactionIndexUrl,
  isLanePolicyUrl,
} from "../../src/transforms/core-lane-policy.mjs";
import { ANTHROPIC_SERVER_COMPACTION_MODEL_IDS } from "../../src/anthropic-server-compaction.mjs";

const LANE_POLICY = join(senpiDir, "dist/core/extensions/builtin/compaction/lane-policy.js");
const INDEX = join(senpiDir, "dist/core/extensions/builtin/compaction/index.js");

test("url matchers pick the builtin compaction lane files only", () => {
  assert.equal(isLanePolicyUrl(pathToFileURL(LANE_POLICY).href), true);
  assert.equal(isCompactionIndexUrl(pathToFileURL(INDEX).href), true);
  assert.equal(isLanePolicyUrl(pathToFileURL(INDEX).href), false);
  assert.equal(isCompactionIndexUrl(pathToFileURL(LANE_POLICY).href), false);
});

test("lane-policy transform declares server-compaction models as external owners", async () => {
  const pristine = readFileSync(LANE_POLICY, "utf8");
  const patched = injectLanePolicy(pristine);
  assert.notEqual(patched, pristine);
  assert.throws(() => injectLanePolicy(patched));
  for (const id of ANTHROPIC_SERVER_COMPACTION_MODEL_IDS) assert.ok(patched.includes(`"${id}"`));

  // 실제로 평가해 본다: SDK import 는 빈 stub 으로 바꾼다.
  const dir = mkdtempSync(join(tmpdir(), "rubato-lane-policy-"));
  const evaluable = patched
    .replace(/import \{ CLAUDE_SDK_OAUTH_PROVIDER_ID \} from "[^"]+";/, 'const CLAUDE_SDK_OAUTH_PROVIDER_ID = "claude-sdk-oauth";')
    .replace(/import \{ loadClaudeSdkOauthProviderSettingsFromDisk \} from "[^"]+";/, "const loadClaudeSdkOauthProviderSettingsFromDisk = () => ({ resumeMode: \"off\" });");
  const file = join(dir, "lane-policy.mjs");
  writeFileSync(file, evaluable);
  const mod = await import(pathToFileURL(file).href);
  const policy = mod.createCompactionLanePolicy();
  for (const id of ANTHROPIC_SERVER_COMPACTION_MODEL_IDS) {
    assert.equal(policy.disablesSenpiCompaction({ model: { provider: "anthropic", id }, cwd: dir }), true, id);
  }
  assert.equal(policy.disablesSenpiCompaction({ model: { provider: "anthropic", id: "claude-haiku-4-5" }, cwd: dir }), false);
  assert.equal(policy.disablesSenpiCompaction({ model: { provider: "xai", id: "grok-4.6" }, cwd: dir }), false);
  assert.equal(policy.disablesSenpiCompaction({ model: { provider: "cursor", id: "claude-opus-5" }, cwd: dir }), false);
  assert.match(mod.laneRejectionReason({ provider: "anthropic", id: "claude-fable-5-1" }), /Anthropic server compaction/);
  assert.match(mod.laneRejectionReason({ provider: "claude-sdk-oauth", id: "x" }), /Claude Agent SDK/);
  // 수동 /compact 만 서버 컴팩션 모델에서 통과한다; SDK 레인은 그대로 막힌다.
  assert.equal(mod.laneAllowsManualCompaction({ provider: "anthropic", id: "claude-fable-5-1" }, "manual"), true);
  assert.equal(mod.laneAllowsManualCompaction({ provider: "anthropic", id: "claude-fable-5-1" }, "threshold"), false);
  assert.equal(mod.laneAllowsManualCompaction({ provider: "claude-sdk-oauth", id: "x" }, "manual"), false);
  // 적용 표시가 붙어야 와이어가 켜진다.
  assert.equal(globalThis[Symbol.for("rubato.anthropicServerCompaction.lane")], true);
});

test("compaction index transform routes the rejection reason through the lane", () => {
  const pristine = readFileSync(INDEX, "utf8");
  const patched = injectCompactionIndexReason(pristine);
  assert.notEqual(patched, pristine);
  assert.throws(() => injectCompactionIndexReason(patched));
  assert.ok(patched.includes("reason: laneRejectionReason(ctx.model)"));
  assert.ok(patched.includes("&& !laneAllowsManualCompaction(ctx.model, event.reason)"));
  assert.ok(!patched.includes("SDK_NATIVE_LANE_REJECTION_REASON"));
});
