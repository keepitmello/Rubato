import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const CANDIDATE = process.env.RUBATO_PI_SDK?.trim() || "/tmp/rubato-pi-candidate-3bd2ec525";
const PI_SDK = join(repoRoot, "packages", "senpi-task", "src", "pi-sdk", "index.ts");
const SPAWN = join(repoRoot, "packages", "senpi-task", "src", "runners", "rpc", "spawn.ts");
const PAYLOAD = join(repoRoot, "packages", "rubato-runtime", "src", "components", "memory", "worker", "spawn-payload.ts");

function candidateProblem() {
  if (!existsSync(join(CANDIDATE, "package.json"))) return `stock candidate missing: ${CANDIDATE}`;
  const pkg = JSON.parse(readFileSync(join(CANDIDATE, "package.json"), "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== "0.84.2") {
    return `candidate is ${pkg.name}@${pkg.version}`;
  }
  return null;
}

const SKIP = candidateProblem();

function isolatedEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    RUBATO_PI_SDK: CANDIDATE,
    NO_PROXY: "*",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}

test("memory launch glue uses stock CLI and pipe-bash compat", () => {
  const payload = readFileSync(PAYLOAD, "utf8");
  assert.match(payload, /applyNonInteractiveBashCompat/);
  assert.doesNotMatch(payload, /pi-pty/);
  const spawnSrc = readFileSync(SPAWN, "utf8");
  assert.match(spawnSrc, /stockRpcEntry/);
});

test("stock bash tool executes locally without pi-pty or model calls", {
  skip: SKIP ?? undefined,
  timeout: 30_000,
}, () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tool-exec-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-tool-exec-cwd-"));
  const script = `
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    import { loadStockSdk, applyNonInteractiveBashCompat, stockRpcEntry, stockCliEntry } from ${JSON.stringify(pathToFileURL(PI_SDK).href)};
    const sdk = await loadStockSdk({ RUBATO_PI_SDK: ${JSON.stringify(CANDIDATE)} });
    if (sdk.VERSION !== "0.84.2") process.exit(2);
    const toolsHref = pathToFileURL(join(${JSON.stringify(CANDIDATE)}, "dist/core/tools/index.js")).href;
    const tools = await import(toolsHref);
    const bash = tools.createBashToolDefinition(${JSON.stringify(cwd)});
    const ac = new AbortController();
    const result = await bash.execute("t1", { command: "printf ok-stock-bash" }, ac.signal);
    const text = (result.content ?? []).map((part) => part.text ?? "").join("");
    if (!text.includes("ok-stock-bash")) {
      process.stderr.write(JSON.stringify(result) + "\\n");
      process.exit(3);
    }
    const env = applyNonInteractiveBashCompat({ HOME: ${JSON.stringify(home)} });
    process.stdout.write(JSON.stringify({
      version: sdk.VERSION,
      rpc: stockRpcEntry(),
      cli: stockCliEntry(),
      pipe: env.PI_PTY_FORCE_PIPE,
      senpiPipe: env.SENPI_PTY_FORCE_PIPE,
    }) + "\\n");
  `;
  const result = spawnSync("bun", ["--eval", script], {
    env: isolatedEnv(home),
    encoding: "utf8",
    timeout: 20000,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, "0.84.2");
  assert.equal(report.pipe, "1");
  assert.equal(report.senpiPipe, "1");
  assert.match(report.cli, /dist\/cli\.js/);
  assert.doesNotMatch(report.cli, /@code-yeongyu/);
  assert.doesNotMatch(report.cli, /\/senpi\//);
});

test("RPC factory default entry is stock rpc-entry", {
  skip: SKIP ?? undefined,
}, () => {
  const script = `
    import { buildRpcSpawn } from ${JSON.stringify(pathToFileURL(SPAWN).href)};
    const descriptor = buildRpcSpawn({
      task_id: "st_adapter",
      cwd: "/tmp/project",
      state_dir: "/tmp/project/.rubato/senpi-task",
      prompt: "do the work",
    }, {
      isBunBinary: false,
      execPath: ${JSON.stringify(process.execPath)},
      platform: "linux",
      parentEnv: { RUBATO_PI_SDK: ${JSON.stringify(CANDIDATE)} },
      resolveSenpiExecutable: () => null,
    });
    if (descriptor.args[0].includes("@code-yeongyu")) process.exit(2);
    if (!descriptor.args[0].endsWith("/dist/rpc-entry.js")) process.exit(3);
    process.stdout.write(descriptor.args[0] + "\\n");
  `;
  const result = spawnSync("bun", ["--eval", script], {
    env: isolatedEnv(mkdtempSync(join(tmpdir(), "pi-rpc-home-"))),
    encoding: "utf8",
    timeout: 20000,
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /rpc-entry\.js/);
  assert.doesNotMatch(result.stdout, /@code-yeongyu/);
});
