import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import serviceTierExtension from "../../../../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/service-tier.js";

const base = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  api: "openai-codex-responses",
};
const fast = { ...base, id: `${base.id}-fast` };

function registry() {
  return {
    find: (_provider, id) => id === base.id ? base : id === fast.id ? fast : undefined,
    getServiceTier: (model) => model.id === fast.id ? "priority" : undefined,
    getUpstreamModelId: () => base.id,
  };
}

async function startWithRememberedTier(tier) {
  const agentDir = mkdtempSync(join(tmpdir(), "rubato-fast-default-"));
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ modelServiceTiers: { [`${base.provider}/${base.id}`]: tier } })}\n`,
  );
  const handlers = new Map();
  const switched = [];
  const fastModes = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    setSessionModel: async (model) => {
      switched.push(model);
      return true;
    },
    setSessionFastMode: (enabled) => fastModes.push(enabled),
  };
  serviceTierExtension(pi);
  const context = {
    cwd: agentDir,
    agentDir,
    model: fast,
    serviceTier: "priority",
    modelRegistry: registry(),
    isProjectTrusted: () => true,
  };
  await handlers.get("session_start")({}, context);
  return { agentDir, context, handlers, switched, fastModes };
}

test("remembered fast defaults keep their exact catalog identity on a fresh session", async () => {
  const result = await startWithRememberedTier("priority");

  assert.deepEqual(result.switched, []);
  assert.deepEqual(result.fastModes, [true]);
});

test("an explicit remembered fast-off still normalizes a fast alias to its base", async () => {
  const result = await startWithRememberedTier("auto");

  assert.deepEqual(result.switched, [base]);
  assert.deepEqual(result.fastModes, [false]);
});

for (const source of ["set", "cycle"]) {
  test(`${source} selection of a fast alias overrides remembered fast-off`, async () => {
    const result = await startWithRememberedTier("auto");

    await result.handlers.get("model_select")({ model: fast, source }, result.context);

    const settings = JSON.parse(readFileSync(join(result.agentDir, "settings.json"), "utf8"));
    assert.equal(settings.modelServiceTiers[`${base.provider}/${base.id}`], "priority");
    assert.deepEqual(result.fastModes, [false, true]);
  });
}
