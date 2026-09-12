// Dependency-free regression tests. Production modules are imported unchanged;
// only network/build work and the Pi validator/agent interface are test doubles.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeFileTool, hostEdit, hostWrite } from "../features/provider-execution/cursor-host-mutation.mjs";
import { executeRegisteredTool } from "../features/tool-execution/runtime.mjs";
import { stageAndPublishInstall } from "../scripts/install-transaction.mjs";
import { sourceFingerprint } from "../scripts/source-fingerprint.mjs";
import { engineStatus, installStockEngine, switchEngine, updateStockEngine } from "../scripts/switch-engine.mjs";
import { buildActiveEngine } from "../../scripts/build-active-engine.mjs";
import { resolveExecutionEngine, resolveLaunchEngine } from "../../rubato-pi/src/engine-selection.mjs";
import { nodeSatisfiesCandidate, parseVersionText, pickNode, selectNodeForEngine } from "../../rubato-pi/src/select-node.mjs";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "rubato-migration-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const retire = (path) => rm(path, { recursive: true, force: true });
const node26 = parseVersionText("v26.0.0", "/fixture/node26");

for (const action of ["write", "edit"]) {
  test(`${action} preserves executable permission bits`, async (t) => {
    const cwd = await scratch(t);
    await writeFile(join(cwd, "run.sh"), "before");
    await chmod(join(cwd, "run.sh"), 0o755);
    if (action === "write") await hostWrite({ cwd, path: "run.sh", content: "after" });
    else await hostEdit({ cwd, path: "run.sh", edits: [{ oldText: "before", newText: "after" }] });
    assert.equal((await stat(join(cwd, "run.sh"))).mode & 0o777, 0o755);
    assert.equal(await readFile(join(cwd, "run.sh"), "utf8"), "after");
  });
  test(`${action} follows a symlink without replacing it`, async (t) => {
    const cwd = await scratch(t);
    await writeFile(join(cwd, "target"), "before");
    await symlink("target", join(cwd, "link"));
    if (action === "write") await hostWrite({ cwd, path: "link", content: "after" });
    else await hostEdit({ cwd, path: "link", edits: [{ oldText: "before", newText: "after" }] });
    assert.equal((await lstat(join(cwd, "link"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(cwd, "target"), "utf8"), "after");
  });
}

test("dangling link fails without replacing it; new files remain private", async (t) => {
  const cwd = await scratch(t);
  await symlink("missing", join(cwd, "link"));
  await assert.rejects(hostWrite({ cwd, path: "link", content: "bad" }), { code: "ENOENT" });
  assert.equal((await lstat(join(cwd, "link"))).isSymbolicLink(), true);
  await hostWrite({ cwd, path: "new", content: "ok" });
  assert.equal((await stat(join(cwd, "new"))).mode & 0o777, 0o600);
  assert.equal((await readdir(cwd)).some((name) => name.includes(".rubato-write-")), false);
});

test("link and target edits share one lock", async (t) => {
  const cwd = await scratch(t);
  await writeFile(join(cwd, "target"), "first second");
  await symlink("target", join(cwd, "link"));
  await Promise.all([
    hostEdit({ cwd, path: "link", edits: [{ oldText: "first", newText: "ONE" }] }),
    hostEdit({ cwd, path: "target", edits: [{ oldText: "second", newText: "TWO" }] }),
  ]);
  assert.equal(await readFile(join(cwd, "target"), "utf8"), "ONE TWO");
});

class ExecuteToolError extends Error {
  constructor(code, _name, message) { super(message); this.code = code; }
}
function harness({ before, after, validate } = {}) {
  return {
    session: {
      agent: { state: { tools: [] }, beforeToolCall: before, afterToolCall: after },
      getActiveToolNames: () => [], _toolDefinitions: new Map(), _lazyToolActivators: [],
    },
    dependencies: { ExecuteToolError, validateToolArguments: validate ?? ((_tool, call) => call.arguments) },
  };
}

test("native write is blocked by the common hook before touching disk", async (t) => {
  const cwd = await scratch(t);
  const order = [];
  const { session, dependencies } = harness({
    validate: (_tool, call) => { order.push("validate"); return call.arguments; },
    before: ({ toolCall }) => { order.push(toolCall.name); return { block: true, reason: "denied" }; },
  });
  await assert.rejects(executeRegisteredTool(session, "write", { path: "blocked", content: "bad" }, {
    nativeFileTool: createNativeFileTool("write", cwd), toolCallId: "native-write",
  }, dependencies), (error) => error.code === "blocked");
  assert.deepEqual(order, ["validate", "write"]);
  assert.equal(existsSync(join(cwd, "blocked")), false);
});

test("hidden native edit retains validation, result hooks, and original name", async (t) => {
  const cwd = await scratch(t);
  await writeFile(join(cwd, "file"), "before");
  const seen = [];
  const { session, dependencies } = harness({
    before: ({ toolCall }) => { seen.push(toolCall.name); },
    after: ({ toolCall }) => { seen.push(toolCall.name); return { content: [{ type: "text", text: "after-hook" }] }; },
  });
  const result = await executeRegisteredTool(session, "edit", {
    path: "file", edits: [{ oldText: "before", newText: "after" }],
  }, { nativeFileTool: createNativeFileTool("edit", cwd) }, dependencies);
  assert.equal(result.isError, false);
  assert.deepEqual(seen, ["edit", "edit"]);
  assert.equal(result.content[0].text, "after-hook");
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "after");
  assert.deepEqual(session.getActiveToolNames(), []);
});

test("validator rejection and cancellation cannot write a native file", async (t) => {
  const cwd = await scratch(t);
  let hooks = 0;
  const { session, dependencies } = harness({
    validate: () => { throw new Error("schema failure"); }, before: () => { hooks++; },
  });
  const options = { nativeFileTool: createNativeFileTool("write", cwd) };
  await assert.rejects(executeRegisteredTool(session, "write", { path: "file", content: "bad" }, options, dependencies),
    (error) => error.code === "invalid_params");
  assert.equal(hooks, 0);
  const allowed = harness();
  const result = await executeRegisteredTool(allowed.session, "write", { path: "file", content: "bad" }, {
    ...options, signal: AbortSignal.abort(new Error("cancelled")),
  }, allowed.dependencies);
  assert.equal(result.isError, true);
  assert.equal(existsSync(join(cwd, "file")), false);
});

test("native capability rejects unrelated tools and normal inactive tools stay inactive", async () => {
  const { session, dependencies } = harness();
  await assert.rejects(executeRegisteredTool(session, "bash", {}, {
    nativeFileTool: { name: "bash", parameters: {}, execute() {} },
  }, dependencies), /Invalid native/);
  session._toolDefinitions.set("write", { definition: { allowLazyActivation: false } });
  await assert.rejects(executeRegisteredTool(session, "write", {}, { activateInactiveTool: true }, dependencies),
    (error) => error.code === "inactive_tool");
});

test("native bytes are normalized for schema validation", () => {
  const tool = createNativeFileTool("write", "/fixture");
  assert.deepEqual(tool.prepareArguments({ path: "x", bytes: new Uint8Array([0, 255]) }).bytes, [0, 255]);
});

for (const phase of ["download", "stage", "validation"]) {
  test(`failed ${phase} preserves the current and previous installs`, async (t) => {
    const home = await scratch(t);
    const dest = join(home, "engine");
    await mkdir(dest); await writeFile(join(dest, "ready"), "old");
    await mkdir(`${dest}.previous`); await writeFile(join(`${dest}.previous`, "ready"), "older");
    await assert.rejects(stageAndPublishInstall(dest, { mode: "update", retire,
      async build(stage) {
        assert.equal(await readFile(join(dest, "ready"), "utf8"), "old");
        if (phase !== "download") { await mkdir(stage); await writeFile(join(stage, "partial"), "not-ready"); }
        throw new Error(`injected ${phase}`);
      },
    }), new RegExp(`injected ${phase}`));
    assert.equal(await readFile(join(dest, "ready"), "utf8"), "old");
    assert.equal(await readFile(join(`${dest}.previous`, "ready"), "utf8"), "older");
    assert.deepEqual((await readdir(home)).sort(), ["engine", "engine.previous"]);
  });
}

test("successful publication keeps old files available throughout the build", async (t) => {
  const home = await scratch(t);
  const dest = join(home, "engine");
  await mkdir(dest); await writeFile(join(dest, "ready"), "old");
  const result = await stageAndPublishInstall(dest, { mode: "update", retire,
    async build(stage, current) {
      assert.equal(current, dest);
      assert.equal(await readFile(join(dest, "ready"), "utf8"), "old");
      await mkdir(stage); await writeFile(join(stage, "ready"), "new");
      return "receipt";
    },
  });
  assert.equal(result, "receipt");
  assert.equal(await readFile(join(dest, "ready"), "utf8"), "new");
  assert.equal(await readFile(join(`${dest}.previous`, "ready"), "utf8"), "old");
});

test("rename failure restores the current install", async (t) => {
  const home = await scratch(t);
  const dest = join(home, "engine");
  await mkdir(dest); await writeFile(join(dest, "ready"), "old");
  await assert.rejects(stageAndPublishInstall(dest, { mode: "update", retire,
    async build(stage) { await mkdir(stage); await writeFile(join(stage, "ready"), "new"); },
    async move(from, to) {
      if (from.endsWith("/candidate")) throw new Error("injected rename");
      return rename(from, to);
    },
  }), /injected rename/);
  assert.equal(await readFile(join(dest, "ready"), "utf8"), "old");
});

test("a failed snapshot rotation keeps the previous install restorable", async (t) => {
  const home = await scratch(t);
  const dest = join(home, "engine");
  await mkdir(dest); await writeFile(join(dest, "ready"), "old");
  await mkdir(`${dest}.previous`); await writeFile(join(`${dest}.previous`, "ready"), "older");
  await assert.rejects(stageAndPublishInstall(dest, { mode: "update", retire,
    async build(stage) { await mkdir(stage); await writeFile(join(stage, "ready"), "new"); },
    async move(from, to) {
      if (from === dest && to === `${dest}.previous`) throw new Error("injected snapshot rotation");
      return rename(from, to);
    },
  }), /injected snapshot rotation/);
  assert.equal(await readFile(join(dest, "ready"), "utf8"), "old");
  assert.equal(await readFile(join(`${dest}.previous`, "ready"), "utf8"), "older");
  assert.deepEqual((await readdir(home)).sort(), ["engine", "engine.previous"]);
});

test("a published update retires the superseded snapshot", async (t) => {
  const home = await scratch(t);
  const dest = join(home, "engine");
  await mkdir(dest); await writeFile(join(dest, "ready"), "old");
  await mkdir(`${dest}.previous`); await writeFile(join(`${dest}.previous`, "ready"), "older");
  await stageAndPublishInstall(dest, { mode: "update", retire,
    async build(stage) { await mkdir(stage); await writeFile(join(stage, "ready"), "new"); },
  });
  assert.equal(await readFile(join(dest, "ready"), "utf8"), "new");
  assert.equal(await readFile(join(`${dest}.previous`, "ready"), "utf8"), "old");
  assert.deepEqual((await readdir(home)).sort(), ["engine", "engine.previous"]);
});

test("failed first install leaves a reusable destination", async (t) => {
  const dest = join(await scratch(t), "engine");
  await assert.rejects(stageAndPublishInstall(dest, { mode: "install", retire,
    async build(stage) { await mkdir(stage); throw new Error("failure"); },
  }), /failure/);
  assert.equal(existsSync(dest), false);
  await stageAndPublishInstall(dest, { mode: "install", retire,
    async build(stage) { await mkdir(stage); await writeFile(join(stage, "ready"), "new"); },
  });
  assert.equal(await readFile(join(dest, "ready"), "utf8"), "new");
});

test("concurrent install writers are refused", async (t) => {
  const dest = join(await scratch(t), "engine");
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = stageAndPublishInstall(dest, { mode: "install", retire,
    async build(stage) { await mkdir(stage); entered(); await gate; },
  });
  try {
    await started;
    await assert.rejects(stageAndPublishInstall(dest, { mode: "install", retire, build() {} }), /Another install operation/);
  } finally { release(); await first; }
});

async function fakeInstall({ outputRoot }) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, "candidate.mjs"), "export {};\n");
  const receipt = { version: 1, state: "ready", stockVersion: "0.85.1", features: ["fixture"], candidateEntry: "candidate.mjs" };
  await writeFile(join(outputRoot, "rubato-install.json"), JSON.stringify(receipt));
  return { root: outputRoot, receipt };
}

