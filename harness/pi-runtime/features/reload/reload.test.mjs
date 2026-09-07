import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(featureDir, "../..");
const pristinePackage =
  process.env.PI_RELOAD_TEST_PACKAGE ??
  resolvePiRuntime({ root: runtimeRoot }).codingAgentDir;

const scratchRoot = mkdtempSync(join(tmpdir(), "rubato-pi-reload-"));
const patchedPackage = join(scratchRoot, "pi-coding-agent");

after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function preparePatchedPackage() {
  mkdirSync(patchedPackage, { recursive: true });
  cpSync(join(pristinePackage, "dist"), join(patchedPackage, "dist"), {
    recursive: true,
  });
  cpSync(join(pristinePackage, "package.json"), join(patchedPackage, "package.json"));
  symlinkSync(join(pristinePackage, "node_modules"), join(patchedPackage, "node_modules"), "dir");

  for (const spec of patches) {
    const target = join(patchedPackage, spec.path);
    const source = readFileSync(target, "utf8");
    assert.equal(sha256(source), spec.preimageSha256, `${spec.path} pristine hash`);
    writeFileSync(target, spec.apply(source));
  }
}

preparePatchedPackage();

test("patch manifest is version-locked, drift-strict, and produces valid JavaScript", () => {
  assert.equal(patches.length, 12);
  assert.equal(new Set(patches.map((patch) => patch.id)).size, patches.length);

  for (const spec of patches) {
    assert.equal(spec.packageName, "@earendil-works/pi-coding-agent");
    assert.equal(spec.version, "0.85.1");

    const pristine = readFileSync(join(pristinePackage, spec.path), "utf8");
    assert.equal(sha256(pristine), spec.preimageSha256, `${spec.path} hash`);
    const output = spec.apply(pristine);
    assert.notEqual(output, pristine, `${spec.path} changed`);
    assert.throws(() => spec.apply(output), /expected anchor is missing/, `${spec.path} rejects reapplication`);

    if (spec.path.endsWith(".js")) {
      const syntax = spawnSync(process.execPath, ["--check", join(patchedPackage, spec.path)], {
        encoding: "utf8",
        env: withoutNodeOptions(process.env),
      });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
});

test("actual SDK reload honors veto, closes the UI-precheck race, and only then tears down", async () => {
  const moduleUrl = pathToFileURL(join(patchedPackage, "dist/index.js")).href;
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(moduleUrl);
  const cwd = join(scratchRoot, "sdk-cwd");
  const agentDir = join(scratchRoot, "sdk-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const state = {
    decisions: [],
    checks: 0,
    shutdowns: 0,
  };
  const guard = (pi) => {
    pi.on("session_before_reload", () => {
      const decision =
        state.checks < state.decisions.length
          ? state.decisions[state.checks]
          : state.decisions.at(-1);
      state.checks += 1;
      return decision;
    });
    pi.on("session_shutdown", (event) => {
      if (event.reason === "reload") state.shutdowns += 1;
    });
  };

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "test-reload-guard", factory: guard }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });

  state.decisions = [{ cancel: true, reason: "resident task is running" }];
  const initialRunner = session.extensionRunner;
  assert.deepEqual(await session.reload(), {
    cancelled: true,
    reason: "resident task is running",
  });
  assert.equal(session.extensionRunner, initialRunner);
  assert.equal(state.shutdowns, 0);

  // Simulate the interactive command's first probe allowing reload while task
  // state changes before AgentSession.reload() performs its authoritative check.
  state.checks = 0;
  state.decisions = [undefined, { cancel: true, reason: "task started during reload" }];
  assert.deepEqual(await session.checkReloadVeto(), { cancelled: false });
  assert.deepEqual(await session.reload(), {
    cancelled: true,
    reason: "task started during reload",
  });
  assert.equal(session.extensionRunner, initialRunner);
  assert.equal(state.shutdowns, 0);

  state.checks = 0;
  state.decisions = [undefined];
  assert.deepEqual(await session.reload(), { cancelled: false });
  assert.notEqual(session.extensionRunner, initialRunner);
  assert.equal(state.shutdowns, 1);
});

