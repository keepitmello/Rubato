import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { startMockOpenAI } from "../helpers/mock-openai.mjs";
import { launchEnv } from "../../src/brand.mjs";

function waitForEvent(child, match, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(`timeout waiting for ${match}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (match(rec)) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve(rec);
        }
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`senpi exited ${code}/${signal}`));
    });
  });
}

test("a mock model turn completes without flattening the cache lane", async () => {
  const mock = await startMockOpenAI({ reply: "pong" });
  const home = mkdtempSync(join(tmpdir(), "rubato-pi-turn-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProjectTrust: "always", permissionPreset: "full-access", compaction: { enabled: false } })}\n`,
  );
  writeFileSync(
    join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        mock: {
          baseUrl: mock.url,
          api: "openai-completions",
          apiKey: "dummy",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "stub", reasoning: false, contextWindow: 1000000, maxTokens: 64 }],
        },
      },
    })}\n`,
  );

  const child = spawn(
    process.execPath,
    [
      senpiCliPath(),
      "--mode",
      "rpc",
      "--no-context-files",
      "--no-prompt-templates",
      "--approve",
      "--permission-preset",
      "full-access",
      "--api-key",
      "dummy",
      "--model",
      "mock/stub",
      "-e",
      leadOverlayPath(),
      "-e",
      adapterPath(),
    ],
    {
      cwd,
      env: {
        ...launchEnv(process.env, agentDir),
        HOME: home,
        PATH: process.env.PATH,
        SENPI_SESSION_DEBUG: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });

  const ready = waitForEvent(child, (rec) => rec.type === "response" && rec.command === "set_model", 20000);
  child.stdin.write('{"id":"m1","type":"set_model","provider":"mock","modelId":"stub"}\n');
  try {
    await ready;
  } catch (error) {
    child.kill("SIGKILL");
    await mock.close();
    throw new Error(`${error.message}; stderr=${stderr.slice(-800)}`);
  }

  const turn = waitForEvent(
    child,
    (rec) => rec.type === "agent_end" && rec.willRetry !== true,
    20000,
  );
  child.stdin.write('{"id":"p1","type":"prompt","message":"ping"}\n');
  try {
    await turn;
  } finally {
    child.kill("SIGKILL");
    await mock.close();
  }

  const flatten = (stderr.match(/"kind"\s*:\s*"flatten"/g) || []).length;
  const bootstrap = (stderr.match(/"kind"\s*:\s*"bootstrap"/g) || []).length;
  const delta = (stderr.match(/"kind"\s*:\s*"delta"/g) || []).length;
  assert.equal(flatten, 0, stderr.slice(-400));
  const tmp = join(dirname(fileURLToPath(import.meta.url)), "../../tmp");
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "memory-cost.json"), `${JSON.stringify({ flatten, bootstrap, delta, mockTurn: true }, null, 2)}\n`);
});
