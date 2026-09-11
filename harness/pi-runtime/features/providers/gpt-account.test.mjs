import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { providersFeature } from "./patches.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";
import { createGptAccountExtension, GPT_ACCOUNT_FACTORY_NAME, OPENAI_CODEX_PROVIDER_ID } from "./auth-pool/gpt-account.mjs";
import { listSlots } from "./auth-pool/slots.mjs";

const sourceRuntimeRoot = join(import.meta.dirname, "../..");
const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-gpt-account-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const staged = await stagePiRuntime({
  sourceRoot: sourceRuntimeRoot,
  outputRoot: join(scratchRoot, "runtime"),
  features: [providersFeature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(join(runtime.codingAgentDir, "dist/index.js")).href);

function mockCodexProvider() {
  const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    id: OPENAI_CODEX_PROVIDER_ID,
    name: "OpenAI Codex",
    models: [{
      provider: OPENAI_CODEX_PROVIDER_ID,
      id: "gpt-5.6-sol",
      name: "sol",
      api: "openai-codex-responses",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 16,
      cost: ZERO_COST,
    }],
    getModels() { return this.models; },
    auth: {
      oauth: {
        login: async () => ({
          type: "oauth",
          access: "codex-access-2",
          refresh: "codex-refresh-2",
          expires: Date.now() + 60 * 60 * 1000,
        }),
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    streamSimple: async function* () { yield { type: "start" }; },
    stream(model, context, options) { return this.streamSimple(model, context, options); },
  };
}

async function createRuntime(auth) {
  const agentDir = mkdtempSync(join(scratchRoot, "agent-"));
  writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(mockCodexProvider());
  return { agentDir, modelRuntime };
}

function commandHost() {
  const commands = new Map();
  return {
    commands,
    pi: {
      registerCommand(name, spec) { commands.set(name, spec); },
    },
  };
}

function ctxFor(modelRuntime, notes = []) {
  return {
    hasUI: true,
    signal: new AbortController().signal,
    modelRegistry: { runtime: modelRuntime },
    ui: {
      notify: (message) => notes.push(message),
      input: async () => "unused",
    },
  };
}

const seed = {
  [OPENAI_CODEX_PROVIDER_ID]: {
    type: "oauth",
    access: "codex-access-1",
    refresh: "codex-refresh-1",
    expires: Date.now() + 60 * 60 * 1000,
    accounts: [
      { name: "default", source: "login", access: "codex-access-1", refresh: "codex-refresh-1", expires: Date.now() + 60 * 60 * 1000 },
    ],
  },
};

test("/gpt-account add/remove/pin write through to auth.json", async () => {
  const { agentDir, modelRuntime } = await createRuntime(seed);
  const host = commandHost();
  await createGptAccountExtension({ agentDir })(host.pi);
  const handler = host.commands.get("gpt-account").handler;
  const notes = [];
  const ctx = ctxFor(modelRuntime, notes);
  const added = await handler("add", ctx);
  assert.equal(added.text, "added");
  let stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"))[OPENAI_CODEX_PROVIDER_ID];
  assert.equal(listSlots(stored).length, 2);
  assert.equal(stored.accounts[1].access, "codex-access-2");

  const pinned = await handler("pin login-2", ctx);
  assert.equal(pinned.text, "pinned");
  stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"))[OPENAI_CODEX_PROVIDER_ID];
  assert.equal(stored.pinned, "login-2");

  const removed = await handler("remove default", ctx);
  assert.equal(removed.text, "removed");
  stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"))[OPENAI_CODEX_PROVIDER_ID];
  assert.equal(listSlots(stored).length, 1);
  assert.equal(stored.accounts[0].name, "login-2");
});

test("rubato-features.json can disable the rubato-gpt-account factory", () => {
  const agentDir = mkdtempSync(join(scratchRoot, "toggle-"));
  writeFileSync(join(agentDir, "rubato-features.json"), JSON.stringify({ disabled: [GPT_ACCOUNT_FACTORY_NAME] }));
  const factories = [
    { name: "providers", factory: () => {} },
    { name: GPT_ACCOUNT_FACTORY_NAME, factory: createGptAccountExtension({ agentDir }) },
  ];
  const disabled = readDisabledFeatures({ agentDir, env: {} });
  const result = applyFeatureToggles(factories, disabled);
  assert.deepEqual(result.extensionFactories.map((entry) => entry.name), ["providers"]);
  assert.deepEqual(result.disabled, [GPT_ACCOUNT_FACTORY_NAME]);
  const host = commandHost();
  assert.equal(host.commands.has("gpt-account"), false);
});
