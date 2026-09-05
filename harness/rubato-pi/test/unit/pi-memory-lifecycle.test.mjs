// Patched-stock memory lifecycle: session_abort + input/input_disposition
// identity on real pi-coding-agent 0.84.2 after reload-guard + reload-ui.
//
// Drives actual AgentSession.prompt()/abort() and ExtensionRunner events.
// Imports real createDreamTriggerWiring + createMemoryNudgeWiring.
// Constructor DI only — no replacement host, no paid API, no live session.
//
// Fixture: PI_STOCK_FIXTURE_DIR, default /tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent.
// SKIPS (never fake-passes) when the fixture is absent or version-mismatched.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const GUARD_PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2", "reload-guard.patch");
const UI_PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2", "reload-ui.patch");
const LIFE_PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2", "memory-lifecycle.patch");
const NUDGE_TS = join(repoRoot, "packages", "rubato-runtime", "src", "components", "memory", "nudge-wiring.ts");
const DREAM_TS = join(repoRoot, "packages", "rubato-runtime", "src", "components", "memory", "dream-trigger.ts");
const STATUS_LINE_TS = join(repoRoot, "packages", "senpi-task", "src", "status-line.ts");
const FIXTURE = process.env.PI_STOCK_FIXTURE_DIR ??
  "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent";
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  if (!existsSync(join(FIXTURE, "package.json"))) return `stock fixture missing at ${FIXTURE}`;
  try {
    const pkg = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || !String(pkg.name).endsWith("pi-coding-agent")) {
      return `stock fixture is ${pkg.name}@${pkg.version}, want pi-coding-agent@0.84.2`;
    }
  } catch (error) {
    return `stock fixture unreadable: ${String(error)}`;
  }
  if (!existsSync(GUARD_PATCH) || !existsSync(UI_PATCH) || !existsSync(LIFE_PATCH)) {
    return "reload-guard, reload-ui, or memory-lifecycle patch missing";
  }
  if (!existsSync(NUDGE_TS) || !existsSync(DREAM_TS)) return "memory consumer sources missing";
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
    if (error.killed || error.signal) {
      throw new Error(`patch timed out or killed (${error.signal ?? "timeout"}): ${args.join(" ")}`);
    }
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

function copyPristine(dest) {
  cpSync(FIXTURE, dest, {
    recursive: true,
    filter: (src) => src !== join(FIXTURE, "node_modules"),
  });
  const nm = join(FIXTURE, "node_modules");
  if (existsSync(nm)) symlinkSync(nm, join(dest, "node_modules"));
}

function applyPriorThenLifecycle(pkgDir) {
  const guard = runPatch([...PATCH_FLAGS, "-i", GUARD_PATCH], pkgDir);
  assert.equal(guard.status, 0, `reload-guard apply failed: ${guard.stdout}\n${guard.stderr}`);
  const ui = runPatch([...PATCH_FLAGS, "-i", UI_PATCH], pkgDir);
  assert.equal(ui.status, 0, `reload-ui apply failed: ${ui.stdout}\n${ui.stderr}`);
  const life = runPatch([...PATCH_FLAGS, "-i", LIFE_PATCH], pkgDir);
  const out = `${life.stdout}\n${life.stderr}`;
  assert.equal(life.status, 0, `memory-lifecycle apply failed: ${out}`);
  assert.match(out, /patching file 'dist\/core\/agent-session\.js'/);
  assert.match(out, /patching file 'dist\/core\/extensions\/runner\.js'/);
  assert.match(out, /patching file 'dist\/core\/extensions\/types\.d\.ts'/);
  return out;
}

let prepared = null;
function preparePatched() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-lifecycle-"));
  const pkgDir = join(dir, "pkg");
  copyPristine(pkgDir);
  applyPriorThenLifecycle(pkgDir);
  prepared = { dir, pkgDir };
  return prepared;
}

