// Offline smoke for Rubato user-visible surfaces against a scratch stock candidate.
//
// Not folded into direct-real.mjs: that runner imports credentials and hits live
// vendors, and `import` runs main(). These checks must stay runnable without a
// provider token. The shared mechanism we reuse is rpc-waiter.mjs plus the
// scratch-candidate + fixture-provider pattern in pi-runtime/test/candidate-cli.test.mjs.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";
import { createLineReader, createRpcWaiter } from "./rpc-waiter.mjs";
import { buildRubatoCandidate } from "../../../pi-runtime/build-candidate.mjs";
import { createStockChildInProcessSession } from "../../../pi-runtime/features/child-runtime/stock-rpc-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const piRuntimeRoot = resolve(here, "../../../pi-runtime");
const LIVE_ENGINE = join(homedir(), ".rubato-pi", "stock-engine");
const WORDMARK = "\u{1D493}\u{1D496}\u{1D483}\u{1D482}\u{1D495}\u{1D490}";
const BOOT_MS = Number(process.env.RUBATO_SMOKE_BOOT_MS ?? 45_000);
const TURN_MS = Number(process.env.RUBATO_SMOKE_TURN_MS ?? 30_000);

const SANITIZED_IN_PROCESS_FAILURE = "In-process child session creation failed.";

function fail(surface, reason, extra = {}) {
  return { surface, status: "FAIL", reason, ...extra };
}
function pass(surface, detail, extra = {}) {
  return { surface, status: "PASS", detail, ...extra };
}
function skip(surface, reason, extra = {}) {
  return { surface, status: "SKIP", reason, ...extra };
}

function printResult(result) {
  const extra = result.reason ?? result.detail ?? "";
  console.log(`${result.status} ${result.surface} — ${extra}`);
}

function toolText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function liveEnginePath(path) {
  const resolved = resolve(path);
  return resolved === LIVE_ENGINE || resolved.startsWith(`${LIVE_ENGINE}/`);
}

