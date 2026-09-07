import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRubatoComponents, rubatoComponentsFeature } from "../build-rubato.mjs";
import { loadPiFeatures } from "../feature-catalog.mjs";
import { stagePiRuntime } from "../stage-runtime.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

test("current Rubato builds without Senpi and binds actual task/memory/MCP components in stock Pi", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-component-integration-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const build = await buildRubatoComponents({ outputRoot: join(scratch, "build") });
  assert.equal(build.receipt.bundles.length, 7);
  assert.ok(build.receipt.sources.length > 100);
  assert.deepEqual(build.receipt.externalImports, ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);
  assert.equal(build.receipt.fullRubatoParity, false);
  await assert.rejects(buildRubatoComponents({ outputRoot: build.root }), /EEXIST/);
  const features = await loadPiFeatures(["reload", "tool-execution", "input-lifecycle", "abort-provenance", "request-run",
    "extension-rpc", "service-tier", "tool-search", "mcp", "mcp-producers", "codemode", "child-runtime", "terminal", "providers"]);
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, "engine"), features: [...features, build.feature] });
  const buildReceiptPath = join(build.root, "rubato-build.json");
  const receiptText = await readFile(buildReceiptPath, "utf8");
  for (const change of [
    (receipt) => { receipt.version = 999; },
    (receipt) => { receipt.lockSha256 = "0".repeat(64); },
    (receipt) => { receipt.assets = receipt.assets.filter(({ path }) => path !== "bootstrap.mjs"); },
    (receipt) => { receipt.assets = receipt.assets.filter(({ path }) => path !== "runtime/lsp-daemon/dist/package.json"); },
  ]) {
    const changed = JSON.parse(receiptText);
    change(changed);
    await writeFile(buildReceiptPath, JSON.stringify(changed));
    await assert.rejects(rubatoComponentsFeature(build.root), /receipt|manifest/);
  }
  await writeFile(buildReceiptPath, receiptText);
  for (const exposure of ["direct", "search"]) {
    const cwd = join(scratch, `project-${exposure}`), home = join(scratch, `home-${exposure}`), agentDir = join(home, "agent");
    await Promise.all([mkdir(join(cwd, ".rubato"), { recursive: true }), mkdir(agentDir, { recursive: true })]);
    await writeFile(join(cwd, ".rubato/rubato.jsonc"), JSON.stringify({ memory: {
      agent: "stock-integration", tool_exposure: exposure, reflection: { enabled: false }, facts: { enabled: false }, dream: { enabled: false, shutdown_launch: false }, sync: { enabled: false },
    } }));
    const env = { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1", NO_COLOR: "1", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"), GIT_AUTHOR_NAME: "Rubato test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Rubato test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const result = await run(process.execPath, [join(sourceRoot, "test/fixtures/rubato-components-session.mjs"), staged.root, exposure], { cwd, env, timeout: 18000, maxBuffer: 1024 * 1024 });
    const receiptLine = result.stdout.split("\n").find((line) => line.startsWith("RUBATO_COMPONENT_RESULT "));
    assert.ok(receiptLine, result.stderr || result.stdout);
    const receipt = JSON.parse(receiptLine.slice("RUBATO_COMPONENT_RESULT ".length));
    assert.equal(receipt.requestTimeline, true);
    assert.ok(receipt.tools >= 10);
    assert.equal(receipt.exposure, exposure);
  }
  const metadata = join(staged.root, "rubato-features/rubato-components/runtime/lsp-daemon/dist/package.json");
  await writeFile(metadata, '{"broken":true}');
  const validator = `import {validateRubatoBundleAssets} from ${JSON.stringify(join(staged.root, "rubato-features/rubato-components/bootstrap.mjs"))}; await validateRubatoBundleAssets();`;
  await assert.rejects(run(process.execPath, ["--input-type=module", "-e", validator], {
    env: { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "validator-agent"), PI_OFFLINE: "1" }, timeout: 10000,
  }), (error) => /hash mismatch/.test(error.stderr));
  const target = join(build.root, "extensions/rubato.js");
  await writeFile(target, `${await readFile(target, "utf8")}\n// modified\n`);
  await assert.rejects(rubatoComponentsFeature(build.root), /payload changed/);
});
