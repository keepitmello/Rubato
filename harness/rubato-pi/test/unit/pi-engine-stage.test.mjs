import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPiPatches, ApplyPiPatchesError } from "../../../scripts/apply-pi-patches.mjs";
import { stagePiEngine, StagePiEngineError } from "../../../scripts/stage-pi-engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const FIXTURE = "/tmp/pi-rg-fixture";
const CA_FIXTURE = join(FIXTURE, "node_modules/@earendil-works/pi-coding-agent");
const TUI_FIXTURE = join(CA_FIXTURE, "node_modules/@earendil-works/pi-tui");
const STAGE_SCRIPT = join(repoRoot, "harness", "scripts", "stage-pi-engine.mjs");
const BUILD_ENGINE = join(repoRoot, "harness", "scripts", "build-engine.mjs");
const MANIFEST = JSON.parse(readFileSync(join(repoRoot, "harness", "pi-patches", "manifest.json"), "utf8"));

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureProblem() {
  if (!existsSync(join(FIXTURE, "package.json"))) return `stock fixture missing: ${FIXTURE}`;
  if (!existsSync(join(CA_FIXTURE, "package.json"))) return `coding-agent fixture missing: ${CA_FIXTURE}`;
  if (!existsSync(join(TUI_FIXTURE, "package.json"))) return `tui fixture missing: ${TUI_FIXTURE}`;
  const ca = JSON.parse(readFileSync(join(CA_FIXTURE, "package.json"), "utf8"));
  const tui = JSON.parse(readFileSync(join(TUI_FIXTURE, "package.json"), "utf8"));
  if (ca.name !== "@earendil-works/pi-coding-agent" || ca.version !== "0.84.2") {
    return `coding-agent is ${ca.name}@${ca.version}`;
  }
  if (tui.name !== "@earendil-works/pi-tui" || tui.version !== "0.84.2") {
    return `tui is ${tui.name}@${tui.version}`;
  }
  return null;
}

const SKIP = fixtureProblem();

function snapshotFixture() {
  return [
    join(CA_FIXTURE, "package.json"),
    join(CA_FIXTURE, "dist/core/agent-session.js"),
    join(CA_FIXTURE, "dist/cli.js"),
    join(TUI_FIXTURE, "package.json"),
    join(TUI_FIXTURE, "dist/stdin-buffer.js"),
  ].map((path) => ({ path, sha: sha256File(path) }));
}