function selectedSurfaces() {
  return (process.env.RUBATO_SMOKE_ONLY ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function shouldRun(name) {
  const only = selectedSurfaces();
  return only.length === 0 || only.includes(name);
}

async function resolveCandidate() {
  const reuse = process.env.RUBATO_SMOKE_CANDIDATE_DIR ?? process.env.RUBATO_STOCK_ENGINE_DIR;
  if (typeof reuse === "string" && reuse.trim()) {
    if (!isAbsolute(reuse)) throw new Error("RUBATO_SMOKE_CANDIDATE_DIR / RUBATO_STOCK_ENGINE_DIR must be absolute");
    if (liveEnginePath(reuse)) {
      throw new Error(`refusing to use the live engine at ${LIVE_ENGINE}; point RUBATO_SMOKE_CANDIDATE_DIR at a scratch candidate`);
    }
    const entry = join(reuse, "rubato-features/rubato-components/candidate-main.mjs");
    if (!existsSync(entry)) throw new Error(`scratch candidate entry missing: ${entry}`);
    // candidate-main compares resolve(argv[1]) to import.meta.url. On macOS /tmp
    // is a symlink to /private/tmp; the un-realpathed argv exits 0 without running.
    const root = realpathSync(reuse);
    return { root, candidateEntry: realpathSync(entry), built: false };
  }
  const outputRoot = mkdtempSync(join(tmpdir(), "rubato-stock-surfaces-"));
  console.error(`building scratch candidate at ${outputRoot}`);
  const staged = await buildRubatoCandidate({ sourceRoot: piRuntimeRoot, outputRoot });
  return { root: realpathSync(staged.root), candidateEntry: realpathSync(staged.candidateEntry), built: true };
}

function writeObserveExtension(path, stagedRoot) {
  const stockDist = join(stagedRoot, "node_modules/@earendil-works/pi-coding-agent/dist");
  const configUrl = pathToFileURL(join(stockDist, "config.js")).href;
  const footerUrl = pathToFileURL(join(stockDist, "rubato-features/statusline/footer.mjs")).href;
  const brandUrl = pathToFileURL(join(stockDist, "rubato-features/statusline/brand.mjs")).href;
  const headerPath = join(stockDist, "rubato-features/startup-chrome/header.mjs");
  const headerUrl = existsSync(headerPath) ? pathToFileURL(headerPath).href : "";
  const interactivePath = join(stagedRoot, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
  writeFileSync(
    path,
    `export default (pi) => {
  let context;
  pi.on("session_start", (event, ctx) => {
    context = ctx;
    pi.rpc.emit("surfaces.ready", { reason: event.reason });
  });
  pi.rpc.handle("surfaces.inspect", async () => {
    const { APP_NAME, VERSION } = await import(${JSON.stringify(configUrl)});
    const { renderRubatoStatusline } = await import(${JSON.stringify(footerUrl)});
    const { BRAND_NAME } = await import(${JSON.stringify(brandUrl)});
    let startupHeader = "";
    let startupChromePresent = false;
    if (${JSON.stringify(headerUrl)}) {
      const header = await import(${JSON.stringify(headerUrl)});
      startupHeader = header.startupLogoPlain(VERSION);
      startupChromePresent = true;
    }
    const fs = await import("node:fs");
    const path = await import("node:path");
    const patchedInteractive = fs.readFileSync(${JSON.stringify(interactivePath)}, "utf8");
    const cwd = context.cwd;
    const contextPresent = ["AGENTS.md", "CLAUDE.md"].some((name) => fs.existsSync(path.join(cwd, name)));
    const statusline = renderRubatoStatusline({
      session: context,
      footerData: { getGitBranch() {}, getExtensionStatuses() { return new Map(); } },
    }, 100);
    return {
      appName: APP_NAME,
      engineVersion: VERSION,
      brand: BRAND_NAME,
      startupHeader,
      startupChromePresent,
      patchedHeaderUsesBrand: patchedInteractive.includes("theme.fg(\\"accent\\", BRAND_NAME)") && patchedInteractive.includes("startupDisplayVersion(this.version)"),
      hideExtensionsPatched: patchedInteractive.includes("rubato.startupChrome.hideExtensions"),
      tuiListsContext: patchedInteractive.includes('addLoadedSection("Context"'),
      tuiListsSkills: patchedInteractive.includes('addLoadedSection("Skills"'),
      tuiListsExtensions: patchedInteractive.includes('addLoadedSection("Extensions"'),
      contextPresent,
      tools: pi.getAllTools().map((tool) => tool.name),
      providers: context.modelRegistry.getRegisteredProviderIds(),
      statusline,
    };
  });
  pi.rpc.handle("surfaces.execute", ({ name, params }) => pi.executeTool(name, params));
};
`,
  );
}

function createProfile(stagedRoot) {
  const home = mkdtempSync(join(tmpdir(), "rubato-stock-surfaces-home-"));
  const agentDir = join(home, "candidate-agent");
  const cwd = join(home, "project");
  const liveDir = join(home, "live-sentinel");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".rubato"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "smoke-surface"), { recursive: true });
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, "untouched"), "live profile must remain untouched");
  writeFileSync(
    join(cwd, ".rubato/rubato.jsonc"),
    `${JSON.stringify({
      memory: {
        agent: "smoke-surface",
        reflection: { enabled: false },
        facts: { enabled: false },
        dream: { enabled: false, shutdown_launch: false },
        sync: { enabled: false },
      },
      task: { default_execution_mode: "in-process", max_depth: 2, default_concurrency: 4 },
      agents: {
        "smoke-rpc": {
          description: "Offline RPC child for the stock-surfaces smoke",
          prompt: "You are a smoke RPC child. Reply with SMOKE_RPC_OK and end your turn.",
          model: "fixture/local-only",
          execution_mode: "process",
        },
        "smoke-member": {
          description: "Offline team member for the stock-surfaces smoke",
          prompt: "You are a smoke team member. Reply with SMOKE_TEAM_OK and end your turn.",
          model: "fixture/local-only",
          execution_mode: "process",
        },
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({
      defaultProjectTrust: "always",
      permissionPreset: "full-access",
      compaction: { enabled: false },
    })}\n`,
  );
  writeFileSync(
    join(agentDir, "skills/smoke-surface/SKILL.md"),
    `---
name: smoke-surface
description: Planted skill so the loaded-resources [Skills] section is visible.
---
# Smoke surface
`,
  );
  writeFileSync(join(cwd, "AGENTS.md"), "# Smoke project\n");
  writeFileSync(join(cwd, "hello.txt"), "SMOKE_OK\n");
  const observe = join(home, "surfaces-observe.mjs");
  writeObserveExtension(observe, stagedRoot);
  return { home, agentDir, cwd, liveDir, observe };
}