test("status reports fallback for a missing install, matching launch", async (t) => {
  const home = await scratch(t);
  await mkdir(join(home, ".rubato-pi"));
  await writeFile(join(home, ".rubato-pi/engine.json"), JSON.stringify({ engine: "stock-pi" }));
  const env = { HOME: home };
  const status = await engineStatus({ home, env, selectNode: () => node26 });
  const launch = resolveExecutionEngine({ env, selectNode: () => node26 });
  assert.equal(status.engine, "senpi"); assert.equal(status.requested, "stock-pi");
  assert.equal(status.fallback, true); assert.equal(status.installed, false);
  assert.equal(status.engine, launch.engine); assert.equal(status.notice, launch.notice);
});

test("explicit engine and custom install root are honored by status/update", async (t) => {
  const home = await scratch(t);
  const custom = join(home, "custom-engine");
  const env = { HOME: home, RUBATO_STOCK_ENGINE_DIR: custom };
  await installStockEngine({ home, env, install: fakeInstall });
  await switchEngine({ home, env });
  assert.equal(resolveLaunchEngine({ env }).root, custom);
  const status = await engineStatus({ home, env: { ...env, RUBATO_ENGINE: "senpi" }, selectNode: () => node26 });
  assert.equal(status.engine, "senpi"); assert.equal(status.source, "env");
  let call;
  await updateStockEngine({ home, env, install: async (options) => { call = options; } });
  assert.deepEqual(call, { outputRoot: custom, mode: "update" });
});