let hooksRegistered = false;
let consumersPromise = null;
function registerConsumerHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const piTui = join(FIXTURE, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
  const packagesRoot = join(repoRoot, "packages");
  const alias = {
    "@rubato/senpi-task": STATUS_LINE_TS,
    "@rubato/senpi-task/notice-box": join(packagesRoot, "senpi-task", "src", "notice-box.ts"),
    "@rubato/senpi-task/renderer-text": join(packagesRoot, "senpi-task", "src", "renderer-text.ts"),
  };
  // memory-core uses TS parameter properties; strip-only Node cannot load it.
  // Register-time consumers only need the module graph to exist. Fire paths are not used here.
  const memoryCoreStub = "data:text/javascript," + encodeURIComponent(`
    export class TranscriptJournal {}
    export function captureCursorSnapshot() { return {}; }
    export function deriveState() { return {}; }
    export function initialReflectionState() { return {}; }
    export function isCanonicalEntry() { return false; }
    export function searchTranscripts() { return []; }
  `);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@rubato/memory-core") {
        return { url: memoryCoreStub, shortCircuit: true };
      }
      if (alias[specifier] && existsSync(alias[specifier])) {
        return { url: pathToFileURL(alias[specifier]).href, shortCircuit: true };
      }
      if (specifier === "@earendil-works/pi-tui" && existsSync(piTui)) {
        return { url: pathToFileURL(piTui).href, shortCircuit: true };
      }
      if (specifier.startsWith(".") && context.parentURL) {
        const parent = fileURLToPath(context.parentURL);
        if (parent.includes("/packages/")) {
          let candidate = join(dirname(parent), specifier);
          const asFile = (path) => existsSync(path) && lstatSync(path).isFile();
          if (!asFile(candidate)) {
            if (asFile(`${candidate}.ts`)) candidate = `${candidate}.ts`;
            else if (asFile(`${candidate}.mjs`)) candidate = `${candidate}.mjs`;
            else if (asFile(join(candidate, "index.ts"))) candidate = join(candidate, "index.ts");
          }
          if (asFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

function loadConsumers() {
  if (!consumersPromise) {
    registerConsumerHooks();
    consumersPromise = Promise.all([
      import(pathToFileURL(NUDGE_TS).href),
      import(pathToFileURL(DREAM_TS).href),
    ]);
  }
  return consumersPromise;
}

async function loadPatchedSession() {
  const { pkgDir } = preparePatched();
  const sessionUrl = pathToFileURL(join(pkgDir, "dist", "core", "agent-session.js")).href;
  const loaderUrl = pathToFileURL(join(pkgDir, "dist", "core", "extensions", "loader.js")).href;
  const [{ AgentSession }, loader] = await Promise.all([import(sessionUrl), import(loaderUrl)]);
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
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getSessionId: () => extras.sessionId ?? "s",
      getEntries: () => extras.entries ?? [],
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
      hasConfiguredAuth: () => extras.hasAuth ?? true,
      checkAuth: async () => (extras.hasAuth === false ? undefined : {}),
      isUsingOAuth: () => false,
      getModel: () => extras.model ?? agent.state.model,
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

test("memory-lifecycle applies after reload-guard+reload-ui at fuzz 0", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = preparePatched();
  const types = readFileSync(join(pkgDir, "dist", "core", "extensions", "types.d.ts"), "utf8");
  assert.match(types, /export interface SessionAbortEvent/);
  assert.match(types, /export interface InputDispositionEvent/);
  assert.match(types, /inputId: string/);
  assert.match(types, /on\(event: "session_abort"/);
  assert.match(types, /on\(event: "input_disposition"/);
  const sessionJs = readFileSync(join(pkgDir, "dist", "core", "agent-session.js"), "utf8");
  assert.match(sessionJs, /type: "session_abort"/);
  assert.match(sessionJs, /type: "input_disposition"/);
  const rootDts = readFileSync(join(pkgDir, "dist", "index.d.ts"), "utf8");
  assert.match(rootDts, /SessionAbortEvent/);
  assert.match(rootDts, /InputDispositionEvent/);
});

test("negative drift: mutated abort() anchor fails memory-lifecycle.patch", { skip: SKIP ?? undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-lifecycle-drift-"));
  copyPristine(dir);
  const guard = runPatch([...PATCH_FLAGS, "-i", GUARD_PATCH], dir);
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  const ui = runPatch([...PATCH_FLAGS, "-i", UI_PATCH], dir);
  assert.equal(ui.status, 0, ui.stdout + ui.stderr);
  const target = join(dir, "dist", "core", "agent-session.js");
  const original = readFileSync(target, "utf8");
  const anchor = "    async abort() {\n        this.abortRetry();\n        this.agent.abort();\n        await this.waitForIdle();\n    }";
  assert.ok(original.includes(anchor), "post-reload-ui stock abort() hunk must still be present");
  writeFileSync(target, original.replace(anchor, "    async abort() {\n        this.abortRetry();\n        this.agent.abort(); // drifted-anchor\n        await this.waitForIdle();\n    }"));
  const result = runPatch([...PATCH_FLAGS, "-i", LIFE_PATCH], dir);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `drifted tree must reject memory-lifecycle, got ${result.status}: ${out}`);
  assert.match(out, /hunks failed|failed while patching/i);
  assert.doesNotMatch(out, /previously applied/);
});

test("started/queued/rejected dispositions preserve input ids; extension source is not a human nudge", { skip: SKIP ?? undefined }, async () => {
  const [{ createMemoryNudgeWiring }] = await loadConsumers();
  const { AgentSession, loader } = await loadPatchedSession();
  const runtime = loader.createExtensionRuntime();
  const seen = [];
  const wiring = createMemoryNudgeWiring({
    resolveContext: () => undefined,
    resolveSettings: () => ({ enabled: true, everyUserTurns: 2 }),
  });
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    wiring.register(pi);
    pi.on("input", (event) => {
      seen.push({ kind: "input", inputId: event.inputId, source: event.source, text: event.text });
    });
    pi.on("input_disposition", (event) => {
      seen.push({ kind: "disposition", inputId: event.inputId, disposition: event.disposition });
    });
  }, "/tmp", undefined, runtime);
  const { session, extensionRunnerRef, agent } = makeSession(AgentSession, [ext], runtime);
  const runner = extensionRunnerRef.current;
  await runner.emit({ type: "session_start", reason: "startup" });

  await session.prompt("from-extension", { source: "extension" });
  const inputExt = seen.find((row) => row.kind === "input" && row.source === "extension");
  const startedExt = seen.filter((row) => row.kind === "disposition" && row.inputId === inputExt.inputId);
  assert.equal(startedExt.length, 1);
  assert.equal(startedExt[0].disposition, "started");
  assert.notEqual(inputExt.inputId, "input");

  agent.state.model = undefined;
  await assert.rejects(() => session.prompt("no-model"));
  const rejected = seen.filter((row) => row.kind === "disposition" && row.disposition === "rejected");
  assert.equal(rejected.length, 1);
  const rejectedInput = seen.find((row) => row.kind === "input" && row.text === "no-model");
  assert.equal(rejectedInput.inputId, rejected[0].inputId);

  agent.state.model = { id: "m", provider: "test", name: "test-m" };
  session._isAgentRunActive = true;
  await session.prompt("queued-steer", { streamingBehavior: "steer" });
  const queued = seen.filter((row) => row.kind === "disposition" && row.disposition === "queued");
  assert.equal(queued.length, 1);
  const queuedInput = seen.find((row) => row.kind === "input" && row.text === "queued-steer");
  assert.equal(queuedInput.inputId, queued[0].inputId);
  session._isAgentRunActive = false;

  await session.prompt("human-two");
  const humanStarted = seen.filter((row) => row.kind === "disposition" && row.disposition === "started" && row.inputId !== startedExt[0].inputId);
  assert.ok(humanStarted.length >= 1);

  // extension started + rejected + queued(human) + started(human-two):
  // nudge counts only queued/started from non-extension inputs: queued-steer + human-two = 2
  assert.equal(wiring.provenance("s")?.userTurns, 2, "extension+rejected must not count; queued+started human turns count");
  assert.notEqual(queuedInput.inputId, rejectedInput.inputId);
  assert.notEqual(queuedInput.inputId, inputExt.inputId);
});

test("handled input emits handled disposition with the same id and does not start a turn", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatchedSession();
  const runtime = loader.createExtensionRuntime();
  const seen = [];
  let prompts = 0;
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("input", (event) => {
      seen.push({ kind: "input", inputId: event.inputId });
      return { action: "handled" };
    });
    pi.on("input_disposition", (event) => {
      seen.push({ kind: "disposition", inputId: event.inputId, disposition: event.disposition });
    });
  }, "/tmp", undefined, runtime);
  const agent = makeAgent();
  agent.prompt = async () => {
    prompts += 1;
  };
  const { session } = makeSession(AgentSession, [ext], runtime, { agent });
  await session.prompt("slash-like");
  assert.equal(prompts, 0, "handled input must not call agent.prompt");
  assert.deepEqual(seen.map((row) => row.kind), ["input", "disposition"]);
  assert.equal(seen[0].inputId, seen[1].inputId);
  assert.equal(seen[1].disposition, "handled");
});

