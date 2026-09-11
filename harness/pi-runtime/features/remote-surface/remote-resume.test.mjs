import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(here, "../..");
const sdkEntry = join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const RUBATO_AGENT_SESSION = join(
  process.env.HOME ?? "",
  ".rubato/agent/sessions/--Users-wy--/2026-08-19T06-30-56-241Z_01a018b7-39f1-7e0e-a810-d646a4133c52.jsonl",
);
const SENPI_SESSIONS = join(process.env.HOME ?? "", ".senpi/agent/sessions");
const TARGET_BYTES = 25_408_662;

function largestJsonl(root) {
  let bestPath;
  let bestSize = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > bestSize) {
        bestSize = size;
        bestPath = full;
      }
    }
  }
  return bestPath ? { path: bestPath, size: bestSize } : null;
}

function synthesizeLargeSession(dest) {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "00000000-0000-4000-8000-000000000001",
    timestamp: "2020-01-01T00:00:00.000Z",
    cwd: "/tmp",
  }) + "\n";
  writeFileSync(dest, header);
  let bytes = Buffer.byteLength(header);
  let prev = null;
  let i = 0;
  const payload = "s".repeat(16_384);
  while (bytes < TARGET_BYTES) {
    const id = i.toString(16).padStart(8, "0");
    const assistant = i % 2 === 1;
    const message = assistant
      ? {
        role: "assistant",
        content: [{ type: "text", text: payload }],
        api: "openai-completions",
        provider: "synthetic",
        model: "synthetic",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      }
      : { role: "user", content: payload };
    const line = JSON.stringify({
      type: "message",
      id,
      parentId: prev,
      timestamp: "2020-01-01T00:00:00.000Z",
      message,
    }) + "\n";
    appendFileSync(dest, line);
    bytes += Buffer.byteLength(line);
    prev = id;
    i += 1;
  }
}

function copyCandidateSession(dest) {
  try {
    const bytes = statSync(RUBATO_AGENT_SESSION).size;
    copyFileSync(RUBATO_AGENT_SESSION, dest);
    return { synthesized: false, bytes };
  } catch {
    // Profile copy is optional; fall through to senpi or a synthetic file.
  }
  const senpi = largestJsonl(SENPI_SESSIONS);
  if (senpi) {
    copyFileSync(senpi.path, dest);
    return { synthesized: false, bytes: senpi.size };
  }
  synthesizeLargeSession(dest);
  return { synthesized: true, bytes: statSync(dest).size };
}

function parseMetrics(stdout) {
  const lines = String(stdout ?? "").trim().split("\n").filter(Boolean);
  const last = lines.at(-1);
  assert.ok(last, "child printed no metrics JSON");
  let measured;
  try {
    measured = JSON.parse(last);
  } catch {
    throw new Error("child metrics were not JSON");
  }
  return measured;
}

test("copied large session resume does not kill SessionManager.open or createAgentSession", { timeout: 90_000 }, (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "rubato-remote-resume-"));
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const cwd = join(scratch, "cwd");
  const agentDir = join(scratch, "agent");
  const sessionDir = join(scratch, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const copy = join(sessionDir, "session.jsonl");
  const { synthesized, bytes } = copyCandidateSession(copy);
  assert.ok(bytes > 1_000_000, "resume fixture should be at least 1MB");

  const evalScript = [
    "import { pathToFileURL } from 'node:url';",
    "const sdk = " + JSON.stringify(sdkEntry) + ";",
    "const file = " + JSON.stringify(copy) + ";",
    "const cwd = " + JSON.stringify(cwd) + ";",
    "const agentDir = " + JSON.stringify(agentDir) + ";",
    "const sessionDir = " + JSON.stringify(sessionDir) + ";",
    "const { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(sdk).href);",
    "const openStarted = process.hrtime.bigint();",
    "const manager = SessionManager.open(file, sessionDir, cwd);",
    "const openMs = Number(process.hrtime.bigint() - openStarted) / 1e6;",
    "const settingsManager = SettingsManager.inMemory();",
    "const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });",
    "await resourceLoader.reload();",
    "const bindStarted = process.hrtime.bigint();",
    "const created = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' });",
    "const bindMs = Number(process.hrtime.bigint() - bindStarted) / 1e6;",
    "const mem = process.memoryUsage();",
    "const entries = manager.getEntries().length;",
    "const hasLeaf = Boolean(manager.getLeafId());",
    "created.session.dispose();",
    "process.stdout.write(JSON.stringify({ ok: true, openMs, bindMs, rss: mem.rss, heap: mem.heapUsed, entries, hasLeaf }) + String.fromCharCode(10));",
  ].join(String.fromCharCode(10));

  const env = {
    ...process.env,
    HOME: scratch,
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: agentDir,
    NO_COLOR: "1",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_COMPILE_CACHE;

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", evalScript], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 75_000,
    maxBuffer: 256 * 1024,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.signal, null, "resume child was killed by signal " + result.signal);
  assert.equal(result.status, 0, "resume child exited " + result.status + " (error=" + (result.error?.code ?? "none") + ")");
  const measured = parseMetrics(result.stdout);
  assert.equal(measured.ok, true);
  assert.equal(measured.hasLeaf, true);
  assert.ok(measured.entries > 0, "opened session had no entries");

  const diagnostic = {
    synthesized,
    bytes,
    openMs: measured.openMs,
    bindMs: measured.bindMs,
    rssMb: Math.round(measured.rss / 1024 / 1024),
    heapMb: Math.round(measured.heap / 1024 / 1024),
    entries: measured.entries,
  };
  t.diagnostic(JSON.stringify(diagnostic));

  assert.ok(measured.openMs < 30_000, "SessionManager.open stayed under 30s");
  assert.ok(measured.bindMs < 60_000, "createAgentSession bind stayed under 60s");
  assert.ok(measured.rss < 2 * 1024 * 1024 * 1024, "resume rss stayed under 2GiB");
});

