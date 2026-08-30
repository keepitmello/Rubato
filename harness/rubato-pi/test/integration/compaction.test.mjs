import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { launchEnv } from "../../src/brand.mjs";
import { startMockOpenAI } from "../helpers/mock-openai.mjs";

test("compaction is visible as an event instead of silently dropping the turn", async () => {
  const mock = await startMockOpenAI({ reply: "ok" });
  const home = mkdtempSync(join(tmpdir(), "rubato-pi-compact-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProjectTrust: "always",
      permissionPreset: "full-access",
      compaction: { enabled: true, reserveTokens: 8192 },
    })}\n`,
  );
  writeFileSync(
    join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        mock: {
          baseUrl: mock.url,
          api: "openai-completions",
          apiKey: "dummy",
          models: [{ id: "stub", reasoning: false, contextWindow: 1024, maxTokens: 32 }],
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
      "--model",
      "mock/stub",
      "-e",
      leadOverlayPath(),
      "-e",
      adapterPath(),
    ],
    {
      cwd,
      env: { ...launchEnv(process.env, agentDir), HOME: home, PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events = [];
  let buf = "";
  const seen = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 15000);
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          continue;
        }
        if (
          events.some(
            (e) => String(e.type).includes("compaction") || (e.type === "response" && e.command === "prompt" && e.success === false),
          )
        ) {
          clearTimeout(timer);
          resolve("seen");
        }
      }
    };
    child.stdout.on("data", onData);
  });
  child.stdin.write('{"id":"m","type":"set_model","provider":"mock","modelId":"stub"}\n');
  child.stdin.write(`{"id":"p","type":"prompt","message":"${"x".repeat(200)}"}\n`);
  await seen;
  child.kill("SIGKILL");
  await mock.close();
  const types = events.map((e) => e.type);
  const prompt = events.find((e) => e.type === "response" && e.command === "prompt");
  assert.ok(
    types.some((t) => String(t).includes("compaction")) || prompt?.success === false,
    `expected compaction or a failed prompt, got ${types.join(",")}`,
  );
});
