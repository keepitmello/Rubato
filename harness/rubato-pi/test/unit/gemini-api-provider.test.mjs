import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { gemini4HydrogenModels } from "../../src/provider-direct.mjs";
import { SUPPORTED_PROVIDER_IDS, foreignProviderIds } from "../../src/provider-ids.mjs";
import { ensureModelsConfig } from "../../src/session-defaults.mjs";
import {
  GEMINI_KEYCHAIN_SERVICE,
  GEMINI_PROVIDER_ID,
  readGeminiKeychainSecret,
  withGeminiKeychain,
} from "../../src/gemini-keychain.mjs";

// Gemini API 레인(google)은 eeeabf1e8 에서 직결 목록에서 빠졌다. 남은 시험은 아직 있는
// Hydrogen 파생과 Keychain 도우미만 본다.
const HYDROGEN_ID = "gemini-4-hydrogen";
const noEnvCtx = { env: async () => undefined, fileExists: async () => false };

function fakeSpawn(calls, { stdout = "", code = 0 } = {}) {
  return (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  };
}

test("google 은 더 이상 지원 레인이 아니라 foreign 으로 꺼진다", () => {
  assert.equal(SUPPORTED_PROVIDER_IDS.includes(GEMINI_PROVIDER_ID), false);
  assert.equal(foreignProviderIds().includes(GEMINI_PROVIDER_ID), true);
  const next = ensureModelsConfig("/tmp/agent", {
    exists: () => true,
    readFile: () => JSON.stringify({ providers: {}, disabledProviders: [GEMINI_PROVIDER_ID, "vercel-ai-gateway"] }),
    writeFile: () => {},
  });
  assert.ok(next.disabledProviders.includes(GEMINI_PROVIDER_ID));
  assert.ok(next.disabledProviders.includes("vercel-ai-gateway"));
});

test("Hydrogen 파생은 pin 이 앞서면 비고, 틀이 없으면 조용히 넘어가지 않는다", () => {
  assert.deepEqual(gemini4HydrogenModels([{ id: HYDROGEN_ID }, { id: "gemini-3.8-flash" }]), []);
  assert.throws(() => gemini4HydrogenModels([{ id: "gemini-3.7-flash" }]), /gemini-3\.8-flash/);
});

test("Keychain 은 서비스 gemini 로 찾고, 없으면 undefined 다", async () => {
  const calls = [];
  assert.equal(await readGeminiKeychainSecret({ spawnImpl: fakeSpawn(calls, { stdout: "secret\n" }) }), "secret");
  assert.deepEqual(calls, [["security", "find-generic-password", "-s", GEMINI_KEYCHAIN_SERVICE, "-w"]]);
  assert.equal(await readGeminiKeychainSecret({ spawnImpl: fakeSpawn([], { code: 44 }) }), undefined);
});

test("Keychain 조회 실패는 unavailable, 취소는 던진다", async () => {
  const native = { auth: { apiKey: { resolve: async () => undefined } } };
  const broken = withGeminiKeychain(native, { keychainLookup: async () => { throw new Error("locked"); } });
  assert.equal(await broken.auth.apiKey.resolve({ ctx: noEnvCtx }), undefined);

  const controller = new AbortController();
  controller.abort();
  const aborting = withGeminiKeychain(native, {
    keychainLookup: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
  });
  await assert.rejects(aborting.auth.apiKey.resolve({ ctx: noEnvCtx, signal: controller.signal }), /aborted/);
});
