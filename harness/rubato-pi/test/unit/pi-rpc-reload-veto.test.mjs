// RPC reload / check_reload_veto host wiring on stock Pi 0.84.2.
// Chain: reload-guard → reload-ui → memory-lifecycle → session-control → rpc-reload-veto.
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
const PATCH_DIR = join(repoRoot, "harness", "pi-patches", "pi-coding-agent", "0.84.2");
const PATCHES = [
  "reload-guard.patch",
  "reload-ui.patch",
  "memory-lifecycle.patch",
  "session-control.patch",
  "rpc-reload-veto.patch",
].map((name) => join(PATCH_DIR, name));
const GUARD_TS = join(repoRoot, "packages", "rubato-runtime", "src", "components", "task", "reload-guard.ts");
const STATUS_LINE_TS = join(repoRoot, "packages", "senpi-task", "src", "status-line.ts");
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
  if (PATCHES.some((p) => !existsSync(p))) return "rpc-reload-veto patch chain missing";
  if (!existsSync(GUARD_TS)) return "reload-guard.ts missing";
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
  const dir = mkdtempSync(join(tmpdir(), "pi-rpc-reload-"));
  const pkgDir = join(dir, "pkg");
  copyPristine(pkgDir);
  for (const patch of PATCHES) {
    const result = runPatch([...PATCH_FLAGS, "-i", patch], pkgDir);
    assert.equal(result.status, 0, `${patch} failed: ${result.stdout}\n${result.stderr}`);
  }
  prepared = { dir, pkgDir };
  return prepared;
}

let hooksRegistered = false;
function loadGuard() {
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
  return import(pathToFileURL(GUARD_TS).href);
}

function runningRecord() {
  return {
    task_id: "st_9",
    status: "running",
    name: "deep-refactor",
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

function makeSession(AgentSession, extensions, runtime) {
  const extensionRunnerRef = { current: undefined };
  const session = new AgentSession({
    agent: {
      subscribe: () => () => {},
      abort() {},
      prompt: async () => {},
      state: { tools: [], messages: [], systemPrompt: "", model: undefined, thinkingLevel: "off" },
    },
    sessionManager: {
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getSessionId: () => "s",
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
  return { session, extensionRunnerRef };
}

test("rpc-reload-veto applies after session-control at fuzz 0", { skip: SKIP ?? undefined }, () => {
  const { pkgDir } = preparePatched();
  const mode = readFileSync(join(pkgDir, "dist", "modes", "rpc", "rpc-mode.js"), "utf8");
  assert.match(mode, /case "check_reload_veto":/);
  assert.match(mode, /await session.checkReloadVeto\(\)/);
  assert.match(mode, /case "reload":/);
  const client = readFileSync(join(pkgDir, "dist", "modes", "rpc", "rpc-client.js"), "utf8");
  assert.match(client, /type: "check_reload_veto"/);
  const types = readFileSync(join(pkgDir, "dist", "modes", "rpc", "rpc-types.d.ts"), "utf8");
  assert.match(types, /type: "check_reload_veto"/);
});

test("negative drift: mutated default: command switch fails rpc-reload-veto.patch", { skip: SKIP ?? undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rpc-reload-drift-"));
  copyPristine(dir);
  for (const patch of PATCHES.slice(0, 4)) {
    const result = runPatch([...PATCH_FLAGS, "-i", patch], dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const target = join(dir, "dist", "modes", "rpc", "rpc-mode.js");
  const original = readFileSync(target, "utf8");
  const anchor = "            default: {\n                const unknownCommand = command;";
  assert.ok(original.includes(anchor), "stock rpc-mode default: hunk must exist");
  writeFileSync(target, original.replace(anchor, "            default: {\n                const unknownCommand = command; // drifted"));
  const result = runPatch([...PATCH_FLAGS, "-i", PATCHES[4]], dir);
  const out = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, out);
  assert.match(out, /hunks failed|failed while patching/i);
});

test("RpcClient.checkReloadVeto/reload send the stock command types", { skip: SKIP ?? undefined }, async () => {
  const { pkgDir } = preparePatched();
  const { RpcClient } = await import(pathToFileURL(join(pkgDir, "dist", "modes", "rpc", "rpc-client.js")).href);
  const client = new RpcClient();
  const sent = [];
  client.send = async (command) => {
    sent.push(command);
    return { success: true, data: { cancelled: false } };
  };
  client.getData = RpcClient.prototype.getData;
  assert.equal(typeof client.checkReloadVeto, "function");
  assert.equal(typeof client.reload, "function");
  await client.checkReloadVeto();
  await client.reload();
  assert.deepEqual(sent.map((row) => row.type), ["check_reload_veto", "reload"]);
});

test("rpc-mode host expressions: checkReloadVeto then reload on a real patched AgentSession + wireReloadGuard", { skip: SKIP ?? undefined }, async () => {
  const { wireReloadGuard, evaluateReloadVeto } = await loadGuard();
  const { pkgDir } = preparePatched();
  const [{ AgentSession }, loader] = await Promise.all([
    import(pathToFileURL(join(pkgDir, "dist", "core", "agent-session.js")).href),
    import(pathToFileURL(join(pkgDir, "dist", "core", "extensions", "loader.js")).href),
  ]);
  const manager = {
    residentTaskIds: () => ["st_9"],
    get: () => runningRecord(),
  };
  const expected = evaluateReloadVeto(manager);
  assert.equal(expected?.cancel, true);
  const runtime = loader.createExtensionRuntime();
  const guard = await loader.loadExtensionFromFactory(async (pi) => {
    wireReloadGuard(pi, manager);
  }, "/tmp", undefined, runtime);
  const { session } = makeSession(AgentSession, [guard], runtime);
  // Same calls rpc-mode handleCommand now makes.
  const veto = await session.checkReloadVeto();
  assert.deepEqual(veto, { cancelled: true, reason: expected.reason });
  const reload = await session.reload();
  assert.deepEqual(reload, { cancelled: true, reason: expected.reason });
});