test("unprepared input ids are unique across turns and resume of the same sessionId; never the emitInput default", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatchedSession();
  const runtime = loader.createExtensionRuntime();
  const ids = [];
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("input", (event) => {
      ids.push(event.inputId);
    });
  }, "/tmp", undefined, runtime);
  const first = makeSession(AgentSession, [ext], runtime, { sessionId: "s" });
  await first.session.prompt("one");
  await first.session.prompt("two");
  const runtime2 = loader.createExtensionRuntime();
  const idsResume = [];
  const ext2 = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("input", (event) => {
      idsResume.push(event.inputId);
    });
  }, "/tmp", undefined, runtime2);
  const resumed = makeSession(AgentSession, [ext2], runtime2, { sessionId: "s" });
  await resumed.session.prompt("resume-turn");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.equal(ids.length, 2);
  assert.equal(idsResume.length, 1);
  assert.match(ids[0], uuid);
  assert.match(ids[1], uuid);
  assert.match(idsResume[0], uuid);
  assert.notEqual(ids[0], ids[1]);
  assert.notEqual(ids[0], idsResume[0]);
  assert.notEqual(ids[1], idsResume[0]);
  assert.ok(!ids.concat(idsResume).includes("input"));
  assert.ok(!ids.concat(idsResume).some((id) => id.startsWith("s:")));
});

