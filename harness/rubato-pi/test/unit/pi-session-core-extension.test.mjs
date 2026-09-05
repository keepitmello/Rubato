// Additive session/core contracts after session-control + rpc-reload-veto.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const CA_DIR = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2");
const CORE_PATCH = join(repoRoot, "harness", "pi-patches", "pi-agent-core", "0.84.2", "removed-tool-hints.patch");
const CA_PATCHES = [
  "reload-guard.patch",
  "reload-ui.patch",
  "memory-lifecycle.patch",
  "session-control.patch",
  "rpc-reload-veto.patch",
  "session-core-extension.patch",
].map((name) => join(CA_DIR, name));
const FIXTURE = process.env.PI_STOCK_FIXTURE_DIR ??
  "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const CORE_FIXTURE = join(FIXTURE, "node_modules", "@earendil-works", "pi-agent-core");
const FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  if (!existsSync(join(FIXTURE, "package.json"))) return `missing ${FIXTURE}`;
  if (CA_PATCHES.some((p) => !existsSync(p))) return "session-core-extension chain missing";
  if (!existsSync(CORE_PATCH) || !existsSync(join(CORE_FIXTURE, "package.json"))) return "pi-agent-core fixture/patch missing";
  return null;
}
const SKIP = fixtureProblem();

function runPatch(args, cwd) {
  try {
    const stdout = execFileSync("patch", args, {
      cwd, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

function copyPristine(src, dest) {
  cpSync(src, dest, { recursive: true, filter: (p) => p !== join(src, "node_modules") });
  const nm = join(src, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dest, "node_modules"));
}

let prepared = null;
function prepare() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-core-ext-"));
  const pkgDir = join(dir, "pkg");
  copyPristine(FIXTURE, pkgDir);
  for (const patch of CA_PATCHES) {
    const r = runPatch([...FLAGS, "-i", patch], pkgDir);
    assert.equal(r.status, 0, `${patch}: ${r.stdout}\n${r.stderr}`);
  }
  const coreDir = join(dir, "core");
  copyPristine(CORE_FIXTURE, coreDir);
  const cr = runPatch([...FLAGS, "-i", CORE_PATCH], coreDir);
  assert.equal(cr.status, 0, `core: ${cr.stdout}\n${cr.stderr}`);
  prepared = { dir, pkgDir, coreDir };
  return prepared;
}

async function loadCA() {
  const { pkgDir } = prepare();
  const [{ AgentSession }, loader] = await Promise.all([
    import(pathToFileURL(join(pkgDir, "dist", "core", "agent-session.js")).href),
    import(pathToFileURL(join(pkgDir, "dist", "core", "extensions", "loader.js")).href),
  ]);
  return { AgentSession, loader, pkgDir };
}

function makeSession(AgentSession, extensions, runtime, extras = {}) {
  const extensionRunnerRef = { current: undefined };
  const settings = { setDefault: 0 };
  const agent = extras.agent ?? {
    subscribe: () => () => {},
    abort() {},
    prompt: async () => {},
    continue: async () => {},
    steer() {},
    followUp() {},
    clearAllQueues() {},
    removedToolHints: {},
    state: {
      tools: [], messages: [{ role: "user", content: "hi" }],
      systemPrompt: "", model: { id: "m", provider: "test", name: "n" }, thinkingLevel: "off",
    },
  };
  const session = new AgentSession({
    agent,
    sessionManager: {
      getSessionName: () => "n",
      getSessionFile: () => "/tmp/s.jsonl",
      getSessionId: () => "s",
      getEntries: () => extras.entries ?? [{ id: "e1", type: "message" }],
      appendModelChange() {},
    },
    settingsManager: {
      getImageAutoResize: () => false,
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
      reload: async () => {},
      isProjectTrusted: () => true,
      getSteeringMode: () => "all",
      getFollowUpMode: () => "all",
      getRetryEnabled: () => false,
      getRetrySettings: () => ({}),
      getCompactionEnabled: () => false,
      getDefaultThinkingLevel: () => "off",
      setDefaultModelAndProvider() { settings.setDefault += 1; },
    },
    cwd: "/tmp",
    resourceLoader: {
      getExtensions: () => ({ extensions, runtime }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPrompts: () => ({ prompts: [] }),
      reload: async () => {},
    },
    modelRuntime: {
      registerProvider() {},
      registerNativeProvider() {},
      unregisterProvider() {},
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({}),
      isUsingOAuth: () => false,
      getModel: () => agent.state.model,
      getModels: () => [],
      getAvailableSnapshot: () => [],
      getError: () => undefined,
      refresh: async () => {},
    },
    baseToolsOverride: {},
    extensionRunnerRef,
  });
  return { session, extensionRunnerRef, agent, settings };
}

test("session-core-extension applies after rpc-reload-veto", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = prepare();
  assert.match(readFileSync(join(pkgDir, "dist", "core", "sensitive-output.js"), "utf8"), /redactSensitiveOutput/);
  assert.match(readFileSync(join(pkgDir, "dist", "index.js"), "utf8"), /sensitive-output/);
});

test("registerMcpServer stores declarations on the runner", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadCA();
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.registerMcpServer("rubato-memory", {
      command: process.execPath,
      args: ["memory-mcp.js"],
      enabled: true,
      exposure: "search",
    });
  }, "/tmp", undefined, runtime);
  assert.equal(ext.mcpServers.get("rubato-memory").config.command, process.execPath);
  const { extensionRunnerRef } = makeSession(AgentSession, [ext], runtime);
  const listed = extensionRunnerRef.current.getRegisteredMcpServers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "rubato-memory");
});

