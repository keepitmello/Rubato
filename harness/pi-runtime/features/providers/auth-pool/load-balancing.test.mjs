import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAccountLoadBalancing } from "../provider-switch.mjs";
import { streamWithCredentialPool } from "./runtime-pool.mjs";
import { ANTHROPIC_SUB_PICKER_IDS } from "../../../../rubato-pi/src/picker-catalog.mjs";

test("the saved switch controls real pool routing; manual sub and pin remain authoritative", async () => {
  const home = mkdtempSync(join(tmpdir(), "rb-load-balancing-"));
  try {
    const modelId = ANTHROPIC_SUB_PICKER_IDS[0];
    const authPath = join(home, "auth.json");
    const setupPath = join(home, "setup-token");
    writeFileSync(setupPath, "sk-ant-oat-test\n");
    const credential = { type: "oauth", access: "oauth", refresh: "r", expires: Date.now() + 999_999 };
    const used = [];
    let measurements = 0;
    let primaryExhausted = true;
    const windows = (usedPercent) => [{
      id: "five_hour", usedPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), windowDurationMins: 300,
    }];
    const runtime = {
      credentials: { read: async () => credential, store: { authPath } },
      _rubatoQuotaUsage: async () => {
        measurements++;
        return {
          default: { windows: windows(primaryExhausted ? 20 : 100) },
          "setup-token": { windows: windows(primaryExhausted ? 100 : 20) },
        };
      },
      _rubatoUsageObserver: null,
      prepareRequest: async (model, options) => ({
        model, options,
        provider: { stream: async function* (wired, _context, opts) {
          used.push({ model: wired.id, account: opts.slotName ?? "setup-token" });
          yield { type: "done" };
        } },
      }),
    };
    const call = async (id = modelId) => {
      const stream = await streamWithCredentialPool(runtime, "stream", { provider: "anthropic", id }, {}, {
        sessionId: "same-session",
        env: { HOME: home, RUBATO_CLAUDE_SETUP_TOKEN_FILE: setupPath },
      });
      for await (const _ of stream) { /* drain */ }
    };
    await call();
    assert.equal(used.at(-1).account, "setup-token", "off by default: a plain model uses the primary account");
    assert.equal(measurements, 0, "off performs no automatic quota lookup");
    setAccountLoadBalancing("anthropic", true, { home });
    await call();
    assert.equal(used.at(-1).account, "default", "on sees exhausted primary quota and uses OAuth before another 429");
    assert.equal(measurements, 1);
    primaryExhausted = false;
    await call();
    assert.equal(used.at(-1).account, "setup-token", "the same session re-evaluates both accounts before each request");
    primaryExhausted = true;
    await call(`${modelId}-sub`);
    assert.equal(used.at(-1).account, "default");
    assert.equal(used.at(-1).model, modelId, "wire model never carries the account suffix");
    assert.equal(measurements, 2, "explicit sub bypasses the allocator");
    credential.pinned = "setup-token";
    await call();
    assert.equal(used.at(-1).account, "setup-token", "pin overrides automatic allocation");
    delete credential.pinned;
    setAccountLoadBalancing("anthropic", false, { home });
    await call();
    assert.equal(used.at(-1).account, "setup-token", "switching off immediately restores primary routing");
    await call(`${modelId}-sub`);
    assert.equal(used.at(-1).account, "default");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
