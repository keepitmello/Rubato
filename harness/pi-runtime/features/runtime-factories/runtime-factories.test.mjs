import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stagePiRuntime } from "../../stage-runtime.mjs";
import { runtimeFactoriesFeature } from "./feature.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function stage(t) {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-runtime-factories-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const staged = await stagePiRuntime({
    sourceRoot,
    outputRoot: join(scratch, "stage"),
    features: [runtimeFactoriesFeature],
  });
  return { scratch, staged };
}

// Each case stages a full stock runtime; under --test-concurrency=4 the three together
// have exceeded the 45s file default on a loaded host, so give them their own budget.
test("service callback sees canonical services and registers on the same model runtime", { timeout: 120_000 }, async (t) => {
  const { scratch, staged } = await stage(t);
  const { createAgentSessionServices } = await import(pathToFileURL(join(
    staged.root,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-services.js",
  )).href);
  const cwd = join(scratch, "project");
  const agentDir = join(scratch, "agent");
  const callbackContexts = [];
  const service = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(5_000),
    createExtensionFactories: (context) => {
      callbackContexts.push(context);
      return [(pi) => {
        pi.registerProvider("runtime-factory-fixture", {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "offline-fixture-key",
          models: [{ id: "fixture", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
        });
      }];
    },
    resourceLoaderOptions: {
      noExtensions: true,
      extensionFactories: [(pi) => {
        pi.registerProvider("runtime-factory-static", {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "offline-static-key",
          models: [{ id: "static-fixture", input: ["text"], contextWindow: 100_000, maxTokens: 4096 }],
        });
      }],
    },
  });
  assert.equal(callbackContexts.length, 1);
  assert.equal(callbackContexts[0].cwd, service.cwd);
  assert.equal(callbackContexts[0].agentDir, service.agentDir);
  assert.equal(callbackContexts[0].modelRuntime, service.modelRuntime);
  assert.equal(callbackContexts[0].settingsManager, service.settingsManager);
  assert.ok(service.modelRuntime.getRegisteredProviderIds().includes("runtime-factory-fixture"));
  assert.ok(service.modelRuntime.getRegisteredProviderIds().includes("runtime-factory-static"));
});

test("callback errors propagate and service replacement gets a fresh context", { timeout: 120_000 }, async (t) => {
  const { scratch, staged } = await stage(t);
  const { createAgentSessionServices } = await import(pathToFileURL(join(
    staged.root,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-services.js",
  )).href);
  const contexts = [];
  const callback = (context) => {
    contexts.push(context);
    return [];
  };
  await assert.rejects(
    createAgentSessionServices({
      cwd: join(scratch, "throws"),
      agentDir: join(scratch, "agent-throws"),
      createExtensionFactories: () => { throw new Error("factory callback fixture"); },
      resourceLoaderOptions: { noExtensions: true },
    }),
    /factory callback fixture/,
  );
  await createAgentSessionServices({
    cwd: join(scratch, "one"),
    agentDir: join(scratch, "agent"),
    createExtensionFactories: callback,
    resourceLoaderOptions: { noExtensions: true },
  });
  await createAgentSessionServices({
    cwd: join(scratch, "two"),
    agentDir: join(scratch, "agent"),
    createExtensionFactories: callback,
    resourceLoaderOptions: { noExtensions: true },
  });
  assert.deepEqual(contexts.map(({ cwd }) => cwd), [join(scratch, "one"), join(scratch, "two")]);
  assert.notEqual(contexts[0].settingsManager, contexts[1].settingsManager);
});

test("patched main forwards the callback through real RPC startup without paid providers", { timeout: 120_000 }, async (t) => {
  const { scratch, staged } = await stage(t);
  const marker = join(scratch, "callback.json");
  const wrapper = join(scratch, "invoke-main.mjs");
  const mainPath = pathToFileURL(join(
    staged.root,
    "node_modules/@earendil-works/pi-coding-agent/dist/main.js",
  )).href;
  await writeFile(wrapper, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainPath)};
await main(["--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"], {
  createExtensionFactories: ({ cwd, agentDir, modelRuntime, settingsManager }) => {
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd, agentDir, sameTypes: !!modelRuntime && !!settingsManager }) + "\\n");
    return [];
  },
});
`);
  const child = spawn(process.execPath, [wrapper], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH,
      HOME: join(scratch, "home"),
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: join(scratch, "agent"),
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let sentReplacement = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!sentReplacement && stdout.includes('"command":"get_state"')) {
      sentReplacement = true;
      child.stdin.write(JSON.stringify({ type: "new_session", id: "runtime-factories-replacement" }) + "\n");
    } else if (sentReplacement && stdout.includes('"command":"new_session"')) {
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ type: "get_state", id: "runtime-factories" }) + "\n");
  const exit = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`RPC callback fixture timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, 15_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  assert.equal(exit.code, 0, stderr || stdout);
  const receipts = (await readFile(marker, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((receipt) => receipt.sameTypes === true));
  const realScratch = await realpath(scratch);
  assert.ok(receipts.every((receipt) => receipt.cwd === realScratch));
});