async function dreamAbortFixture() {
  const [, { createDreamTriggerWiring }] = await loadConsumers();
  const { AgentSession, loader } = await loadPatchedSession();
  const runtime = loader.createExtensionRuntime();
  const scheduled = [];
  const scheduler = {
    schedule(fire, delayMs) {
      const handle = { fire, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancel(handle) {
      handle.cancelled = true;
    },
  };
  const dreamSession = {
    conversationId: "s",
    identity: "id",
    identityPaths: { repo: "/tmp", conversation: "/tmp", identity: "/tmp" },
    getJournal: async () => ({ captureReflectionSnapshot: async () => ({}) }),
    store: { tryReserve: async () => ({ ok: false }) },
    launch() {
      throw new Error("dream must not launch after abort");
    },
  };
  const aborts = [];
  const wiring = createDreamTriggerWiring({
    resolveSession: () => dreamSession,
    resolveActiveSession: () => dreamSession,
    resolveSessionById: (id) => (id === "s" ? dreamSession : undefined),
    resolveSettings: () => ({ enabled: true, idleMinutes: 1, minHoursBetween: 0 }),
    now: () => 1,
    scheduler,
  });
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    wiring.register(pi);
    pi.on("session_abort", (event) => {
      aborts.push(event);
    });
  }, "/tmp", undefined, runtime);
  const { session, extensionRunnerRef, agent } = makeSession(AgentSession, [ext], runtime);
  return { session, agent, extensionRunnerRef, scheduled, aborts, wiring, AgentSession, loader, runtime };
}

test("idle abort does not emit session_abort (Senpi: no gap)", { skip: SKIP ?? undefined }, async () => {
  const { session, extensionRunnerRef, scheduled, aborts, wiring } = await dreamAbortFixture();
  await extensionRunnerRef.current.emit({ type: "agent_settled" });
  assert.equal(scheduled.length, 1);
  await session.abort();
  assert.equal(aborts.length, 0, "idle abort is not a Senpi session_abort gap");
  assert.equal(scheduled[0].cancelled, false, "idle timer stays armed");
  scheduled[0].cancelled = true;
  await wiring.whenIdle();
});

test("queued-continuation abort emits session_abort once and cancels the dream timer", { skip: SKIP ?? undefined }, async () => {
  const { session, extensionRunnerRef, scheduled, aborts, wiring } = await dreamAbortFixture();
  await extensionRunnerRef.current.emit({ type: "agent_settled" });
  session._isAgentRunActive = true;
  await session.prompt("queued-while-running", { streamingBehavior: "steer", source: "interactive" });
  session._isAgentRunActive = false;
  assert.ok(session.pendingMessageCount > 0);
  await session.abort();
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].type, "session_abort");
  assert.equal(scheduled[0].cancelled, true);
  scheduled[0].fire();
  await wiring.whenIdle();
});

test("mid-run abort does not emit session_abort; settle may re-arm", { skip: SKIP ?? undefined }, async () => {
  const { session, agent, extensionRunnerRef, scheduled, aborts } = await dreamAbortFixture();
  await extensionRunnerRef.current.emit({ type: "agent_settled" });
  await extensionRunnerRef.current.emit({ type: "agent_start" });
  assert.equal(scheduled[0].cancelled, true, "agent_start resets the timer");
  session._isAgentRunActive = true;
  agent.abort = () => {
    session._isAgentRunActive = false;
  };
  await session.abort();
  assert.equal(aborts.length, 0, "streaming abort is agent_end provenance, not session_abort");
  await extensionRunnerRef.current.emit({ type: "agent_settled" });
  assert.equal(scheduled.length, 2, "settle after mid-run abort re-arms");
  assert.equal(scheduled[1].cancelled, false);
});

test("normal started turn still runs the stock agent loop after disposition", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatchedSession();
  const runtime = loader.createExtensionRuntime();
  const order = [];
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("input", (event) => {
      order.push(`input:${event.inputId}`);
    });
    pi.on("input_disposition", (event) => {
      order.push(`${event.disposition}:${event.inputId}`);
    });
  }, "/tmp", undefined, runtime);
  let prompted = 0;
  const agent = makeAgent();
  agent.prompt = async (messages) => {
    prompted += 1;
    order.push("agent.prompt");
    assert.equal(messages[0].role, "user");
  };
  const { session } = makeSession(AgentSession, [ext], runtime, { agent });
  await session.prompt("hello-loop");
  assert.equal(prompted, 1);
  assert.match(order[0], /^input:[0-9a-f-]{36}$/i);
  assert.equal(order[1], `started:${order[0].slice("input:".length)}`);
  assert.equal(order[2], "agent.prompt");
  assert.notEqual(order[0], "input:input");
});
