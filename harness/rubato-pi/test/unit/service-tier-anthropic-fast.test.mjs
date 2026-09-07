import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { senpiDir } from "../../src/engine-paths.mjs";
import { injectServiceTier } from "../../src/transforms/core-service-tier.mjs";

const OPUS_5 = { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages" };
const OPUS_4_7 = { provider: "anthropic", id: "claude-opus-4-7", api: "anthropic-messages" };
const OPUS_5_DATED = { provider: "anthropic", id: "claude-opus-5-20260724", api: "anthropic-messages" };
const COPILOT_OPUS_5 = {
  provider: "github-copilot",
  id: "claude-opus-5",
  api: "anthropic-messages",
  baseUrl: "https://api.githubcopilot.com",
};
const CODEX = { provider: "openai-codex", id: "gpt-5.6-sol", api: "openai-codex-responses" };

/**
 * 변환된 확장을 실물로 돌린다. 텍스트만 단언하면 니들은 맞았는데 행동이 틀린 상태를 잡지 못한다.
 *
 * 벤더 파일은 `../../settings-manager.js` 를 상대 경로로 읽으므로, tmp 로 옮기기 전에
 * 그 하나만 절대 file URL 로 바꾼다. node_modules 는 순정으로 둔다.
 */
async function loadTransformedExtension() {
  const source = readFileSync(join(senpiDir, "dist/core/extensions/builtin/service-tier.js"), "utf8");
  const settingsManagerUrl = pathToFileURL(join(senpiDir, "dist/core/settings-manager.js")).href;
  const rewritten = injectServiceTier(source).replace(
    'from "../../settings-manager.js"',
    `from "${settingsManagerUrl}"`,
  );
  const file = join(mkdtempSync(join(tmpdir(), "rubato-anthropic-fast-mod-")), "service-tier.mjs");
  writeFileSync(file, rewritten);
  const module = await import(pathToFileURL(file).href);
  return module.default;
}

const extension = await loadTransformedExtension();

function registry() {
  const models = [OPUS_5, OPUS_4_7, OPUS_5_DATED, CODEX];
  return {
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getServiceTier: () => undefined,
    getUpstreamModelId: (model) => model.id,
  };
}

/** `/fast` 한 세션을 세운다. 반환된 손잡이로 boot → 명령 → 요청까지 순서대로 돌린다. */
function harness({ model = OPUS_5, remembered, serviceTier } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "rubato-anthropic-fast-"));
  if (remembered !== undefined) {
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ modelServiceTiers: { [`${model.provider}/${model.id}`]: remembered } })}\n`,
    );
  }
  const handlers = new Map();
  const fastModes = [];
  const switched = [];
  const notices = [];
  const commands = new Map();
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, spec) => commands.set(name, spec),
    setSessionModel: async (next) => {
      switched.push(next);
      context.model = next;
      return true;
    },
    setSessionFastMode: (enabled) => fastModes.push(enabled),
  };
  extension(pi);
  const context = {
    cwd: agentDir,
    agentDir,
    model,
    serviceTier,
    modelRegistry: registry(),
    isProjectTrusted: () => true,
    ui: { notify: (message, level) => notices.push({ message, level }) },
  };
  return {
    agentDir,
    context,
    fastModes,
    switched,
    notices,
    settings: () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
    start: () => handlers.get("session_start")({}, context),
    fast: (args) => commands.get("fast").handler(args, context),
    select: (next, source = "set") => {
      context.model = next;
      return handlers.get("model_select")({ model: next, source }, context);
    },
    request: (payload) => handlers.get("before_provider_request")({ type: "before_provider_request", payload }, context),
  };
}

const BASE_PAYLOAD = Object.freeze({ model: "claude-opus-5", betas: ["claude-code-20250219"] });

test("/fast on stamps speed and the fast-mode beta on an Opus 5 request", async () => {
  const session = harness();
  await session.start();
  await session.fast("on");

  assert.deepEqual(session.fastModes, [false, true]);
  assert.deepEqual(session.request({ ...BASE_PAYLOAD }), {
    model: "claude-opus-5",
    betas: ["claude-code-20250219", "fast-mode-2026-02-01"],
    speed: "fast",
  });
});

test("/fast on persists the preference so a fresh session starts fast", async () => {
  const session = harness();
  await session.start();
  await session.fast("on");
  assert.equal(session.settings().modelServiceTiers["anthropic/claude-opus-5"], "priority");

  const restarted = harness({ remembered: "priority" });
  await restarted.start();
  assert.deepEqual(restarted.fastModes, [true]);
  assert.deepEqual(restarted.switched, []);
  assert.equal(restarted.request({ ...BASE_PAYLOAD }).speed, "fast");
});

test("fast off leaves the payload untouched", async () => {
  const session = harness({ remembered: "priority" });
  await session.start();
  await session.fast("off");

  assert.equal(session.settings().modelServiceTiers["anthropic/claude-opus-5"], "auto");
  const payload = { ...BASE_PAYLOAD };
  assert.deepEqual(session.request(payload), payload);
});

test("a caller's own speed outranks the session toggle", async () => {
  const session = harness();
  await session.start();
  await session.fast("on");

  const payload = { ...BASE_PAYLOAD, speed: "standard" };
  assert.deepEqual(session.request(payload), payload);
});

test("the beta is never duplicated", async () => {
  const session = harness();
  await session.start();
  await session.fast("on");

  const payload = { ...BASE_PAYLOAD, betas: ["fast-mode-2026-02-01"] };
  assert.deepEqual(session.request(payload).betas, ["fast-mode-2026-02-01"]);
});

test("a dated Opus 5 snapshot is fast-capable", async () => {
  const session = harness({ model: OPUS_5_DATED });
  await session.start();
  await session.fast("on");

  assert.equal(session.request({ ...BASE_PAYLOAD }).speed, "fast");
});

test("Opus 4.7 is refused: the field is a hard 400 there, not a silent downgrade", async () => {
  const session = harness({ model: OPUS_4_7 });
  await session.start();
  await session.fast("on");

  // 거절은 세션 플래그를 다시 쓰지 않는다. boot gate 가 이미 끈 false 하나뿐이다.
  assert.deepEqual(session.fastModes, [false]);
  assert.match(session.notices.at(-1).message, /Claude Opus 5 \/ 4\.8/);
  const payload = { ...BASE_PAYLOAD };
  assert.deepEqual(session.request(payload), payload);
});

test("a gateway that only speaks the Anthropic wire is refused", async () => {
  const session = harness({ model: COPILOT_OPUS_5 });
  await session.start();
  await session.fast("on");

  assert.deepEqual(session.fastModes, [false]);
  const payload = { ...BASE_PAYLOAD };
  assert.deepEqual(session.request(payload), payload);
});

test("switching to a model without fast support turns the session flag off", async () => {
  const session = harness();
  await session.start();
  await session.fast("on");
  await session.select(OPUS_4_7);

  assert.deepEqual(session.fastModes, [false, true, false]);
  const payload = { ...BASE_PAYLOAD };
  assert.deepEqual(session.request(payload), payload);
});

test("switching back to a fast-capable Opus restores it from that model's memory", async () => {
  const session = harness();
  await session.start();
  await session.fast("on");
  await session.select(OPUS_4_7);
  await session.select(OPUS_5);

  assert.deepEqual(session.fastModes, [false, true, false, true]);
  assert.equal(session.request({ ...BASE_PAYLOAD }).speed, "fast");
});

test("a remembered fast-off is not resurrected by switching back", async () => {
  const session = harness({ remembered: "auto" });
  await session.start();
  await session.select(OPUS_4_7);
  await session.select(OPUS_5);

  assert.deepEqual(session.fastModes, [false]);
  const payload = { ...BASE_PAYLOAD };
  assert.deepEqual(session.request(payload), payload);
});

test("Codex keeps its own service-tier wire; no speed field leaks in", async () => {
  const session = harness({ model: CODEX });
  await session.start();
  await session.fast("on");

  const payload = session.request({ model: "gpt-5.6-sol" });
  assert.equal(payload.service_tier, "priority");
  assert.equal(payload.speed, undefined);
});

test("transform text keeps every fast lane in the description and gates", () => {
  const out = injectServiceTier(
    readFileSync(join(senpiDir, "dist/core/extensions/builtin/service-tier.js"), "utf8"),
  );
  assert.match(out, /fast-mode-2026-02-01/);
  assert.match(out, /function isAnthropicFastModel/);
  assert.match(out, /Codex Fast, xAI priority, Claude Opus speed/);
});