function startFixtureServer() {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const textSse = (text) =>
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
      "data: [DONE]\n\n";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(textSse("smoke fixture turn"));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

function childEnv(profile) {
  const env = {
    PATH: process.env.PATH,
    HOME: profile.home,
    LANG: "en_US.UTF-8",
    RUBATO_CANDIDATE_AGENT_DIR: profile.agentDir,
    PI_CODING_AGENT_DIR: profile.liveDir,
    RUBATO_PI_CODING_AGENT_DIR: profile.liveDir,
    PI_PACKAGE_DIR: profile.liveDir,
    PI_MANAGED_INSTALL_ROOT: profile.liveDir,
    PI_CODING_AGENT_SESSION_DIR: profile.liveDir,
    PI_OFFLINE: "1",
    RUBATO_SPEED_INDEX: "0",
    RUBATO_NO_KIRO_ENSURE: "1",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: join(profile.home, ".config"),
    XDG_DATA_HOME: join(profile.home, ".local/share"),
    XDG_STATE_HOME: join(profile.home, ".local/state"),
    GIT_AUTHOR_NAME: "Rubato test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Rubato test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_COMPILE_CACHE;
  return env;
}

async function bootSession(candidate, profile, server) {
  writeFileSync(
    join(profile.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: "unused",
          models: [
            { id: "local-only", contextWindow: 128000, maxTokens: 2048 },
            { id: "local-alt", contextWindow: 128000, maxTokens: 2048 },
          ],
        },
      },
    }),
  );
  const env = childEnv(profile);
  const child = spawn(
    process.execPath,
    [
      candidate.candidateEntry,
      "--mode",
      "rpc",
      "--offline",
      "--approve",
      "--provider",
      "fixture",
      "--model",
      "local-only",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      profile.observe,
    ],
    { cwd: profile.cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const wait = createRpcWaiter();
  child.stdout.on("data", createLineReader(wait.push));
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  let nextId = 0;
  const rpc = async (payload, command, timeoutMs = BOOT_MS) => {
    const id = payload.id ?? `s${++nextId}`;
    const ready = wait(
      (rec) => rec.type === "response" && rec.command === command && rec.id === id,
      timeoutMs,
      command,
    );
    send({ ...payload, id });
    return await ready;
  };
  const request = async (type, data = {}, timeoutMs = BOOT_MS) => {
    const rec = await rpc({ type, ...data }, type, timeoutMs);
    if (rec.success === false) {
      throw new Error(`${type} failed: ${JSON.stringify(rec.error ?? rec).slice(0, 500)}; stderr=${stderr.slice(-600)}`);
    }
    return rec.data;
  };
  try {
    await Promise.race([
      wait((rec) => rec.type === "extension_event" && rec.name === "surfaces.ready", BOOT_MS, "surfaces.ready"),
      once(child, "exit").then(([code, signal]) => {
        throw new Error(`candidate exited before surfaces.ready (code=${code} signal=${signal}); stderr=${stderr.slice(-800) || "<empty>"}`);
      }),
    ]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr=${stderr.slice(-800)}`);
  }
  return {
    child,
    wait,
    stderr: () => stderr,
    send,
    request,
    rpc,
    inspect: () => request("extension_request", { name: "surfaces.inspect" }),
    execute: (name, params) => request("extension_request", { name: "surfaces.execute", data: { name, params } }, TURN_MS),
    async stop() {
      try { child.stdin.end(); } catch { /* closed */ }
      try { child.kill("SIGKILL"); } catch { /* dead */ }
      if (child.exitCode !== null || child.signalCode) return;
      await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    },
  };
}

function spawnFailureNote(text) {
  if (text.includes(SANITIZED_IN_PROCESS_FAILURE)) {
    return `${text} [harness note: publicStartFailureMessage discarded the stock cause; createStockChildInProcessSession requires agentDir and createParentRegistrySessionContext never supplies it]`;
  }
  return text;
}

function liveChildFromSpawn(result, executionMode) {
  const text = toolText(result);
  const details = result?.details ?? {};
  if (result?.isError === true) {
    return { ok: false, reason: spawnFailureNote(text || JSON.stringify(details)) };
  }
  if (text.includes(SANITIZED_IN_PROCESS_FAILURE) || details.status === "session-create-failed") {
    return { ok: false, reason: spawnFailureNote(text || JSON.stringify(details)) };
  }
  if (!details.agentId) {
    return { ok: false, reason: `no live agentId; text=${text.slice(0, 240)}; details=${JSON.stringify(details).slice(0, 400)}` };
  }
  if (details.status !== "running" && details.status !== "pending") {
    return { ok: false, reason: `child not live: status=${details.status}; text=${text.slice(0, 240)}` };
  }
  if (executionMode && details.execution_mode && details.execution_mode !== executionMode) {
    return { ok: false, reason: `execution_mode=${details.execution_mode} expected ${executionMode}` };
  }
  return { ok: true, agentId: details.agentId, details, text };
}

async function peekTask(session, agentId) {
  const rec = await session.rpc(
    { type: "extension_request", name: "rubato.task.output", data: { task_id: agentId, mode: "status" } },
    "extension_request",
    TURN_MS,
  );
  return rec.success === false ? rec : rec.data;
}

function taskLooksLive(peek) {
  const snapshot = peek?.snapshot ?? peek;
  const status = snapshot?.status ?? peek?.status;
  if (status === "failed" || status === "error") {
    return { ok: false, reason: spawnFailureNote(snapshot?.error_message ?? peek?.error_message ?? JSON.stringify(peek).slice(0, 300)) };
  }
  // A fixture child can finish before the peek. completed-with-output still
  // proves the session existed; session-create-failed never reaches completed.
  if (status === "running" || status === "pending" || status === "completed") {
    return {
      ok: true,
      status,
      childSessionId: snapshot?.child_session_id ?? peek?.child_session_id,
      residency: snapshot?.residency_state ?? peek?.residency_state,
    };
  }
  return { ok: false, reason: `unexpected peek ${JSON.stringify(peek).slice(0, 400)}` };
}

async function checkSpawnTeeth() {
  const surface = "in-process-subagent-spawn-teeth";
  let threw;
  try {
    await createStockChildInProcessSession(
      { cwd: "/tmp/rubato-smoke-unfixed", settingsManager: { ok: true } },
      { createAgentSession: async () => ({}), DefaultResourceLoader: class {} },
    );
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  if (!threw || !/requires agentDir/i.test(threw)) {
    return fail(surface, `unfixed factory did not throw requires agentDir; got ${threw ?? "no throw"}`);
  }
  const judged = liveChildFromSpawn({
    isError: true,
    content: [{ type: "text", text: SANITIZED_IN_PROCESS_FAILURE }],
    details: { status: "session-create-failed" },
  }, "in-process");
  if (judged.ok) {
    return fail(surface, "judge accepted a sanitized in-process failure; suite lost its teeth");
  }
  const named = fail("in-process-subagent-spawn", judged.reason);
  console.log(`TEETH ${named.status} ${named.surface} — ${named.reason}`);
  return pass(surface, `factory threw ${threw}; judge emits the named FAIL above`);
}

async function checkInProcessSpawn(session) {
  const surface = "in-process-subagent-spawn";
  let result;
  try {
    result = await session.execute("Agent", {
      prompt: "Reply with exactly SMOKE_INPROC_OK and end your turn.",
      model: "fixture/local-only",
      summary: "smoke in-process child",
    });
  } catch (error) {
    return fail(surface, spawnFailureNote(String(error).slice(0, 500)), { stderr: session.stderr().slice(-400) });
  }
  const spawned = liveChildFromSpawn(result, "in-process");
  if (!spawned.ok) return fail(surface, spawned.reason, { raw: result, stderr: session.stderr().slice(-400) });
  const peek = await peekTask(session, spawned.agentId).catch((error) => ({ error: String(error) }));
  const live = taskLooksLive(peek);
  if (!live.ok) return fail(surface, `spawned ${spawned.agentId} but peek is not a live session: ${live.reason}`);
  return pass(surface, `agentId=${spawned.agentId} status=${live.status} child_session_id=${live.childSessionId ?? "n/a"} residency=${live.residency ?? "n/a"}`);
}

async function checkRpcSpawn(session) {
  const surface = "rpc-child-spawn";
  let result;
  try {
    result = await session.execute("Agent", {
      prompt: "Reply with exactly SMOKE_RPC_OK and end your turn.",
      preset: "smoke-rpc",
      summary: "smoke rpc child",
    });
  } catch (error) {
    return fail(surface, String(error).slice(0, 500), { stderr: session.stderr().slice(-400) });
  }
  const spawned = liveChildFromSpawn(result, "process");
  if (!spawned.ok) return fail(surface, spawned.reason, { raw: result, stderr: session.stderr().slice(-400) });
  const peek = await peekTask(session, spawned.agentId).catch((error) => ({ error: String(error) }));
  const live = taskLooksLive(peek);
  if (!live.ok) return fail(surface, `spawned ${spawned.agentId} but peek is not a live session: ${live.reason}`);
  return pass(surface, `agentId=${spawned.agentId} status=${live.status} mode=process child_session_id=${live.childSessionId ?? "n/a"}`);
}

async function checkTeamMember(session) {
  const surface = "team-member-start";
  let result;
  try {
    result = await session.execute("team_create", {
      inline_spec: {
        name: "smoke-team",
        members: [{
          name: "alice",
          subagent_type: "smoke-member",
          prompt: "Reply with exactly SMOKE_TEAM_OK and end your turn.",
        }],
      },
    });
  } catch (error) {
    return fail(surface, String(error).slice(0, 500), { stderr: session.stderr().slice(-400) });
  }
  const text = toolText(result);
  const details = result?.details ?? {};
  if (details.kind !== "created") {
    return fail(surface, `team did not start a member: ${text.slice(0, 300)}; details=${JSON.stringify(details).slice(0, 400)}`);
  }
  const member = details.members?.[0];
  if (!member) return fail(surface, `created team has no members; ${text.slice(0, 240)}`);
  if (member.status !== "running" && member.status !== "pending") {
    return fail(surface, `member '${member.name}' status=${member.status}; ${text.slice(0, 240)}`);
  }
  return pass(surface, `team=${details.team_name} member=${member.name} status=${member.status} task=${member.task_id}`);
}

async function checkStartupHeader(inspect) {
  const surface = "startup-header";
  const stockHeader = `pi v${inspect.engineVersion ?? "0.85.1"}`;
  if (inspect.startupChromePresent !== true) {
    return skip(
      surface,
      `workstream 2 (startup wordmark) has not landed on this candidate; assertion remains: header must show ${WORDMARK}, not \`${stockHeader}\`. observed APP_NAME=${inspect.appName}`,
    );
  }
  const header = String(inspect.startupHeader ?? "");
  if (!header.includes(WORDMARK) || header === stockHeader || inspect.appName === WORDMARK) {
    return fail(surface, `startup header is not the Rubato wordmark; startupHeader=${JSON.stringify(header)} APP_NAME=${inspect.appName} (must not be ${stockHeader})`);
  }
  if (inspect.patchedHeaderUsesBrand !== true) {
    return fail(surface, `interactive-mode.js still paints APP_NAME/engine version instead of BRAND_NAME/startupDisplayVersion`);
  }
  return pass(surface, `header=${header}; APP_NAME stays ${inspect.appName} for env paths`);
}

function checkLoadedResources(inspect, commands = []) {
  const surface = "startup-loaded-resources";
  if (inspect.hideExtensionsPatched !== true) {
    return skip(
      surface,
      "workstream 2 (startup-chrome hide Extensions) has not landed on this candidate; assertion remains: TUI lists [Context] [Skills] and must not list [Extensions]",
    );
  }
  const skillNames = commands.filter((command) => command.source === "skill").map((command) => command.name);
  const hasPlantedSkill = skillNames.some((name) => name === "smoke-surface" || name === "skill:smoke-surface");
  if (inspect.tuiListsContext !== true || inspect.contextPresent !== true) {
    return fail(surface, `TUI [Context] would not appear; tuiListsContext=${inspect.tuiListsContext} contextPresent=${inspect.contextPresent}`);
  }
  if (inspect.tuiListsSkills !== true || !hasPlantedSkill) {
    return fail(surface, `TUI [Skills] would not appear; tuiListsSkills=${inspect.tuiListsSkills} skills=${skillNames.join(",") || "none"}`);
  }
  if (inspect.tuiListsExtensions === true) {
    return fail(surface, "patched interactive-mode still calls addLoadedSection(\"Extensions\"); startup-chrome must hide that block");
  }
  return pass(surface, `[Context] [Skills] present; [Extensions] hidden; skills=${skillNames.join(",")}`);
}

async function checkMemory(session) {
  const surface = "memory-tool";
  const written = await session.execute("memory", {
    command: "create",
    file_path: "facts/smoke-surface.md",
    description: "stock-surfaces smoke",
    file_text: "stock-surfaces memory write",
    reason: "smoke memory surface",
  });
  if (written?.isError === true) {
    return fail(surface, `memory create failed: ${toolText(written).slice(0, 300)}`);
  }
  const status = await session.request("extension_request", { name: "rubato.memory.status" });
  if (!status?.repo?.headSha) {
    return fail(surface, `memory create did not produce a repo head; ${JSON.stringify(status).slice(0, 300)}`);
  }
  return pass(surface, `headSha=${String(status.repo.headSha).slice(0, 12)}`);
}

async function checkSlash(session, surface, message, assertNotify) {
  const from = session.wait.records.length;
  const rec = await session.rpc({ type: "prompt", message }, "prompt", TURN_MS);
  if (rec.success === false) {
    return fail(surface, `/${surface.replace("slash-", "")} RPC failed: ${JSON.stringify(rec.error ?? rec).slice(0, 300)}`);
  }
  const notifies = session.wait.records
    .slice(from)
    .concat([])
    .filter((frame) => frame.type === "extension_ui_request" && frame.method === "notify");
  // Records already consumed by the waiter stay on wait.records only if unmatched.
  // Also scan a short wait for a notify that arrived after the prompt response.
  try {
    const notify = await session.wait(
      (frame) => frame.type === "extension_ui_request" && frame.method === "notify",
      2_000,
      "notify",
    );
    notifies.push(notify);
  } catch {
    // notify is fire-and-forget; some commands settle without one
  }
  const blob = notifies.map((frame) => String(frame.message ?? "")).join("\n");
  if (assertNotify && !assertNotify(blob, rec)) {
    return fail(surface, `command ran but did not prove Rubato behavior; notify=${blob.slice(0, 240) || "none"}`);
  }
  return pass(surface, blob.slice(0, 160) || "rpc success");
}

async function checkSlashCommands(session, inspect) {
  const commands = await session.request("get_commands");
  const names = (commands?.commands ?? []).map((command) => command.name);
  const results = [];
  for (const name of ["ttsr", "goal", "fallback"]) {
    if (shouldRun(`slash-${name}`) && !names.includes(name)) {
      results.push(fail(`slash-${name}`, `Rubato command /${name} missing from get_commands; listed=${names.slice(0, 24).join(",")}`));
    }
  }
  if (shouldRun("slash-ttsr") && names.includes("ttsr")) {
    results.push(await checkSlash(session, "slash-ttsr", "/ttsr", (blob) => /TTSR|collapse-repetition|stream rules/i.test(blob)));
  }
  if (shouldRun("slash-goal") && names.includes("goal")) {
    results.push(await checkSlash(session, "slash-goal", "/goal", (blob) => /No goal|Usage: \/goal|goal/i.test(blob)));
  }
  if (shouldRun("slash-fallback") && names.includes("fallback")) {
    const saved = await session.rpc(
      { type: "prompt", message: "/fallback fixture/local-only fixture/local-alt" },
      "prompt",
      TURN_MS,
    );
    if (saved.success === false) {
      results.push(fail("slash-fallback", `save failed: ${JSON.stringify(saved.error ?? saved).slice(0, 300)}`));
    } else {
      const switched = await session.rpc({ type: "prompt", message: "/fallback now" }, "prompt", TURN_MS);
      const state = await session.request("get_state");
      if (switched.success === false) {
        results.push(fail("slash-fallback", `switch failed: ${JSON.stringify(switched.error ?? switched).slice(0, 300)}`));
      } else if (state?.model?.id !== "local-alt") {
        results.push(fail("slash-fallback", `expected model local-alt after /fallback now; got ${state?.model?.id ?? "none"}`));
      } else {
        results.push(pass("slash-fallback", "saved chain and switched to fixture/local-alt"));
      }
    }
  }
  return results.filter((result) => shouldRun(result.surface));
}

function checkStatusline(inspect) {
  const surface = "statusline-brand";
  const painted = (inspect.statusline ?? []).map((line) => plain(String(line))).join("\n");
  if (!painted.includes(WORDMARK) && !painted.includes(inspect.brand ?? "")) {
    return fail(surface, `statusline missing Rubato brand mark; painted=${JSON.stringify(painted).slice(0, 240)}`);
  }
  return pass(surface, `brand=${inspect.brand} line=${painted.split("\n")[0]?.slice(0, 80)}`);
}

async function main() {
  const candidate = await resolveCandidate();
  console.error(`candidate root=${candidate.root} built=${candidate.built}`);
  const profile = createProfile(candidate.root);
  const server = await startFixtureServer();
  let session;
  const results = [];
  try {
    session = await bootSession(candidate, profile, server);
    const inspect = await session.inspect();
    if (!inspect.tools?.includes("Agent") || !inspect.tools?.includes("team_create") || !inspect.tools?.includes("memory")) {
      throw new Error(`candidate missing required tools: ${(inspect.tools ?? []).join(",")}`);
    }
    const commandList = await session.request("get_commands");
    const commands = commandList?.commands ?? [];

    if (shouldRun("startup-header")) results.push(await checkStartupHeader(inspect));
    if (shouldRun("startup-loaded-resources")) results.push(checkLoadedResources(inspect, commands));
    if (shouldRun("statusline-brand")) results.push(checkStatusline(inspect));
    if (shouldRun("memory-tool")) results.push(await checkMemory(session));
    results.push(...await checkSlashCommands(session, inspect));
    if (shouldRun("in-process-subagent-spawn-teeth") || shouldRun("in-process-subagent-spawn")) {
      results.push(await checkSpawnTeeth());
    }
    if (shouldRun("in-process-subagent-spawn")) results.push(await checkInProcessSpawn(session));
    if (shouldRun("rpc-child-spawn")) results.push(await checkRpcSpawn(session));
    if (shouldRun("team-member-start")) results.push(await checkTeamMember(session));
  } catch (error) {
    results.push(fail("suite-boot", String(error).slice(0, 600)));
  } finally {
    await session?.stop();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    if (process.env.RUBATO_SMOKE_KEEP !== "1") {
      rmSync(profile.home, { recursive: true, force: true });
    } else {
      console.error(`kept profile ${profile.home}`);
    }
    if (candidate.built && process.env.RUBATO_SMOKE_KEEP !== "1" && !process.env.RUBATO_SMOKE_CANDIDATE_DIR) {
      // Keep the built candidate when the operator passed a reuse dir; otherwise drop ours.
    }
  }

  for (const result of results) printResult(result);
  const counts = {
    pass: results.filter((result) => result.status === "PASS").length,
    fail: results.filter((result) => result.status === "FAIL").length,
    skip: results.filter((result) => result.status === "SKIP").length,
  };
  console.log(JSON.stringify({
    candidate: candidate.root,
    counts,
    skippedUntilIntegration: results.filter((result) => result.status === "SKIP").map((result) => result.surface),
  }));
  if (counts.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
