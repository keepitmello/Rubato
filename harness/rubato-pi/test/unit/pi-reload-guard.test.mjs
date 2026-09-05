// Patched-stock reload-guard proof: cancellable `session_before_reload` on real
// pi-coding-agent 0.84.2 (harness/pi-patches/pi-coding-agent/0.84.2/).
//
// Imports the actual exported wireReloadGuard/evaluateReloadVeto from
// packages/rubato-runtime/src/components/task/reload-guard.ts and drives them
// through a real patched AgentSession.reload()/checkReloadVeto(). Mocks are
// constructor DI only — no replacement host, no paid API, no live session.
//
// Fixture: isolated stock 0.84.2 install (scripts disabled). Consumed via
// PI_STOCK_FIXTURE_DIR, default /tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent.
// SKIPS (never fake-passes) when the fixture is absent or version-mismatched.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const PATCH = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2", "reload-guard.patch");
const GUARD_TS = join(repoRoot, "packages", "rubato-runtime", "src", "components", "task", "reload-guard.ts");
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
  if (!existsSync(PATCH)) return `patch missing at ${PATCH}`;
  if (!existsSync(GUARD_TS)) return `reload-guard.ts missing at ${GUARD_TS}`;
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

function applyPatch(pkgDir) {
  const result = runPatch([...PATCH_FLAGS, "-i", PATCH], pkgDir);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `patch apply failed (${result.status}): ${out}`);
  assert.match(out, /patching file 'dist\/core\/agent-session\.js'/);
  assert.match(out, /patching file 'dist\/core\/extensions\/runner\.js'/);
  return out;
}

let prepared = null;
function preparePatched() {
  if (prepared) return prepared;
  const dir = mkdtempSync(join(tmpdir(), "pi-reload-guard-"));
  const pkgDir = join(dir, "pkg");
  copyPristine(pkgDir);
  applyPatch(pkgDir);
  prepared = { dir, pkgDir };
  return prepared;
}

let guardModPromise = null;
let hooksRegistered = false;
function loadGuardExports() {
  if (!guardModPromise) {
    if (!hooksRegistered) {
      hooksRegistered = true;
      const piTui = join(FIXTURE, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@rubato/senpi-task") {
            return { url: pathToFileURL(STATUS_LINE_TS).href, shortCircuit: true };
          }
          if (specifier === "@earendil-works/pi-tui" && existsSync(piTui)) {
            return { url: pathToFileURL(piTui).href, shortCircuit: true };
          }
          if (specifier.startsWith(".") && context.parentURL) {
            const parent = fileURLToPath(context.parentURL);
            if (parent.includes("/packages/senpi-task/") || parent.includes("/packages/rubato-runtime/")) {
              let candidate = join(dirname(parent), specifier);
              if (!existsSync(candidate)) {
                if (existsSync(`${candidate}.ts`)) candidate = `${candidate}.ts`;
                else if (existsSync(join(candidate, "index.ts"))) candidate = join(candidate, "index.ts");
              }
              if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
            }
          }
          return nextResolve(specifier, context);
        },
      });
    }
    guardModPromise = import(pathToFileURL(GUARD_TS).href);
  }
  return guardModPromise;
}

async function loadPatchedSession() {
  const { pkgDir } = preparePatched();
  const sessionUrl = pathToFileURL(join(pkgDir, "dist", "core", "agent-session.js")).href;
  const loaderUrl = pathToFileURL(join(pkgDir, "dist", "core", "extensions", "loader.js")).href;
  const [{ AgentSession }, loader] = await Promise.all([import(sessionUrl), import(loaderUrl)]);
  return { AgentSession, loader, pkgDir };
}

function runningRecord(name = "deep-refactor") {
  return {
    task_id: "st_9",
    status: "running",
    name,
    parent_session_id: "parent",
    root_session_id: "root",
    depth: 1,
    execution_mode: "in-process",
    model: "faux/faux-1",
    residency_state: "resident",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
    notification: { run_epoch: 1, notified_epoch: 0 },
    notify_on_terminal: false,
  };
}

function managerOf(records) {
  return {
    residentTaskIds: () => records.map((entry) => entry.task_id),
    get: (taskId) => records.find((entry) => entry.task_id === taskId),
  };
}