function assertFixtureUnchanged(before) {
  for (const entry of before) {
    assert.equal(sha256File(entry.path), entry.sha, `shared fixture mutated: ${entry.path}`);
  }
}

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), "pi-engine-stage-test-"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isolatedEnv(home) {
  const env = { ...process.env, HOME: home };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

test("build-engine --stage-pi is an isolated hook and default path still links Senpi", () => {
  const src = readFileSync(BUILD_ENGINE, "utf8");
  assert.match(src, /--stage-pi/);
  assert.match(src, /stage-pi-engine\.mjs/);
  assert.match(src, /ensureEngineNodeModules/);
  const missing = spawnSync(process.execPath, [BUILD_ENGINE, "--stage-pi"], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing --stock/);
  const bogusOut = join(scratchRoot(), "out");
  const bogus = spawnSync(process.execPath, [
    BUILD_ENGINE, "--stage-pi",
    "--stock", join(tmpdir(), "pi-stock-does-not-exist"),
    "--output", bogusOut,
  ], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /missing stock/);
  assert.equal(existsSync(bogusOut), false);
});

test("existing output is not overwritten", () => {
  const root = scratchRoot();
  const output = join(root, "out");
  mkdirSync(output);
  const sentinel = join(output, "user-state.txt");
  writeFileSync(sentinel, "keep");
  assert.throws(
    () => stagePiEngine({ stock: root, output, repoRoot }),
    (error) => {
      assert.ok(error instanceof StagePiEngineError);
      assert.match(error.message, /output already exists/);
      return true;
    },
  );
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("output overlapping stock is rejected", () => {
  const root = scratchRoot();
  writeJson(join(root, "package.json"), {
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
  });
  writeJson(join(root, "node_modules/@earendil-works/pi-tui/package.json"), {
    name: "@earendil-works/pi-tui",
    version: "0.84.2",
  });
  const nested = join(root, "published-here");
  assert.throws(
    () => stagePiEngine({ stock: root, output: nested, repoRoot }),
    /overlap|inside/,
  );
  assert.equal(existsSync(nested), false);
});

test("Senpi packages in the stock graph are rejected", () => {
  const root = scratchRoot();
  writeJson(join(root, "package.json"), {
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
  });
  writeJson(join(root, "node_modules/@earendil-works/pi-tui/package.json"), {
    name: "@earendil-works/pi-tui",
    version: "0.84.2",
  });
  writeJson(join(root, "node_modules/@code-yeongyu/senpi/package.json"), {
    name: "@code-yeongyu/senpi",
    version: "2026.9.4-3",
  });
  const output = join(scratchRoot(), "out");
  assert.throws(
    () => stagePiEngine({ stock: root, output, repoRoot }),
    (error) => {
      assert.ok(error instanceof StagePiEngineError);
      assert.match(error.message, /Senpi/);
      return true;
    },
  );
  assert.equal(existsSync(output), false);
});

test("absolute symlink backrefs are rejected", () => {
  const root = scratchRoot();
  writeJson(join(root, "package.json"), {
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
  });
  writeJson(join(root, "node_modules/@earendil-works/pi-tui/package.json"), {
    name: "@earendil-works/pi-tui",
    version: "0.84.2",
  });
  symlinkSync("/etc/passwd", join(root, "escape"));
  const output = join(scratchRoot(), "out");
  assert.throws(
    () => stagePiEngine({ stock: root, output, repoRoot }),
    /absolute symlink|escapes/,
  );
  assert.equal(existsSync(output), false);
});

test("CLI refuses an existing output without mutating it", () => {
  const root = scratchRoot();
  const output = join(root, "out");
  mkdirSync(output);
  writeFileSync(join(output, "keep.txt"), "keep");
  const result = spawnSync(process.execPath, [
    STAGE_SCRIPT,
    "--stock", FIXTURE,
    "--output", output,
  ], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /output already exists/);
  assert.equal(readFileSync(join(output, "keep.txt"), "utf8"), "keep");
});

test("stages complete stock tree with patches; SDK and CLI work after source copy is gone", {
  skip: SKIP ?? undefined,
  timeout: 180_000,
}, async () => {
  const before = snapshotFixture();
  const root = scratchRoot();
  try {
    const stockCopy = join(root, "stock");
    const output = join(root, "engine");
    cpSync(FIXTURE, stockCopy, { recursive: true, verbatimSymlinks: true });
    const spawned = spawnSync(process.execPath, [
      STAGE_SCRIPT,
      "--stock", stockCopy,
      "--output", output,
    ], {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(spawned.status, 0, spawned.stderr);
    const published = JSON.parse(spawned.stdout);
    assert.equal(published.codingAgent, output);
    rmSync(stockCopy, { recursive: true, force: true });
    assert.equal(existsSync(stockCopy), false);
    assertFixtureUnchanged(before);

    for (const spec of MANIFEST.packages) {
      const dest = spec.id === "pi-coding-agent"
        ? output
        : join(output, "node_modules/@earendil-works", spec.id);
      for (const file of spec.files) {
        const want = file.postimageSha256 ?? file.sha256;
        assert.equal(sha256File(join(dest, file.path)), want, `${spec.id}:${file.path}`);
      }
    }

    assert.equal(existsSync(join(output, "dist/cli.js")), true);
    assert.equal(existsSync(join(output, "dist/index.js")), true);
    assert.equal(existsSync(join(output, "npm-shrinkwrap.json")), true);
    assert.equal(existsSync(join(output, "node_modules/@earendil-works/pi-ai/package.json")), true);
    assert.equal(existsSync(join(output, "node_modules/@earendil-works/pi-agent-core/package.json")), true);
    assert.equal(existsSync(join(output, "node_modules/@earendil-works/pi-client/package.json")), true);
    assert.equal(existsSync(join(output, "node_modules/@earendil-works/pi-protocol/package.json")), true);
    assert.equal(existsSync(join(output, "node_modules/@earendil-works/pi-tui/dist/index.js")), true);
    const listedOnly = MANIFEST.packages[0].files.map((file) => file.path);
    assert.equal(listedOnly.includes("dist/cli.js"), false);

    const session = readFileSync(join(output, "dist/core/agent-session.js"), "utf8");
    const interactive = readFileSync(join(output, "dist/modes/interactive/interactive-mode.js"), "utf8");
    const stdin = readFileSync(join(output, "node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js"), "utf8");
    assert.match(session, /checkReloadVeto/);
    assert.match(interactive, /checkReloadVeto/);
    assert.match(interactive, /editorContainer\.addChild\(reloadBox\)/);
    assert.match(stdin, /StringDecoder/);

    const names = [];
    const stack = [join(output, "node_modules")];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "@code-yeongyu" || /senpi/i.test(entry.name)) names.push(abs);
          if (entry.name === "node_modules" || entry.name.startsWith("@")) stack.push(abs);
          else if (existsSync(join(abs, "package.json"))) {
            const pkg = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
            if (typeof pkg.name === "string" && /senpi/i.test(pkg.name)) names.push(pkg.name);
          }
        }
      }
    }
    assert.deepEqual(names, []);

    const home = join(root, "home");
    mkdirSync(home);
    const clean = isolatedEnv(home);
    const version = spawnSync(process.execPath, [join(output, "dist/cli.js"), "--version"], {
      env: clean,
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /0\.84\.2/);

    const sdkHref = pathToFileURL(join(output, "dist/index.js")).href;
    const sdk = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const mod = await import(${JSON.stringify(sdkHref)});
      if (typeof mod.AgentSession !== "function") process.exit(2);
      if (mod.VERSION !== "0.84.2") process.exit(3);
      process.stdout.write("sdk-ok\\n");
    `], {
      env: clean,
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(sdk.status, 0, sdk.stderr);
    assert.match(sdk.stdout, /sdk-ok/);

    const hookOut = join(root, "hook-engine");
    const hook = spawnSync(process.execPath, [
      BUILD_ENGINE, "--stage-pi",
      "--stock", FIXTURE,
      "--output", hookOut,
    ], {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(hook.status, 0, hook.stderr);
    const hookPublished = JSON.parse(hook.stdout);
    assert.equal(hookPublished.codingAgent, hookOut);
    assert.match(readFileSync(join(hookOut, "dist/core/agent-session.js"), "utf8"), /checkReloadVeto/);
    assert.equal(existsSync(join(hookOut, "dist/cli.js")), true);
    assertFixtureUnchanged(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyPiPatches remains the patch implementation", () => {
  const src = readFileSync(STAGE_SCRIPT, "utf8");
  assert.match(src, /applyPiPatches/);
  assert.equal(src.includes("spawnSync(\"patch\""), false);
  assert.equal(typeof applyPiPatches, "function");
  assert.equal(ApplyPiPatchesError.name, "ApplyPiPatchesError");
});
