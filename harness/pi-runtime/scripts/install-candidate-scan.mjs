import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATE_FEATURE_NAMES } from "../features/rubato-components/candidate-main.mjs";
import { DECLARED_PTY_PACKAGE, SENPI_APP_PACKAGES } from "../validate-install.mjs";

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts"]);
const SKIP_DIR = new Set([".git", "node_modules"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function walkFiles(root, { skipNodeModules = true } = {}) {
  const out = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipNodeModules && SKIP_DIR.has(entry.name)) continue;
        await visit(path);
      } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name))) {
        out.push(path);
      }
    }
  }
  await visit(root);
  return out;
}

function classifyUrl(url, { installRoot, nodePrefix, extraAllowed = [] }) {
  if (url.startsWith("node:") || url.startsWith("data:") || url.startsWith("http:") || url.startsWith("https:")) {
    return { kind: "node-core", url };
  }
  let path;
  try {
    path = url.startsWith("file:") ? fileURLToPath(url) : url;
  } catch {
    return { kind: "other", url };
  }
  if (inside(installRoot, path) || path === installRoot) return { kind: "install", url, path };
  if (nodePrefix && (inside(nodePrefix, path) || path === nodePrefix)) return { kind: "node-core", url, path };
  for (const allowed of extraAllowed) {
    if (allowed && (inside(allowed, path) || path === allowed)) return { kind: "allowed-scratch", url, path };
  }
  return { kind: "outside", url, path };
}

function senpiAppHit(text) {
  return SENPI_APP_PACKAGES.filter((name) => new RegExp(String.raw`(?:from|import|require)\s*(?:\(|\s)['"]${name}(?:/[^'"]*)?['"]`).test(text));
}

function pathHasPackage(path, name) {
  const idx = path.indexOf(name);
  if (idx === -1) return false;
  const after = path[idx + name.length];
  return after === undefined || after === "/" || after === "\\";
}

const PTY_USAGE_SITES = Object.freeze([
  {
    path: "features/terminal/src/manager.ts",
    symbols: ["SessionRegistry", "SessionRegistryCapacityError", "TerminalSession"],
    role: "runtime",
    note: "Owns live terminal sessions; native PTY registry, capacity, teardown.",
  },
  {
    path: "features/terminal/src/runtime-session.ts",
    symbols: ["TerminalScreen", "TerminalSession"],
    role: "runtime",
    note: "Wraps a live TerminalSession with screen model and output buffer.",
  },
  {
    path: "features/terminal/terminal-native.test.mjs",
    symbols: ["loadPtyNative"],
    role: "test",
    note: "Darwin arm64 ABI smoke: native.__senpiPtyAbi1().",
  },
  {
    path: "features/terminal/terminal.test.mjs",
    symbols: ["findPackageJSON(@code-yeongyu/senpi-pty)"],
    role: "test",
    note: "Asserts staged install still resolves the declared PTY package inside the runtime.",
  },
  {
    path: "features/session-picker/session-picker.test.mjs",
    symbols: ["createTerminalSession"],
    role: "test",
    note: "pseudo-TTY /resume path; native backend instead of script(1) sockets. Not a runtime import of session-picker itself.",
  },
]);

const PTY_REPLACEMENT = Object.freeze([
  "A drop-in SessionRegistry + TerminalSession + TerminalScreen API (create, write, resize, kill, waitExit, onData, scrollback).",
  "Native PTY backend with Darwin arm64 (currently qualified), plus Windows/Linux if those hosts must keep six-tool terminal.",
  "Capacity / LRU-exited pruning / tree-kill of descendant processes — today delegated to senpi-pty.",
  "xterm-headless screen snapshots used by bash_output / resize / monitor.",
  "ABI equivalent of loadPtyNative() used by terminal-native.test.mjs.",
  "session-picker tests would need another PTY (node-pty, bun terminal, or a stdio mock) for /resume ioctl coverage.",
  "Do not replace while the user decision is deferred; keep the declared npm pin.",
]);

