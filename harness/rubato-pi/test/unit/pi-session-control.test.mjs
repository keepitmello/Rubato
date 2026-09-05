// Session/control host wiring on stock Pi 0.84.2 after
// reload-guard → reload-ui → memory-lifecycle → session-control.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const PATCH_DIR = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2");
const PATCHES = ["reload-guard.patch", "reload-ui.patch", "memory-lifecycle.patch", "session-control.patch"].map((name) => join(PATCH_DIR, name));
const FIXTURE = process.env.PI_STOCK_FIXTURE_DIR ??
  "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];
const PATCH_TIMEOUT_MS = 8000;

function fixtureProblem() {
  if (!existsSync(join(FIXTURE, "package.json"))) return `stock fixture missing at ${FIXTURE}`;
  try {
    const pkg = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || !String(pkg.name).endsWith("pi-coding-agent")) {
      return `stock fixture is ${pkg.name}@${pkg.version}`;
    }
  } catch (error) {
    return String(error);
  }
  if (PATCHES.some((p) => !existsSync(p))) return "session-control patch chain missing";
  return null;
}

const SKIP = fixtureProblem();

function runPatch(args, cwd) {
  try {
    const stdout = execFileSync("patch", args, {
      cwd,
      encoding: "utf8",
      timeout: PATCH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (error.killed || error.signal) throw new Error(`patch killed: ${error.signal ?? "timeout"}`);
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

function copyPristine(dest) {
  cpSync(FIXTURE, dest, { recursive: true, filter: (src) => src !== join(FIXTURE, "node_modules") });
  const nm = join(FIXTURE, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dest, "node_modules"));
}

let prepared = null;
function preparePatched() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-session-control-"));
  const pkgDir = join(dir, "pkg");
  copyPristine(pkgDir);
  for (const patch of PATCHES) {
    const result = runPatch([...PATCH_FLAGS, "-i", patch], pkgDir);
    assert.equal(result.status, 0, `${patch} failed: ${result.stdout}\n${result.stderr}`);
  }
  prepared = { dir, pkgDir };
  return prepared;
}

async function loadPatched() {
  const { pkgDir } = preparePatched();
  const [{ AgentSession }, loader] = await Promise.all([
    import(pathToFileURL(join(pkgDir, "dist", "core", "agent-session.js")).href),
    import(pathToFileURL(join(pkgDir, "dist", "core", "extensions", "loader.js")).href),
  ]);
  return { AgentSession, loader, pkgDir };
}

function makeAgent() {
  return {
    subscribe: () => () => {},
    abort() {},
    prompt: async () => {},
    continue: async () => {},
    steer() {},
    followUp() {},
    state: {
      tools: [],
      messages: [],
      systemPrompt: "",
      model: { id: "m", provider: "test", name: "test-m" },
      thinkingLevel: "off",
    },
  };
}

function makeSession(AgentSession, extensions, runtime, extras = {}) {
  const extensionRunnerRef = { current: undefined };
  const agent = extras.agent ?? makeAgent();
  const session = new AgentSession({
    agent,
    sessionManager: {
      getSessionName: () => "named",
      getSessionFile: () => "/tmp/s.jsonl",
      getSessionId: () => extras.sessionId ?? "s",
      getEntries: () => [],
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
  return { session, extensionRunnerRef, agent };
}

test("session-control applies after memory-lifecycle at fuzz 0", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = preparePatched();
  const types = readFileSync(join(pkgDir, "dist", "core", "extensions", "types.d.ts"), "utf8");
  assert.match(types, /export interface InteractiveControlSurface/);
  assert.match(types, /getInteractiveControl\(\)/);
  assert.match(types, /registerRemovedToolHint/);
  const sessionJs = readFileSync(join(pkgDir, "dist", "core", "agent-session.js"), "utf8");
  assert.match(sessionJs, /prepareInteractiveInput/);
  assert.match(sessionJs, /takeInteractiveSubmitResult/);
});

test("negative drift: mutated prepareInteractiveInput anchor fails session-control.patch", { skip: SKIP ?? undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-control-drift-"));
  copyPristine(dir);
  for (const patch of PATCHES.slice(0, 3)) {
    const result = runPatch([...PATCH_FLAGS, "-i", patch], dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const target = join(dir, "dist", "core", "agent-session.js");
  const original = readFileSync(target, "utf8");
  const anchor = "        this._bindExtensionCore(this._extensionRunner);";
  assert.ok(original.includes(anchor), "post-memory-lifecycle _bindExtensionCore hunk must exist");
  writeFileSync(target, original.replace(anchor, "        this._bindExtensionCore(this._extensionRunner); // drifted-anchor"));
  const result = runPatch([...PATCH_FLAGS, "-i", PATCHES[3]], dir);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /hunks failed|failed while patching/i);
});

test("prepared input id is the disposition id; takeInteractiveSubmitResult returns it", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatched();
  const runtime = loader.createExtensionRuntime();
  const seen = [];
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("input", (event) => {
      seen.push({ kind: "input", id: event.inputId, source: event.source });
    });
    pi.on("input_disposition", (event) => {
      seen.push({ kind: "disposition", id: event.inputId, disposition: event.disposition });
    });
  }, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [ext], runtime);
  const prepared = session.prepareInteractiveInput({
    id: "client-9",
    delivery: "submit",
    source: "remote",
    text: "hello",
  });
  assert.equal(prepared.id, "client-9");
  await session.prompt("hello", { source: "remote" });
  const taken = session.takeInteractiveSubmitResult();
  assert.equal(taken.inputId, "client-9");
  assert.equal(taken.disposition, "started");
  assert.equal(seen[0].id, "client-9");
  assert.equal(seen[1].id, "client-9");
  assert.equal(seen[1].disposition, "started");
  assert.equal(session.takeInteractiveSubmitResult(), undefined);
});

test("session control surface submitInput preserves clientInputId; empty is rejected; extension API getInteractiveControl is bound", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatched();
  const runtime = loader.createExtensionRuntime();
  let duringLoad;
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    duringLoad = pi.getInteractiveControl?.();
    pi.on("input", () => {});
  }, "/tmp", undefined, runtime);
  const { session, extensionRunnerRef } = makeSession(AgentSession, [ext], runtime);
  assert.equal(duringLoad, undefined, "control is unbound during factory load");
  const fromRunner = extensionRunnerRef.current.getInteractiveControl();
  const fromSession = session.getInteractiveControl();
  assert.ok(fromRunner);
  assert.equal(typeof fromRunner.submitInput, "function");
  const empty = await fromSession.submitInput("   ");
  assert.deepEqual(empty, { accepted: false, reason: "empty" });
  const result = await fromRunner.submitInput("go", { clientInputId: "req-1", source: "remote" });
  assert.equal(result.accepted, true);
  assert.equal(result.inputId, "req-1");
  assert.equal(result.disposition, "started");
});

test("registerRemovedToolHint stores on the extension and flushes at bind (task team_wait shape)", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatched();
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.registerRemovedToolHint(
      "team_wait",
      "team_wait was removed - team messages arrive as steered notifications; send updates with team_send and end your turn.",
    );
  }, "/tmp", undefined, runtime);
  assert.equal(ext.removedToolHints.get("team_wait")?.startsWith("team_wait was removed"), true);
  const { extensionRunnerRef } = makeSession(AgentSession, [ext], runtime);
  assert.equal(extensionRunnerRef.current._removedToolHints.get("team_wait")?.startsWith("team_wait was removed"), true);
});
