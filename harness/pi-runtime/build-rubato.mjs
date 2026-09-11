import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiRuntime } from "./resolve-runtime.mjs";
import { validatePiInstall } from "./validate-install.mjs";
import { BUILD_RECEIPT_VERSION, BUNDLE_ENTRIES as entries, SOURCE_ASSETS, validateBuildReceipt } from "./features/rubato-components/payload-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function within(parent, path) {
  const rel = relative(parent, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

async function workspacePackages(repoRoot) {
  const packages = {};
  for (const dir of await readdir(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const root = join(repoRoot, "packages", dir.name);
    const text = await readFile(join(root, "package.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!text) continue;
    const manifest = JSON.parse(text);
    if (typeof manifest.name === "string") packages[manifest.name] = { root, exports: manifest.exports };
  }
  return packages;
}

function runBuilder(config, bunExecutable) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_COMPILE_CACHE;
    const child = spawn(bunExecutable, [join(here, "scripts/build-rubato-worker.mjs")], {
      cwd: config.repoRoot, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`Rubato stock build failed (${code}): ${stderr || stdout}`));
      else {
        try { resolvePromise(JSON.parse(stdout)); } catch (cause) { reject(new Error("Invalid Rubato builder receipt", { cause })); }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(config));
  });
}

/** Build current workspace sources against only the selected stock dependency tree.
 * Output is a feature payload, not a default-engine installation or a parity claim.
 */
export async function buildRubatoComponents({ repoRoot = resolve(here, "../.."), sourceRoot = here, outputRoot,
  bunExecutable = process.platform === "win32" ? "bun.exe" : "bun", fixtureEntries = {} } = {}) {
  const runtime = resolvePiRuntime({ root: sourceRoot });
  const install = await validatePiInstall(runtime);
  const repo = await realpath(repoRoot);
  if (typeof outputRoot !== "string" || !outputRoot.trim()) throw new Error("Rubato build requires a new outputRoot");
  const output = resolve(await realpath(dirname(resolve(outputRoot))), resolve(outputRoot).split(/[\\/]/).at(-1));
  if (output === runtime.root || within(runtime.root, output) || within(output, runtime.root) || output === repo) {
    throw new Error("Rubato build output must be separate from its dependency installation and repository root");
  }
  const workspace = await workspacePackages(repo);
  for (const [path, entry] of Object.entries(fixtureEntries)) {
    if (!/^fixtures\/[a-z0-9-]+\.mjs$/.test(path) || typeof entry !== "string" ||
        !within(repo, await realpath(resolve(repo, entry)))) throw new Error(`Invalid Rubato verification fixture: ${path}`);
  }
  await mkdir(output); // Exclusive claim: never overwrite user or previous build artifacts.
  const receipt = { version: BUILD_RECEIPT_VERSION, state: "building", stockVersion: runtime.version, fullRubatoParity: false,
    lockSha256: sha256(install.lock), bundles: [], assets: [], sources: [] };
  const saveReceipt = () => writeFile(join(output, "rubato-build.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await saveReceipt();
  try {
    const result = await runBuilder({ repoRoot: repo, sourceRoot: runtime.root, outputRoot: output, workspace,
      stockPackages: runtime.packages, entries: { ...entries, ...fixtureEntries } }, bunExecutable);
    receipt.bundles = result.bundles;
    receipt.sources = result.sources;
    receipt.externalImports = result.externalImports;
    receipt.bunVersion = result.bunVersion;
    for (const [path, source] of Object.entries(SOURCE_ASSETS)) {
      const bytes = await readFile(join(repo, source));
      await mkdir(dirname(join(output, path)), { recursive: true });
      await writeFile(join(output, path), bytes, { flag: "wx" });
      receipt.assets.push({ path, source, sha256: sha256(bytes) });
    }
    const daemon = JSON.parse(await readFile(join(repo, "packages/lsp-daemon/package.json"), "utf8"));
    const daemonManifest = `${JSON.stringify({ name: daemon.name, version: daemon.version, type: "module", private: true }, null, 2)}\n`;
    await writeFile(join(output, "runtime/lsp-daemon/dist/package.json"), daemonManifest, { flag: "wx" });
    receipt.assets.push({ path: "runtime/lsp-daemon/dist/package.json", source: "packages/lsp-daemon/package.json", sha256: sha256(daemonManifest) });
    const manifest = { name: "rubato-stock-components", private: true, type: "module",
      imports: { "#rubato-task-runtime": "./extensions/rubato-task.js" },
      pi: { extensions: ["./extensions/rubato.js"] } };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(output, "package.json"), manifestText, { flag: "wx" });
    receipt.assets.push({ path: "package.json", source: "generated:stock-component-manifest", sha256: sha256(manifestText) });
    for (const bundle of receipt.bundles) {
      if (!(await stat(join(output, bundle.path))).isFile() || sha256(await readFile(join(output, bundle.path))) !== bundle.sha256) {
        throw new Error(`Rubato build output changed: ${bundle.path}`);
      }
    }
    receipt.state = "ready";
    await saveReceipt();
    return { root: output, receipt, feature: await rubatoComponentsFeature(output, { sourceRoot: runtime.root }) };
  } catch (error) {
    receipt.state = "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    await saveReceipt().catch(() => {});
    throw error;
  }
}

export async function rubatoComponentsFeature(buildRoot, { sourceRoot = here } = {}) {
  const root = await realpath(buildRoot);
  const runtime = resolvePiRuntime({ root: sourceRoot });
  const install = await validatePiInstall(runtime);
  const receipt = JSON.parse(await readFile(join(root, "rubato-build.json"), "utf8"));
  const paths = validateBuildReceipt(receipt, { stockVersion: runtime.version, lockSha256: sha256(install.lock) });
  for (const item of paths) {
    const path = resolve(root, item.path);
    if (!within(root, path) || !within(root, await realpath(path)) || sha256(await readFile(path)) !== item.sha256) {
      throw new Error(`Rubato feature payload changed: ${item.path}`);
    }
  }
  return { id: "rubato-components", patches: [], files: [...paths.map(({ path }) => path), "rubato-build.json"].map((path) => ({
    target: "runtime", version: "0.85.1", path: `rubato-features/rubato-components/${path}`, sourcePath: join(root, path),
  })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = process.argv[2];
  buildRubatoComponents({ outputRoot }).then(({ root, receipt }) => console.log(JSON.stringify({ root, state: receipt.state,
    stockVersion: receipt.stockVersion, bundles: receipt.bundles.length, sources: receipt.sources.length,
    fullRubatoParity: receipt.fullRubatoParity, receipt: join(root, "rubato-build.json") }, null, 2)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
