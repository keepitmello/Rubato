import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const STOCK_PI_VERSION = "0.85.1";

export const STOCK_PI_PACKAGES = Object.freeze([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "@earendil-works/chord",
  "@earendil-works/pi-telemetry",
]);

const CODING_AGENT = STOCK_PI_PACKAGES[0];

const DEPENDENCY_EDGES = Object.freeze([
  [CODING_AGENT, "@earendil-works/pi-agent-core"],
  [CODING_AGENT, "@earendil-works/pi-ai"],
  [CODING_AGENT, "@earendil-works/pi-tui"],
  [CODING_AGENT, "@earendil-works/chord"],
  ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"],
  ["@earendil-works/pi-agent-core", "@earendil-works/chord"],
  ["@earendil-works/pi-agent-core", "@earendil-works/pi-telemetry"],
  ["@earendil-works/pi-ai", "@earendil-works/pi-telemetry"],
]);

export class PiRuntimeResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PiRuntimeResolutionError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PiRuntimeResolutionError(code, message, details);
}

function isInside(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function readManifest(packageJsonPath, packageName) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    fail("PI_RUNTIME_MANIFEST_INVALID", `Cannot read ${packageName} manifest`, {
      packageName,
      packageJsonPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return manifest;
}

function resolvePackage(packageName, basePath, modulesBoundary, fromPackage = "<root>") {
  let discoveredPath;
  try {
    discoveredPath = findPackageJSON(packageName, pathToFileURL(basePath));
  } catch (error) {
    fail("PI_RUNTIME_PACKAGE_MISSING", `Cannot resolve ${packageName} from ${fromPackage}`, {
      packageName,
      fromPackage,
      basePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!discoveredPath) {
    fail("PI_RUNTIME_PACKAGE_MISSING", `Cannot resolve ${packageName} from ${fromPackage}`, {
      packageName,
      fromPackage,
      basePath,
    });
  }

  let packageJsonPath;
  try {
    packageJsonPath = realpathSync(discoveredPath);
  } catch (error) {
    fail("PI_RUNTIME_MANIFEST_INVALID", `Cannot resolve the real path for ${packageName}`, {
      packageName,
      discoveredPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isInside(modulesBoundary, packageJsonPath)) {
    fail("PI_RUNTIME_PACKAGE_OUTSIDE_ROOT", `${packageName} resolved outside the standalone runtime`, {
      packageName,
      fromPackage,
      packageJsonPath,
      modulesBoundary,
    });
  }

  const manifest = readManifest(packageJsonPath, packageName);
  if (manifest.name !== packageName) {
    fail("PI_RUNTIME_PACKAGE_IDENTITY_MISMATCH", `${packageName} resolved to ${String(manifest.name)}`, {
      packageName,
      actualName: manifest.name,
      packageJsonPath,
      fromPackage,
    });
  }
  if (manifest.version !== STOCK_PI_VERSION) {
    fail("PI_RUNTIME_VERSION_MISMATCH", `${packageName} must be ${STOCK_PI_VERSION}, found ${String(manifest.version)}`, {
      packageName,
      expectedVersion: STOCK_PI_VERSION,
      actualVersion: manifest.version,
      packageJsonPath,
      fromPackage,
    });
  }

  return {
    name: manifest.name,
    version: manifest.version,
    dir: dirname(packageJsonPath),
    packageJsonPath,
    manifest,
  };
}

function manifestPath(manifest, keys) {
  let current = manifest;
  for (const key of keys) current = current?.[key];
  return typeof current === "string" ? current : undefined;
}

function resolveEntry(pkg, label, expectedRelativePath, declaredRelativePath) {
  if (typeof declaredRelativePath !== "string" || declaredRelativePath === "") {
    fail("PI_RUNTIME_EXPORT_MISMATCH", `${pkg.name} has no ${label}`, {
      packageName: pkg.name,
      label,
      expectedPath: expectedRelativePath,
      actualPath: declaredRelativePath,
      packageJsonPath: pkg.packageJsonPath,
    });
  }
  if (declaredRelativePath !== expectedRelativePath) {
    fail("PI_RUNTIME_EXPORT_MISMATCH", `${pkg.name} ${label} must be ${expectedRelativePath}`, {
      packageName: pkg.name,
      label,
      expectedPath: expectedRelativePath,
      actualPath: declaredRelativePath,
      packageJsonPath: pkg.packageJsonPath,
    });
  }

  const unresolvedPath = resolve(pkg.dir, declaredRelativePath);
  if (!existsSync(unresolvedPath)) {
    fail("PI_RUNTIME_ENTRY_MISSING", `${pkg.name} ${label} does not exist`, {
      packageName: pkg.name,
      label,
      entryPath: unresolvedPath,
    });
  }

  const entryPath = realpathSync(unresolvedPath);
  if (!isInside(pkg.dir, entryPath)) {
    fail("PI_RUNTIME_ENTRY_OUTSIDE_PACKAGE", `${pkg.name} ${label} escapes its package`, {
      packageName: pkg.name,
      label,
      entryPath,
      packageDir: pkg.dir,
    });
  }
  if (!statSync(entryPath).isFile()) {
    fail("PI_RUNTIME_ENTRY_INVALID", `${pkg.name} ${label} is not a regular file`, {
      packageName: pkg.name,
      label,
      entryPath,
    });
  }
  return entryPath;
}

/**
 * Resolve one self-contained stock Pi 0.85.1 installation.
 *
 * Resolution starts inside `root`, follows the package graph used by Node, and
 * rejects aliases, mixed copies, and any fallback outside `root/node_modules`.
 */
export function resolvePiRuntime({ root } = {}) {
  if (typeof root !== "string" || root.trim() === "") {
    fail("PI_RUNTIME_ROOT_INVALID", "resolvePiRuntime requires a non-empty root path", { root });
  }

  const unresolvedRoot = resolve(root);
  if (!existsSync(unresolvedRoot) || !statSync(unresolvedRoot).isDirectory()) {
    fail("PI_RUNTIME_ROOT_MISSING", `Pi runtime root does not exist: ${unresolvedRoot}`, {
      root: unresolvedRoot,
    });
  }

  const runtimeRoot = realpathSync(unresolvedRoot);
  const unresolvedModulesBoundary = join(runtimeRoot, "node_modules");
  if (!existsSync(unresolvedModulesBoundary) || !statSync(unresolvedModulesBoundary).isDirectory()) {
    fail("PI_RUNTIME_NODE_MODULES_MISSING", `Pi runtime has no node_modules directory: ${runtimeRoot}`, {
      root: runtimeRoot,
    });
  }
  const modulesBoundary = realpathSync(unresolvedModulesBoundary);
  if (!isInside(runtimeRoot, modulesBoundary)) {
    fail("PI_RUNTIME_NODE_MODULES_OUTSIDE_ROOT", "Pi runtime node_modules escapes its root", {
      root: runtimeRoot,
      modulesBoundary,
    });
  }

  const rootAnchor = join(runtimeRoot, "__rubato_pi_runtime_resolver__.mjs");
  const codingAgent = resolvePackage(CODING_AGENT, rootAnchor, modulesBoundary);
  const resolvedPackages = new Map([[CODING_AGENT, codingAgent]]);

  for (const [fromName, packageName] of DEPENDENCY_EDGES) {
    const fromPackage = resolvedPackages.get(fromName);
    if (!fromPackage) {
      fail("PI_RUNTIME_GRAPH_INVALID", `Resolver graph has no parent package ${fromName}`, {
        fromPackage: fromName,
        packageName,
      });
    }

    const candidate = resolvePackage(packageName, fromPackage.packageJsonPath, modulesBoundary, fromName);
    const selected = resolvedPackages.get(packageName);
    if (selected && selected.packageJsonPath !== candidate.packageJsonPath) {
      fail("PI_RUNTIME_DEPENDENCY_DIVERGENCE", `${packageName} resolves to different package copies`, {
        packageName,
        fromPackage: fromName,
        selectedPath: selected.packageJsonPath,
        resolvedPath: candidate.packageJsonPath,
      });
    }
    resolvedPackages.set(packageName, candidate);
  }

  for (const packageName of STOCK_PI_PACKAGES) {
    if (!resolvedPackages.has(packageName)) {
      fail("PI_RUNTIME_GRAPH_INVALID", `Resolver did not select ${packageName}`, { packageName });
    }
  }

  const sdkEntry = resolveEntry(
    codingAgent,
    "SDK export",
    "./dist/index.js",
    manifestPath(codingAgent.manifest, ["exports", ".", "import"]),
  );
  const cliEntry = resolveEntry(
    codingAgent,
    "CLI bin",
    "dist/bundle/cli.js",
    manifestPath(codingAgent.manifest, ["bin", "pi"]),
  );
  const rpcEntry = resolveEntry(
    codingAgent,
    "RPC export",
    "./dist/bundle/rpc-entry.js",
    manifestPath(codingAgent.manifest, ["exports", "./rpc-entry", "import"]),
  );
  const patchableCliEntry = resolveEntry(
    codingAgent,
    "unbundled CLI entry",
    "dist/cli.js",
    "dist/cli.js",
  );
  const patchableRpcEntry = resolveEntry(
    codingAgent,
    "unbundled RPC entry",
    "dist/rpc-entry.js",
    "dist/rpc-entry.js",
  );

  const packages = Object.fromEntries(
    STOCK_PI_PACKAGES.map((packageName) => {
      const { manifest: _manifest, ...identity } = resolvedPackages.get(packageName);
      const declaredEntry = manifestPath(_manifest, ["exports", ".", "import"]) ?? _manifest.main;
      return [
        packageName,
        {
          ...identity,
          entry: resolveEntry(identity, "module entry", declaredEntry, declaredEntry),
        },
      ];
    }),
  );

  return {
    root: runtimeRoot,
    version: STOCK_PI_VERSION,
    codingAgentDir: codingAgent.dir,
    sdkEntry,
    cliEntry,
    rpcEntry,
    patchableCliEntry,
    patchableRpcEntry,
    packages,
  };
}