test("status and launch both report unsupported Node fallback", async (t) => {
  const home = await scratch(t);
  const env = { HOME: home };
  await installStockEngine({ home, env, install: fakeInstall });
  const selectNode = () => parseVersionText("v24.10.0", "/fixture/node24");
  const status = await engineStatus({ home, env, selectNode });
  const launch = resolveExecutionEngine({ env, selectNode });
  assert.equal(status.engine, "senpi"); assert.equal(status.fallback, true);
  assert.equal(status.notice, launch.notice); assert.match(status.notice, /Node/);
});

test("compatible Node wins over an incompatible running 24.x", () => {
  const old = parseVersionText("v24.10.0", "/fixture/node24");
  const candidates = [old.bin, node26.bin];
  const version = (bin) => bin === old.bin ? old : node26;
  assert.equal(selectNodeForEngine("stock-pi", { running: old, candidates, version }).bin, node26.bin);
  assert.equal(pickNode(candidates, { version, accepts: (n) => nodeSatisfiesCandidate(n.text) }).bin, node26.bin);
  assert.equal(selectNodeForEngine("senpi", { running: old, candidates, version }).bin, old.bin);
  assert.equal(nodeSatisfiesCandidate("v25.9.0"), false);
  assert.equal(nodeSatisfiesCandidate("v24.15.0"), true);
});

