#!/usr/bin/env node
// Isolated cache-audit driver. RPC + throwaway HOME. Never writes ~/.rubato-pi / ~/.claude.
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_SETUP_TOKEN_FILE_ENV, CLAUDE_SETUP_TOKEN_PREFIX } from "../src/anthropic-setup-token.mjs";
import { launchEnv } from "../src/brand.mjs";
import { withNoChangelog } from "../src/no-changelog.mjs";
import { providerOverlayPath, senpiCliPath } from "../src/launch.mjs";
import { PROVIDER_DIRECT_FLAG } from "../src/provider-direct.mjs";
import { DISABLED_OAUTH_EXTENSIONS } from "../src/session-defaults.mjs";
import { createLineReader, createRpcWaiter } from "../test/smoke/rpc-waiter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = "/tmp/cache-audit/haiku-run";
const AUDIT_DIR = join(OUT, "audit");
const MODEL = "anthropic/claude-haiku-4-5";
const PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const TURN_MS = 120_000;
const COMPACTION_TURN_MS = 180_000;
const BOOT_MS = 45_000;
const ONLY = (() => {
  const index = process.argv.indexOf("--only");
  return index >= 0 ? process.argv[index + 1] : undefined;
})();
const KEEP_AUDIT = process.argv.includes("--keep-audit") || Boolean(ONLY);
const realClaudeToken = join(homedir(), ".claude", "auth", "setup-token-sub");

const scenarios = {};
const errors = [];
let haikuContextWindow;

function log(line) {
  const text = `[cache-audit-run] ${line}`;
  console.log(text);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "run.log"), `${text}\n`, { flag: "a" });
}

function setupTokenPresent() {
  try {
    const token = readFileSync(realClaudeToken, "utf8").trim();
    return token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) && token.length > CLAUDE_SETUP_TOKEN_PREFIX.length;
  } catch {
    return false;
  }
}

function keychainSetupTokenPresent() {
  return new Promise((resolve) => {
    const child = spawn(
      "security",
      ["find-generic-password", "-s", "Claude Code-setup-token-sub", "-a", process.env.USER ?? "", "-w"],
      { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HOME: homedir() } },
    );
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      const token = out.trim();
      resolve(code === 0 && token.startsWith(CLAUDE_SETUP_TOKEN_PREFIX) && token.length > CLAUDE_SETUP_TOKEN_PREFIX.length);
    });
  });
}

