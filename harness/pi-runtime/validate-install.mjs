import { readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { STOCK_PI_PACKAGES, STOCK_PI_VERSION } from "./resolve-runtime.mjs";

const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const entries = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));

/** Senpi *app* packages. Declared `@code-yeongyu/senpi-pty` is not in this list. */
export const SENPI_APP_PACKAGES = Object.freeze([
  "@code-yeongyu/senpi",
  "@code-yeongyu/senpi-ai",
  "@code-yeongyu/senpi-codemode",
  "@code-yeongyu/senpi-tui",
]);

export const DECLARED_PTY_PACKAGE = "@code-yeongyu/senpi-pty";

function tryFindPackage(name, anchor) {
  try {
    return findPackageJSON(name, anchor) ?? undefined;
  } catch {
    return undefined;
  }
}

function insideRuntime(runtimeRoot, filePath) {
  const location = relative(runtimeRoot, filePath);
  return Boolean(location) && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

function sameDeclarations(manifest, locked, label, isRoot = false) {
  for (const section of sections) {
    // Registry dependencies do not install their own development dependencies.
    if (section === "devDependencies" && !isRoot) continue;
    if (JSON.stringify(entries(manifest[section])) !== JSON.stringify(entries(locked[section]))) {
      throw new Error(`Pi install lock ${section} mismatch: ${label}`);
    }
  }
}

async function validatePackage(runtime, locked, name, version, packageJsonPath) {
  const path = relative(runtime.root, dirname(packageJsonPath)).split(sep).join("/");
  const entry = locked.packages[path];
  const expectedUrl = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
  const installed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (installed.name !== name || installed.version !== version ||
      !entry || entry.link || entry.version !== version || entry.resolved !== expectedUrl) {
    throw new Error(`Pi install lock identity mismatch: ${name} at ${path}`);
  }
  if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) {
    throw new Error(`Pi install lock lacks pinned sha512 integrity: ${name}`);
  }
  sameDeclarations(installed, entry, name);
  return { name, version, path, resolved: entry.resolved, integrity: entry.integrity };
}

/** Verify install metadata, not arbitrary file contents: npm ci verifies tarball SRI. */
export async function validatePiInstall(runtime) {
  const [packageJson, lock] = await Promise.all([
    readFile(join(runtime.root, "package.json")),
    readFile(join(runtime.root, "package-lock.json")),
  ]);
  const manifest = JSON.parse(packageJson);
  const locked = JSON.parse(lock);
  const root = locked.packages?.[""];
  if (locked.lockfileVersion !== 3 || !root || manifest.dependencies?.[STOCK_PI_PACKAGES[0]] !== STOCK_PI_VERSION) {
    throw new Error("Pi install requires an exact stock dependency and a v3 root lock entry");
  }
  sameDeclarations(manifest, root, "root", true);
  const directDependencies = [];
  for (const [name, version] of entries(manifest.dependencies)) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`Pi install direct dependency requires an exact version: ${name}`);
    }
    let packageJsonPath;
    try {
      packageJsonPath = await realpath(findPackageJSON(name, pathToFileURL(join(runtime.root, "package.json"))));
    } catch (cause) {
      throw new Error(`Pi install direct dependency is missing: ${name}`, { cause });
    }
    const location = relative(join(runtime.root, "node_modules"), packageJsonPath);
    if (!location || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      throw new Error(`Pi install direct dependency resolved outside its runtime: ${name}`);
    }
    directDependencies.push(await validatePackage(runtime, locked, name, version, packageJsonPath));
  }
  const packages = [];
  for (const name of STOCK_PI_PACKAGES) {
    const selected = runtime.packages[name];
    packages.push(await validatePackage(runtime, locked, name, selected.version, selected.packageJsonPath));
  }
  return { packageJson, lock, packages, directDependencies };
}

/** Senpi app packages must not resolve; declared senpi-pty must stay inside this runtime. */
export async function validateCandidateIsolation(runtime, { requiredFeatures } = {}) {
  const anchor = pathToFileURL(join(runtime.root, "package.json"));
  const root = await realpath(runtime.root);
  const leaked = [];
  for (const name of SENPI_APP_PACKAGES) {
    const found = tryFindPackage(name, anchor);
    if (found) leaked.push({ name, path: found });
  }
  if (leaked.length > 0) {
    throw new Error(`Senpi app package resolved from the candidate install: ${leaked.map((entry) => `${entry.name}=${entry.path}`).join(", ")}`);
  }
  const pty = tryFindPackage(DECLARED_PTY_PACKAGE, anchor);
  if (!pty) throw new Error("Declared @code-yeongyu/senpi-pty is missing from the candidate install");
  const ptyReal = await realpath(pty);
  if (!insideRuntime(root, ptyReal)) {
    throw new Error(`Declared senpi-pty resolved outside the candidate install: ${ptyReal}`);
  }
  const receipt = JSON.parse(await readFile(join(runtime.root, "rubato-pi-stage.json"), "utf8"));
  if (Array.isArray(requiredFeatures)) {
    const missing = requiredFeatures.filter((name) => !receipt.features?.includes(name));
    if (missing.length > 0) throw new Error(`Candidate stage is missing features: ${missing.join(", ")}`);
  }
  return { senpiPty: ptyReal, receipt };
}
