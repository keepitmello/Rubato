import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { adapterPath, leadOverlayPath, senpiCliPath } from "../../src/launch.mjs";
import { launchEnv } from "../../src/brand.mjs";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log("smoke:real skipped (OPENAI_API_KEY not set)");
  process.exit(0);
}

function attachWaiter(child) {
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
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
      for (const waiter of [...waiters]) {
        if (waiter.match(rec)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(rec);
        }
      }
    }
  });
  return (match, timeoutMs) =>
    new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("timeout"));
      }, timeoutMs);
      const orig = waiter.resolve;
      waiter.resolve = (rec) => {
        clearTimeout(timer);
        orig(rec);
      };
    });
}

function assistantText(messages) {
  const asst = [...(messages ?? [])].reverse().find((m) => m.role === "assistant" || m.type === "assistant");
  if (!asst) return null;
  if (typeof asst.content === "string") return asst.content;
  if (typeof asst.text === "string") return asst.text;
  if (Array.isArray(asst.content)) {
    return asst.content.map((part) => part.text ?? part.content ?? "").join("");
  }
  return null;
}

async function oneRole({ role, provider, modelId, token }) {
  const home = mkdtempSync(join(tmpdir(), `rubato-pi-real-${role}-`));
  const agentDir = join(home, "agent");
  const cwd = join(home, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    `${JSON.stringify({
      providers: {
        smoke: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "$OPENAI_API_KEY",
          models: [
            { id: "gpt-4.1-nano", reasoning: false, contextWindow: 128000, maxTokens: 128 },
            { id: "gpt-4o-mini", reasoning: false, contextWindow: 128000, maxTokens: 128 },
          ],
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
      "--model",
      `smoke/${modelId}`,
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
        OPENAI_API_KEY: apiKey,
        RUBATO_PI_ROLE: role,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const wait = attachWaiter(child);
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  try {
    const setModel = wait((rec) => rec.type === "response" && rec.command === "set_model", 30000);
    child.stdin.write(
      `${JSON.stringify({ id: "m", type: "set_model", provider, modelId })}\n`,
    );
    await setModel;
    const endedP = wait((rec) => rec.type === "agent_end" && rec.willRetry !== true, 45000);
    child.stdin.write(
      `${JSON.stringify({
        id: "p",
        type: "prompt",
        message: `Reply with exactly this token and nothing else: ${token}`,
      })}\n`,
    );
    const ended = await endedP;
    const text = assistantText(ended.messages);
    return {
      role,
      provider,
      modelId,
      text,
      tokenFound: String(text ?? "").includes(token),
    };
  } catch (error) {
    return {
      role,
      provider,
      modelId,
      error: String(error),
      stderrTail: stderr.slice(-600),
    };
  } finally {
    child.kill("SIGKILL");
  }
}

const results = [];
for (const spec of [
  { role: "lead", provider: "smoke", modelId: "gpt-4.1-nano", token: "RUBATO_PI_LEAD_OK" },
  { role: "owner", provider: "smoke", modelId: "gpt-4o-mini", token: "RUBATO_PI_OWNER_OK" },
  { role: "verifier", provider: "smoke", modelId: "gpt-4.1-nano", token: "RUBATO_PI_VERIFIER_OK" },
]) {
  results.push(await oneRole(spec));
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), "../../tmp/real-smoke.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
console.log(JSON.stringify({ outPath, results }, null, 2));
if (results.some((r) => r.error || !r.tokenFound)) process.exit(1);