test("interactive reload veto leaves the current editor and extension UI untouched", async () => {
  const interactiveUrl = pathToFileURL(
    join(patchedPackage, "dist/modes/interactive/interactive-mode.js"),
  ).href;
  const { InteractiveMode } = await import(interactiveUrl);
  const warnings = [];
  let reloadCalls = 0;
  let resetCalls = 0;
  const fakeMode = {
    session: {
      isStreaming: false,
      isCompacting: false,
      checkReloadVeto: async () => ({ cancelled: true, reason: "reload guard" }),
      reload: async () => {
        reloadCalls += 1;
        return { cancelled: false };
      },
    },
    showWarning: (message) => warnings.push(message),
    resetExtensionUI: () => {
      resetCalls += 1;
    },
  };

  await InteractiveMode.prototype.handleReloadCommand.call(fakeMode);

  assert.deepEqual(warnings, ["reload guard"]);
  assert.equal(reloadCalls, 0);
  assert.equal(resetCalls, 0);
});

test("unbundled RPC entry returns veto state for precheck and reload without a provider call", async (t) => {
  const cwd = join(scratchRoot, "rpc-cwd");
  const agentDir = join(scratchRoot, "rpc-agent");
  const sessionDir = join(scratchRoot, "rpc-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "reload-test": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "unused-test-key",
          models: [{ id: "never-called" }],
        },
      },
    }),
  );
  const extensionPath = join(scratchRoot, "rpc-reload-guard.mjs");
  writeFileSync(
    extensionPath,
    `export default function reloadGuard(pi) {
  pi.on("session_before_reload", () => ({ cancel: true, reason: "rpc guard" }));
}
`,
  );

  const child = spawn(
    process.execPath,
    [
      join(patchedPackage, "dist/rpc-entry.js"),
      "--offline",
      "--approve",
      "--provider",
      "reload-test",
      "--model",
      "never-called",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--session-dir",
      sessionDir,
      "--extension",
      extensionPath,
    ],
    {
      cwd,
      env: {
        ...withoutNodeOptions(process.env),
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const channel = jsonLineChannel(child);
  t.after(async () => {
    if (child.exitCode === null) child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const precheck = channel.waitForResponse("precheck");
  child.stdin.write(`${JSON.stringify({ id: "precheck", type: "check_reload_veto" })}\n`);
  assert.deepEqual(await precheck, {
    id: "precheck",
    type: "response",
    command: "check_reload_veto",
    success: true,
    data: { cancelled: true, reason: "rpc guard" },
  });

  const reload = channel.waitForResponse("reload");
  child.stdin.write(`${JSON.stringify({ id: "reload", type: "reload" })}\n`);
  assert.deepEqual(await reload, {
    id: "reload",
    type: "response",
    command: "reload",
    success: true,
    data: { cancelled: true, reason: "rpc guard" },
  });
});

function withoutNodeOptions(env) {
  const copy = { ...env };
  delete copy.NODE_OPTIONS;
  return copy;
}

function jsonLineChannel(child) {
  const emitter = new EventEmitter();
  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        emitter.emit("message", JSON.parse(line));
      } catch {
        emitter.emit("protocol-error", new Error(`non-JSON RPC output: ${line}`));
      }
    }
  });

  return {
    waitForResponse(id, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          emitter.off("message", onMessage);
          emitter.off("protocol-error", onProtocolError);
          child.off("exit", onExit);
          child.off("error", onError);
        };
        const onMessage = (message) => {
          if (message?.type !== "response" || message.id !== id) return;
          cleanup();
          resolve(message);
        };
        const onProtocolError = (error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(`RPC exited before ${id}: code=${code} signal=${signal}; stderr=${stderr}`));
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for RPC ${id}; stderr=${stderr}`));
        }, timeoutMs);
        emitter.on("message", onMessage);
        emitter.on("protocol-error", onProtocolError);
        child.on("exit", onExit);
        child.on("error", onError);
      });
    },
  };
}