test("fingerprint detects source edits/removals and ignores installed dependencies", async (t) => {
  const repo = await scratch(t);
  await mkdir(join(repo, "harness/pi-runtime"), { recursive: true });
  const source = join(repo, "harness/pi-runtime/source.mjs");
  await writeFile(source, "old");
  const initial = await sourceFingerprint(repo);
  await mkdir(join(repo, "harness/pi-runtime/node_modules"));
  await writeFile(join(repo, "harness/pi-runtime/node_modules/dependency"), "ignored");
  assert.equal(await sourceFingerprint(repo), initial);
  await writeFile(source, "new");
  assert.notEqual(await sourceFingerprint(repo), initial);
  await rm(source);
  assert.notEqual(await sourceFingerprint(repo), initial);
});

test("default build updates selected stock output and check detects old source", async (t) => {
  const home = await scratch(t);
  const repo = join(home, "repo"); await mkdir(repo);
  const env = { HOME: home };
  const installed = await installStockEngine({ home, env, install: fakeInstall });
  let updates = 0;
  const opts = { env, repoRoot: repo, legacy: () => { throw new Error("must not build legacy output"); }, update: async () => { updates++; } };
  assert.equal(await buildActiveEngine({ ...opts, args: ["--check"] }), 10);
  await buildActiveEngine({ ...opts, args: ["--force"] });
  assert.equal(updates, 1);
  const receipt = { ...installed.receipt, sourceSha256: await sourceFingerprint(repo) };
  await writeFile(join(installed.root, "rubato-install.json"), JSON.stringify(receipt));
  assert.equal(await buildActiveEngine({ ...opts, args: ["--check"] }), 0);
  await buildActiveEngine(opts); assert.equal(updates, 1);
  await writeFile(join(repo, "package.json"), "{}");
  assert.equal(await buildActiveEngine({ ...opts, args: ["--check"] }), 10);
  await buildActiveEngine(opts); assert.equal(updates, 2);
});