test("setSessionModel does not write global defaults; setSessionFastMode is session-scoped", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadCA();
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async () => {}, "/tmp", undefined, runtime);
  const { session, settings } = makeSession(AgentSession, [ext], runtime);
  session.setSessionFastMode(true);
  assert.equal(session.isFastModeActive(), true);
  await session.setSessionModel({ id: "other", provider: "test", name: "o" });
  assert.equal(settings.setDefault, 0);
  await session.setModel({ id: "glob", provider: "test", name: "g" });
  assert.equal(settings.setDefault, 1);
});

test("abortWillFollow clearQueue then abort emits session_abort", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadCA();
  const runtime = loader.createExtensionRuntime();
  const aborts = [];
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("session_abort", (e) => aborts.push(e));
    pi.on("input", () => {});
  }, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [ext], runtime);
  session._isAgentRunActive = true;
  await session.prompt("queued", { streamingBehavior: "steer" });
  session._isAgentRunActive = false;
  assert.ok(session.pendingMessageCount > 0);
  session.clearQueue({ abortWillFollow: true });
  assert.equal(session.pendingMessageCount, 0);
  await session.abort();
  assert.equal(aborts.length, 1);
});

test("readConversationPage uses attached tracker, otherwise session entries", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadCA();
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async () => {}, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [ext], runtime, {
    entries: [{ id: "from-manager" }],
  });
  const page = await session.readConversationPage();
  assert.equal(page.entries[0].id, "from-manager");
  const tracker = {
    entries: [],
    rebuildFromMessages(messages) {
      this.entries = messages.map((m, i) => ({ id: `t${i}`, role: m.role }));
    },
    snapshot() {
      return { schemaVersion: 1, runs: [{ id: "run-1" }], pendingInputs: [], hasOlder: false };
    },
    readConversationPage() {
      return { entries: this.entries, requestRuns: [{ id: "run-1" }] };
    },
  };
  session.attachRequestRunTracker(tracker);
  const tracked = await session.readConversationPage({ limit: 10 });
  assert.equal(tracked.entries[0].id, "t0");
  assert.equal(tracked.requestRuns[0].id, "run-1");
  assert.equal(session.requestTimelineSnapshot().runs[0].id, "run-1");
});

test("removed-tool hints reach Agent.removedToolHints and loop config", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadCA();
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.registerRemovedToolHint("team_wait", "team_wait was removed - use team_send");
  }, "/tmp", undefined, runtime);
  const { session, agent } = makeSession(AgentSession, [ext], runtime);
  assert.match(agent.removedToolHints.team_wait, /team_send/);
  const { coreDir } = prepare();
  const agentJs = readFileSync(join(coreDir, "dist", "agent.js"), "utf8");
  assert.match(agentJs, /removedToolHints: this.removedToolHints/);
  const loopSrc = readFileSync(join(coreDir, "dist", "agent-loop.js"), "utf8");
  assert.match(loopSrc, /config\.removedToolHints\?\.\[toolCall\.name\]/);
});

test("sensitive-output is exported from the patched coding-agent", { skip: SKIP ?? undefined }, async () => {
  const { pkgDir } = prepare();
  const mod = await import(pathToFileURL(join(pkgDir, "dist", "core", "sensitive-output.js")).href);
  assert.equal(mod.redactSensitiveOutput("Authorization: Bearer sk-abc"), "Authorization: Bearer [REDACTED]");
});