function createProfile(label, { compaction } = {}) {
  const home = join(OUT, "profiles", label, "home");
  const agentDir = join(home, "agent");
  const cwd = join(OUT, "profiles", label, "cwd");
  const sessionsDir = join(OUT, "profiles", label, "sessions");
  rmSync(join(OUT, "profiles", label), { recursive: true, force: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(home, ".claude", "auth"), { recursive: true });
  const realKeychains = join(homedir(), "Library", "Keychains");
  if (existsSync(realKeychains)) {
    mkdirSync(join(home, "Library"), { recursive: true });
    try {
      symlinkSync(realKeychains, join(home, "Library", "Keychains"));
    } catch {
      // Keychain gates SKIP themselves when the host has no login keychain.
    }
  }
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProjectTrust: "always",
      permissionPreset: "full-access",
      compaction: compaction ?? { enabled: false },
      disabledBuiltinExtensions: DISABLED_OAUTH_EXTENSIONS,
    })}\n`,
  );
  writeFileSync(join(cwd, "a.txt"), "alpha: small fixture for cache-audit tools/plain turns.\n");
  writeFileSync(join(cwd, "b.txt"), "bravo: second fixture file.\n");
  writeFileSync(join(cwd, "c.txt"), "charlie: third fixture file for resume.\n");
  return { label, home, agentDir, cwd, sessionsDir };
}

function writeLargeA(profile) {
  const line = "The quick brown fox jumps over the lazy dog. Cache-audit compaction filler.\n";
  let body = "a.txt — 8KB fixture for compaction growth turns.\n";
  while (Buffer.byteLength(body) < 8192) body += line;
  writeFileSync(join(profile.cwd, "a.txt"), body);
}

function seedClaudeToken(profile) {
  const dest = join(profile.home, ".claude", "auth", "setup-token-sub");
  if (setupTokenPresent()) copyFileSync(realClaudeToken, dest);
  return dest;
}

function childEnv(profile, extra = {}) {
  const env = {
    ...launchEnv(process.env, profile.agentDir),
    HOME: profile.home,
    PATH: process.env.PATH,
    [PROVIDER_DIRECT_FLAG]: "1",
    RUBATO_BROKER_URL: "http://127.0.0.1:1",
    RUBATO_TARGET_AUTH_PATH: join(profile.agentDir, "auth.json"),
    RUBATO_CACHE_AUDIT_DIR: AUDIT_DIR,
    RUBATO_CACHE_AUDIT_DIAGNOSTICS: "1",
    [CLAUDE_SETUP_TOKEN_FILE_ENV]: seedClaudeToken(profile),
    ...extra,
  };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "CLAUDE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    delete env[key];
  }
  // 실 세션과 같은 loader 훅(pi-ai/senpi transform)을 건다. 이게 없으면 패치 안 된 pinned 엔진을 잰다.
  delete env.NODE_OPTIONS;
  Object.assign(env, withNoChangelog(env));
  delete env.RUBATO_CACHE_AUDIT_BLOCK_BINDING;
  return env;
}

function send(child, payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function spawnRpc(profile, { extraArgs = [], extraEnv = {} } = {}) {
  const env = childEnv(profile, extraEnv);
  const args = [
    senpiCliPath(),
    "--mode",
    "rpc",
    "--no-context-files",
    "--no-prompt-templates",
    "--approve",
    "--permission-preset",
    "full-access",
    "--session-dir",
    profile.sessionsDir,
    "-e",
    providerOverlayPath(),
    "--model",
    MODEL,
    ...extraArgs,
  ];
  const child = spawn(process.execPath, args, {
    cwd: profile.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const wait = createRpcWaiter();
  child.stdout.on("data", createLineReader(wait.push));
  const session = { child, wait, stderr: () => stderr, env, profile };
  child.once("exit", (code, signal) => {
    writeFileSync(join(OUT, `stderr-${profile.label}.log`), stderr);
    if (code && code !== 0) log(`${profile.label} child exit ${code} signal=${signal ?? ""}`);
  });
  return session;
}

async function stop(session) {
  if (!session?.child) return;
  try {
    session.child.stdin.end();
  } catch {
    // already closed
  }
  try {
    session.child.kill("SIGKILL");
  } catch {
    // already dead
  }
  await new Promise((resolve) => {
    if (session.child.exitCode !== null || session.child.signalCode) {
      resolve();
      return;
    }
    session.child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

async function rpc(session, payload, command, timeoutMs = BOOT_MS) {
  const ready = session.wait(
    (rec) => rec.type === "response" && rec.command === command && (payload.id ? rec.id === payload.id : true),
    timeoutMs,
    command,
  );
  send(session.child, payload);
  return await ready;
}

async function waitForSessionStart(session) {
  if (session.wait.records.some((rec) => rec.type === "session_start")) return;
  try {
    await session.wait((rec) => rec.type === "session_start", BOOT_MS, "session_start");
  } catch {
    await rpc(session, { id: "ready", type: "get_state" }, "get_state");
  }
}

async function setModel(session) {
  await waitForSessionStart(session);
  const listed = await rpc(session, { id: "avail", type: "get_available_models" }, "get_available_models");
  const models = listed.data?.models ?? listed.models ?? [];
  const haiku = models.find((model) => model.provider === PROVIDER && model.id === MODEL_ID);
  if (haiku?.contextWindow) haikuContextWindow = haiku.contextWindow;
  if (!haiku) {
    const names = models.map((model) => `${model.provider}/${model.id}`).slice(0, 24);
    throw new Error(`model not available: ${MODEL}; listed=${names.join(",") || "none"}`);
  }
  const rec = await rpc(
    session,
    { id: "set-model", type: "set_model", provider: PROVIDER, modelId: MODEL_ID },
    "set_model",
  );
  if (rec.success === false) {
    throw new Error(`set_model ${MODEL} failed: ${JSON.stringify(rec.error ?? rec).slice(0, 400)}`);
  }
  return rec;
}

function takeRecord(session, match) {
  const index = session.wait.records.findIndex(match);
  if (index < 0) return undefined;
  const [rec] = session.wait.records.splice(index, 1);
  return rec;
}

function collectCompaction(session, seen) {
  for (const rec of session.wait.records) {
    if (String(rec.type ?? "").includes("compaction")) seen.push(rec.type);
  }
}

async function promptTurn(session, message, { id = "p", timeoutMs = TURN_MS, seen = [] } = {}) {
  send(session.child, { id, type: "prompt", message });
  const deadline = Date.now() + timeoutMs;
  let last;
  try {
    for (;;) {
      const remain = Math.max(1_000, deadline - Date.now());
      last = await session.wait(
        (rec) => rec.type === "agent_end" || rec.type === "agent_settled",
        remain,
        `turn-end:${id}`,
      );
      collectCompaction(session, seen);
      if (last.type === "agent_settled") break;
      if (last.willRetry === true) continue;
      break;
    }
    try {
      await session.wait((rec) => rec.type === "agent_settled", 3_000, "agent_settled");
    } catch {
      takeRecord(session, (rec) => rec.type === "agent_settled");
    }
    collectCompaction(session, seen);
    return last;
  } catch (error) {
    const settled = takeRecord(session, (rec) => rec.type === "agent_settled");
    const ended = takeRecord(session, (rec) => rec.type === "agent_end" && rec.willRetry !== true);
    collectCompaction(session, seen);
    if (settled || ended) return ended ?? settled;
    const types = session.wait.records.map((rec) => rec.type).slice(-24);
    const stderr = session.stderr?.()?.slice(-800) ?? "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}; recentTypes=${types.join(",")}; stderr=${stderr}`);
  }
}