export async function scanInstalledCandidate({
  installRoot,
  loadReportPath,
  childReceipt,
  extraAllowed = [],
  previousRoot,
  featureRoot,
  notes = [],
} = {}) {
  const root = installRoot ? await realpath(installRoot) : await realpath(featureRoot);
  const nodePrefix = dirname(dirname(await realpath(process.execPath)));
  const loadLines = loadReportPath ? (await readFile(loadReportPath, "utf8")).split(/\r?\n/).filter(Boolean) : [];
  const classified = loadLines.map((url) => classifyUrl(url, { installRoot: root, nodePrefix, extraAllowed }));
  const outside = classified.filter((entry) => entry.kind === "outside");
  const senpiLoads = classified.filter((entry) => SENPI_APP_PACKAGES.some((name) => pathHasPackage(entry.path ?? entry.url, name)));

  const scanRoot = featureRoot ? await realpath(featureRoot) : join(root, "rubato-features");
  const featureFiles = await walkFiles(scanRoot);
  const dynamicImports = [];
  const relativeAssets = [];
  const spawnSites = [];
  const envKeys = new Set();
  const fallbackDeps = [];
  for (const file of featureFiles) {
    const text = await readFile(file, "utf8");
    const rel = relative(featureRoot ? scanRoot : root, file).split(sep).join("/");
    const apps = senpiAppHit(text);
    if (apps.length > 0) fallbackDeps.push({ path: rel, packages: apps, kind: "source-string" });
    for (const match of text.matchAll(/import\(\s*([^`)]+)\s*\)/g)) {
      dynamicImports.push({ path: rel, specifier: match[1].slice(0, 200) });
    }
    for (const match of text.matchAll(/(?:readFile(?:Sync)?|new URL)\(([^)]+)\)/g)) {
      if (/['"]\.\.?\//.test(match[1]) || /import\.meta\.url/.test(match[1])) {
        relativeAssets.push({ path: rel, expr: match[1].slice(0, 200) });
      }
    }
    if (/\b(?:spawn|execFile|execFileSync|spawnSync)\b/.test(text)) spawnSites.push(rel);
    for (const match of text.matchAll(/\b(SENPI_[A-Z0-9_]+|RUBATO_PI_[A-Z0-9_]+)\b/g)) envKeys.add(match[1]);
  }

  let recreatedAfterUpdate = [];
  if (previousRoot) {
    const prevLockPath = join(previousRoot, "package-lock.json");
    const nextLockPath = join(root, "package-lock.json");
    const prevLock = await readFile(prevLockPath).then(sha256, () => null);
    const nextLock = await readFile(nextLockPath).then(sha256, () => null);
    recreatedAfterUpdate = [{
      name: "package-lock.json",
      sameHash: Boolean(prevLock && nextLock && prevLock === nextLock),
      previousSha256: prevLock,
      currentSha256: nextLock,
    }, {
      name: "node_modules",
      note: "update re-runs npm ci into a fresh tree then stages; node_modules is replaced, not mutated in place",
    }];
  }

  return {
    generatedAt: new Date().toISOString(),
    stockVersion: "0.85.1",
    node: process.version,
    installRoot: root,
    features: [...CANDIDATE_FEATURE_NAMES],
    senpiPty: {
      package: `${DECLARED_PTY_PACKAGE}@2026.9.4-3`,
      decision: "deferred-by-user",
      nativeDarwinArm64Sha256: "20f9f1644966694779ee78b76cf60e9f2de2ae0b373a1eb0cf5944afdda0c4da",
      usageSites: PTY_USAGE_SITES,
      replacementWouldRequire: PTY_REPLACEMENT,
    },
    resolvedModulePaths: {
      total: classified.length,
      insideInstall: classified.filter((entry) => entry.kind === "install").length,
      nodeCore: classified.filter((entry) => entry.kind === "node-core").length,
      allowedScratch: classified.filter((entry) => entry.kind === "allowed-scratch").length,
      outside: outside.map((entry) => entry.path ?? entry.url),
      senpiAppLoads: senpiLoads.map((entry) => entry.path ?? entry.url),
    },
    fallbackDeps,
    childExecutables: childReceipt ? [
      { seam: "rpc", execPath: childReceipt.rpc?.execPath, entry: childReceipt.rpc?.rpcEntry },
      { seam: "in-process", note: "same process.execPath; no SENPI_BIN", senpiExecutable: childReceipt.inProcess?.senpiExecutable ?? null },
    ] : [],
    childEnv: childReceipt?.rpc ? { sessionDirFromGetState: childReceipt.rpc.sessionFile } : {},
    dynamicImports: dynamicImports.slice(0, 200),
    spawnSites,
    relativeAssets: relativeAssets.slice(0, 200),
    envIdentifiers: [...envKeys].sort(),
    recreatedAfterUpdate,
    senpiAppPackagesMustNotResolve: [...SENPI_APP_PACKAGES],
    notes: [...notes],
  };
}

export function assertScanClean(scan, { requireLoadReport = true } = {}) {
  if (requireLoadReport && scan.resolvedModulePaths.total < 10) {
    throw new Error(`Load report is too small to prove isolation (${scan.resolvedModulePaths.total} urls)`);
  }
  if (requireLoadReport && scan.resolvedModulePaths.insideInstall < 1) {
    throw new Error("Load report did not include any module from the install directory");
  }
  if (scan.resolvedModulePaths.outside.length > 0) {
    throw new Error(`Resolved module paths escaped the install: ${scan.resolvedModulePaths.outside.slice(0, 8).join(", ")}`);
  }
  if (scan.resolvedModulePaths.senpiAppLoads.length > 0) {
    throw new Error(`Senpi app package loaded: ${scan.resolvedModulePaths.senpiAppLoads.join(", ")}`);
  }
  if (scan.fallbackDeps.length > 0) {
    throw new Error(`Staged features still name Senpi app packages: ${JSON.stringify(scan.fallbackDeps)}`);
  }
}

export { classifyUrl, PTY_USAGE_SITES, PTY_REPLACEMENT };