function makeSession(AgentSession, extensions, runtime, counters) {
  const extensionRunnerRef = { current: undefined };
  const agent = {
    subscribe: () => () => {},
    state: { tools: [], messages: [], systemPrompt: "", model: undefined, thinkingLevel: "off" },
  };
  const session = new AgentSession({
    agent,
    sessionManager: {
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getSessionId: () => "s",
    },
    settingsManager: {
      getImageAutoResize: () => false,
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
      reload: async () => {
        counters.settings += 1;
      },
      isProjectTrusted: () => true,
      getSteeringMode: () => "all",
      getFollowUpMode: () => "all",
    },
    cwd: "/tmp",
    resourceLoader: {
      getExtensions: () => ({ extensions, runtime }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPrompts: () => ({ prompts: [] }),
      reload: async () => {
        counters.resource += 1;
      },
    },
    modelRuntime: {
      registerProvider() {},
      registerNativeProvider() {},
      unregisterProvider() {},
      hasConfiguredAuth: () => false,
      getModel: () => undefined,
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

test("patch applies at fuzz 0 on pristine stock", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = preparePatched();
  assert.ok(existsSync(join(pkgDir, "dist", "core", "agent-session.js")));
});

test("negative drift rejection: mutated pristine hunk anchor fails to apply", { skip: SKIP ?? undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reload-guard-drift-"));
  copyPristine(dir);
  const target = join(dir, "dist", "core", "agent-session.js");
  const original = readFileSync(target, "utf8");
  const anchor = "    async reload(options) {\n        const oldRunner = this._extensionRunner;";
  assert.ok(original.includes(anchor), "pristine stock must still contain the reload() hunk anchor");
  writeFileSync(target, original.replace(anchor, "    async reload(options) {\n        const oldRunner = this._extensionRunner; // drifted-anchor"));
  const result = runPatch([...PATCH_FLAGS, "-i", PATCH], dir);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `drifted tree must reject the patch, got exit ${result.status}: ${out}`);
  assert.match(out, /hunks failed|failed while patching/i, "rejection must be a failed hunk, not a silent skip");
  assert.doesNotMatch(out, /previously applied/, "drift is not second-apply detection");
});

test("patched public types carry reload-gate contracts", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = preparePatched();
  const sessionDts = readFileSync(join(pkgDir, "dist", "core", "agent-session.d.ts"), "utf8");
  assert.match(sessionDts, /checkReloadVeto\(\): Promise<\{/);
  assert.match(sessionDts, /cancelled: boolean;/);
  const typesDts = readFileSync(join(pkgDir, "dist", "core", "extensions", "types.d.ts"), "utf8");
  assert.match(typesDts, /export interface SessionBeforeReloadEvent/);
  assert.match(typesDts, /type: "session_before_reload"/);
  assert.match(typesDts, /export interface SessionBeforeReloadResult/);
  assert.match(typesDts, /export interface ReloadVetoDecision/);
  assert.match(typesDts, /on\(event: "session_before_reload"/);
  assert.match(typesDts, /SessionBeforeReloadEvent \| SessionBeforeCompactEvent/);
  assert.match(typesDts, /reload\(\): Promise<void>/, "command-context reload stays Promise<void>");
  assert.match(typesDts, /reload: \(\) => Promise<void>/, "command-context actions reload stays Promise<void>");
  assert.doesNotMatch(typesDts, /checkReloadVeto\?\(/, "ctx.checkReloadVeto is not promised");
  const runnerDts = readFileSync(join(pkgDir, "dist", "core", "extensions", "runner.d.ts"), "utf8");
  assert.match(runnerDts, /type: "session_before_reload"/);
  assert.match(runnerDts, /SessionBeforeReloadResult/);
  assert.match(runnerDts, /ReloadHandler = \(\) => Promise<void>/);
  const indexDts = readFileSync(join(pkgDir, "dist", "core", "extensions", "index.d.ts"), "utf8");
  assert.match(indexDts, /SessionBeforeReloadEvent/);
  assert.match(indexDts, /ReloadVetoDecision/);
  const rootDts = readFileSync(join(pkgDir, "dist", "index.d.ts"), "utf8");
  assert.match(rootDts, /SessionBeforeReloadEvent/);
  assert.match(rootDts, /SessionBeforeReloadResult/);
  assert.match(rootDts, /ReloadVetoDecision/);
});

test("wireReloadGuard active veto cancels AgentSession.reload before teardown", { skip: SKIP ?? undefined }, async () => {
  const { wireReloadGuard, evaluateReloadVeto } = await loadGuardExports();
  const { AgentSession, loader } = await loadPatchedSession();
  const manager = managerOf([runningRecord("deep-refactor")]);
  const expected = evaluateReloadVeto(manager);
  assert.equal(expected?.cancel, true);
  const counters = { settings: 0, resource: 0, shutdown: 0, later: 0 };
  const runtime = loader.createExtensionRuntime();
  const guard = await loader.loadExtensionFromFactory(async (pi) => {
    wireReloadGuard(pi, manager);
  }, "/tmp", undefined, runtime);
  const later = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("session_before_reload", () => {
      counters.later += 1;
    });
    pi.on("session_shutdown", () => {
      counters.shutdown += 1;
    });
  }, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [guard, later], runtime, counters);
  const probed = await session.checkReloadVeto();
  assert.deepEqual(probed, { cancelled: true, reason: expected.reason });
  const result = await session.reload();
  assert.deepEqual(result, { cancelled: true, reason: expected.reason });
  assert.equal(counters.later, 0, "cancel must short-circuit later session_before_reload hooks");
  assert.equal(counters.shutdown, 0, "no session_shutdown on a vetoed reload");
  assert.equal(counters.settings, 0, "settings must not reload on veto");
  assert.equal(counters.resource, 0, "resources must not reload on veto");
});

test("stock-like ctx.reload discards AgentSession return (command-context stays void)", { skip: SKIP ?? undefined }, async () => {
  const { wireReloadGuard, evaluateReloadVeto } = await loadGuardExports();
  const { AgentSession, loader } = await loadPatchedSession();
  const manager = managerOf([runningRecord("deep-refactor")]);
  const expected = evaluateReloadVeto(manager);
  const counters = { settings: 0, resource: 0, shutdown: 0 };
  const runtime = loader.createExtensionRuntime();
  const guard = await loader.loadExtensionFromFactory(async (pi) => {
    wireReloadGuard(pi, manager);
  }, "/tmp", undefined, runtime);
  const { session, extensionRunnerRef } = makeSession(AgentSession, [guard], runtime, counters);
  const runner = extensionRunnerRef.current;
  assert.ok(runner);
  let inner;
  runner.bindCommandContext({
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    // Stock rpc-mode.js / interactive-mode.js: await session.reload() and drop the result.
    reload: async () => {
      inner = await session.reload();
    },
  });
  const ctxResult = await runner.createCommandContext().reload();
  assert.equal(ctxResult, undefined, "ctx.reload() must remain void at the stock host seam");
  assert.deepEqual(inner, { cancelled: true, reason: expected.reason });
  assert.equal(counters.shutdown, 0);
});

test("idle wireReloadGuard and no-handler reload proceed through AgentSession.reload", { skip: SKIP ?? undefined }, async () => {
  const { wireReloadGuard, evaluateReloadVeto } = await loadGuardExports();
  const { AgentSession, loader } = await loadPatchedSession();
  const idleManager = managerOf([{ ...runningRecord("done"), status: "completed" }]);
  assert.equal(evaluateReloadVeto(idleManager), undefined);

  const idleCounters = { settings: 0, resource: 0, shutdown: 0 };
  const idleRuntime = loader.createExtensionRuntime();
  const idleGuard = await loader.loadExtensionFromFactory(async (pi) => {
    wireReloadGuard(pi, idleManager);
    pi.on("session_shutdown", () => {
      idleCounters.shutdown += 1;
    });
  }, "/tmp", undefined, idleRuntime);
  const idle = makeSession(AgentSession, [idleGuard], idleRuntime, idleCounters);
  assert.deepEqual(await idle.session.checkReloadVeto(), { cancelled: false });
  assert.deepEqual(await idle.session.reload(), { cancelled: false });
  assert.equal(idleCounters.shutdown, 1);
  assert.equal(idleCounters.settings, 1);
  assert.equal(idleCounters.resource, 1);

  const noneCounters = { settings: 0, resource: 0, shutdown: 0 };
  const noneRuntime = loader.createExtensionRuntime();
  const noneExt = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("session_shutdown", () => {
      noneCounters.shutdown += 1;
    });
  }, "/tmp", undefined, noneRuntime);
  const none = makeSession(AgentSession, [noneExt], noneRuntime, noneCounters);
  assert.deepEqual(await none.session.checkReloadVeto(), { cancelled: false });
  assert.deepEqual(await none.session.reload(), { cancelled: false });
  assert.equal(noneCounters.shutdown, 1);
});

test("pre-existing session_before_switch/fork hooks unchanged on patched runner", { skip: SKIP ?? undefined }, async () => {
  const { AgentSession, loader } = await loadPatchedSession();
  const counters = { settings: 0, resource: 0, shutdown: 0 };
  const runtime = loader.createExtensionRuntime();
  const ext = await loader.loadExtensionFromFactory(async (pi) => {
    pi.on("session_before_switch", () => undefined);
    pi.on("session_before_fork", () => ({ cancel: true, reason: "fork veto" }));
    pi.on("session_shutdown", (event) => {
      counters.reason = event.reason;
    });
  }, "/tmp", undefined, runtime);
  const { extensionRunnerRef } = makeSession(AgentSession, [ext], runtime, counters);
  const runner = extensionRunnerRef.current;
  assert.ok(runner);
  assert.equal(await runner.emit({ type: "session_before_switch" }), undefined);
  assert.deepEqual(await runner.emit({ type: "session_before_fork" }), { cancel: true, reason: "fork veto" });
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(counters.reason, "reload");
});