function sessionFiles(profile) {
  if (!existsSync(profile.sessionsDir)) return [];
  return readdirSync(profile.sessionsDir)
    .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
    .map((name) => join(profile.sessionsDir, name));
}

function compactionHits(session) {
  return session.wait.records.filter((rec) => String(rec.type ?? "").includes("compaction")).map((rec) => rec.type);
}

async function snapshotState(session, name) {
  try {
    const state = await rpc(session, { id: `st-${name}`, type: "get_state" }, "get_state");
    return state.data ?? {};
  } catch (error) {
    errors.push(`${name} get_state: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

function recordScenario(name, fields) {
  scenarios[name] = { ...scenarios[name], ...fields };
  writeFileSync(join(OUT, "scenarios.json"), `${JSON.stringify(scenarios, null, 2)}\n`);
}

async function runPlain3() {
  const profile = createProfile("plain3");
  const session = spawnRpc(profile, { extraArgs: ["--session-id", "cache-audit-plain3"] });
  try {
    await setModel(session);
    await promptTurn(session, "1+1은? 숫자만.", { id: "p1" });
    await promptTurn(session, "그 다음 숫자는? 숫자만.", { id: "p2" });
    await promptTurn(session, "그 다음은? 숫자만.", { id: "p3" });
    const state = await snapshotState(session, "plain3");
    recordScenario("plain3", {
      status: "ran",
      sessionId: state.sessionId ?? "cache-audit-plain3",
      sessionFile: state.sessionFile ?? sessionFiles(profile)[0] ?? null,
      sessionFiles: sessionFiles(profile),
    });
    log(`plain3 sessionId=${scenarios.plain3.sessionId} file=${scenarios.plain3.sessionFile}`);
  } catch (error) {
    recordScenario("plain3", { status: "error", error: String(error).slice(0, 400), sessionFiles: sessionFiles(profile) });
    errors.push(`plain3: ${error instanceof Error ? error.message : error}`);
    throw error;
  } finally {
    await stop(session);
  }
}

async function runToolsAndResume() {
  const profile = createProfile("tools");
  const first = spawnRpc(profile, { extraArgs: ["--session-id", "cache-audit-tools"] });
  let sessionFile;
  try {
    await setModel(first);
    await promptTurn(first, "이 폴더의 a.txt 와 b.txt 를 read 도구로 읽고 각각 한 줄로 요약해.", { id: "tools" });
    const state = await snapshotState(first, "tools");
    sessionFile = state.sessionFile ?? sessionFiles(profile)[0];
    recordScenario("tools", {
      status: "ran",
      sessionId: state.sessionId ?? "cache-audit-tools",
      sessionFile,
      sessionFiles: sessionFiles(profile),
    });
    log(`tools sessionId=${scenarios.tools.sessionId} file=${sessionFile}`);
  } catch (error) {
    recordScenario("tools", { status: "error", error: String(error).slice(0, 400), sessionFiles: sessionFiles(profile) });
    errors.push(`tools: ${error instanceof Error ? error.message : error}`);
    await stop(first);
    throw error;
  }
  await stop(first);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const files = sessionFiles(profile);
  sessionFile = sessionFile ?? files[0];
  if (!sessionFile) throw new Error("tools session file missing; cannot resume");
  const resumed = spawnRpc(profile, { extraArgs: ["--session", sessionFile] });
  try {
    await setModel(resumed);
    await promptTurn(resumed, "c.txt 도 읽고 한 줄로.", { id: "resume" });
    const state = await snapshotState(resumed, "resume");
    recordScenario("resume", {
      status: "ran",
      sessionId: state.sessionId ?? scenarios.tools?.sessionId,
      sessionFile: state.sessionFile ?? sessionFile,
      sessionFiles: sessionFiles(profile),
      resumedFrom: sessionFile,
    });
    log(`resume sessionId=${scenarios.resume.sessionId} file=${scenarios.resume.sessionFile}`);
  } catch (error) {
    recordScenario("resume", { status: "error", error: String(error).slice(0, 400), resumedFrom: sessionFile });
    errors.push(`resume: ${error instanceof Error ? error.message : error}`);
    throw error;
  } finally {
    await stop(resumed);
  }
}

function compactionSettings() {
  const window = Number(haikuContextWindow);
  // shouldCompact / isAtHardLimit: tokens > contextWindow - reserveTokens.
  // Default reserveTokens=16384 fires far too late on a 200k window. Pin the
  // remaining budget to ~25k so ~6 x 8KB read turns can trip it.
  const reserveTokens = Number.isFinite(window) && window > 0 ? Math.max(1000, window - 20000) : 180000;
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: 4096,
    speculativeEnabled: false,
    idleCompactionEnabled: false,
  };
}

async function runCompaction() {
  const compaction = compactionSettings();
  const profile = createProfile("compaction", { compaction });
  writeLargeA(profile);
  const session = spawnRpc(profile, { extraArgs: ["--session-id", "cache-audit-compaction"] });
  const seen = [];
  try {
    await setModel(session);
    for (let i = 1; i <= 6; i += 1) {
      await promptTurn(session, "a.txt 를 read 도구로 읽고 한 줄로 요약해.", {
        id: `c${i}`,
        timeoutMs: COMPACTION_TURN_MS,
        seen,
      });
      const uniq = [...new Set(seen)];
      log(`compaction turn ${i} hits=${uniq.join(",") || "none"}`);
      if (uniq.length > 0) break;
    }
    let afterError;
    for (let i = 1; i <= 2; i += 1) {
      try {
        await promptTurn(session, `압축 이후 짧은 턴 ${i}. 숫자 ${i} 만.`, {
          id: `after${i}`,
          timeoutMs: COMPACTION_TURN_MS,
          seen,
        });
      } catch (error) {
        afterError = error;
        log(`compaction after${i} failed: ${error instanceof Error ? error.message : error}`);
        break;
      }
    }
    const state = await snapshotState(session, "compaction");
    const fired = seen.length > 0;
    recordScenario("compaction", {
      status: fired ? (afterError ? "ran-after-error" : "ran") : "ran-no-compaction-event",
      afterError: afterError ? String(afterError).slice(0, 240) : undefined,
      sessionId: state.sessionId ?? "cache-audit-compaction",
      sessionFile: state.sessionFile ?? sessionFiles(profile)[0] ?? null,
      sessionFiles: sessionFiles(profile),
      compactionSettings: compaction,
      contextWindow: haikuContextWindow ?? null,
      compactionEvents: [...new Set(seen)],
    });
    log(`compaction sessionId=${scenarios.compaction.sessionId} events=${seen.join(",") || "none"}`);
  } catch (error) {
    recordScenario("compaction", {
      status: "error",
      error: String(error).slice(0, 400),
      compactionSettings: compaction,
      compactionEvents: [...new Set(seen)],
    });
    errors.push(`compaction: ${error instanceof Error ? error.message : error}`);
    throw error;
  } finally {
    await stop(session);
  }
}

async function printReport() {
  const jsonl = join(AUDIT_DIR, "audit.jsonl");
  if (!existsSync(jsonl)) {
    console.log("\n[report] audit.jsonl missing");
    return;
  }
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(here, "cache-audit-report.mjs"), ...args], { stdio: "inherit" });
      child.on("close", resolve);
    });
  await run([jsonl]);
  for (const [name, info] of Object.entries(scenarios)) {
    if (!info?.sessionId) continue;
    console.log(`\n--- report --session ${name} ${info.sessionId} ---`);
    await run([jsonl, "--session", info.sessionId]);
  }
}

function shouldRun(name) {
  return !ONLY || ONLY === name || (ONLY === "tools" && name === "resume") || (ONLY === "resume" && (name === "tools" || name === "resume"));
}

async function main() {
  if (!KEEP_AUDIT) rmSync(AUDIT_DIR, { recursive: true, force: true });
  mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(join(OUT, "profiles"), { recursive: true });
  if (!KEEP_AUDIT) writeFileSync(join(OUT, "run.log"), "");
  log(`out=${OUT} model=${MODEL} only=${ONLY ?? "all"} keepAudit=${KEEP_AUDIT}`);
  try {
    const previous = JSON.parse(readFileSync(join(OUT, "scenarios.json"), "utf8"));
    const prior = previous.scenarios ?? previous;
    if (previous.haikuContextWindow) haikuContextWindow = previous.haikuContextWindow;
    for (const [name, info] of Object.entries(prior)) {
      if (info && typeof info === "object" && info.status && info.status !== "error") {
        if (!shouldRun(name)) scenarios[name] = info;
      }
    }
  } catch {
    // first run has no prior map
  }

  const fileOk = setupTokenPresent();
  const keychainOk = await keychainSetupTokenPresent();
  if (!fileOk && !keychainOk) {
    throw new Error("Anthropic setup-token absent (file + Keychain). Read-only sources were checked; nothing was written.");
  }
  log(`credential file=${fileOk} keychain=${keychainOk}`);

  const skipped = {};
  if (shouldRun("plain3")) {
    try {
      await runPlain3();
    } catch (error) {
      log(`plain3 failed: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    skipped.plain3 = `--only ${ONLY}`;
  }
  if (shouldRun("tools") || shouldRun("resume")) {
    try {
      await runToolsAndResume();
    } catch (error) {
      log(`tools/resume failed: ${error instanceof Error ? error.message : error}`);
      if (!scenarios.resume) {
        skipped.resume = "tools session did not produce a session file / turn failed";
        recordScenario("resume", { status: "skipped", reason: skipped.resume });
      }
    }
  } else {
    skipped.tools = `--only ${ONLY}`;
    skipped.resume = `--only ${ONLY}`;
  }
  if (shouldRun("compaction")) {
    try {
      await runCompaction();
    } catch (error) {
      log(`compaction failed: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    skipped.compaction = `--only ${ONLY}`;
  }

  writeFileSync(
    join(OUT, "scenarios.json"),
    `${JSON.stringify({ scenarios, errors, skipped, haikuContextWindow: haikuContextWindow ?? null }, null, 2)}\n`,
  );

  console.log("\n======== cache-audit-report ========");
  await printReport();
  console.log("\n======== scenario → sessionId ========");
  for (const name of ["plain3", "tools", "resume", "compaction"]) {
    const info = scenarios[name];
    if (!info) {
      console.log(`${name}: (missing)`);
      continue;
    }
    console.log(
      `${name}: status=${info.status} sessionId=${info.sessionId ?? "-"} sessionFile=${info.sessionFile ?? "-"}`,
    );
  }
  if (errors.length > 0) {
    console.log("\n======== errors ========");
    for (const error of errors) console.log(error);
  }
  console.log(`\naudit dir: ${AUDIT_DIR}`);
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
