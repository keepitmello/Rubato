import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { STOCK_PI_PACKAGES, STOCK_PI_VERSION } from "./resolve-runtime.mjs";

const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const entries = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));

function sameDeclarations(manifest, locked, label, isRoot = false) {
  for (const section of sections) {
    // Registry dependencies do not install their own development dependencies.
    if (section === "devDependencies" && !isRoot) continue;
    if (JSON.stringify(entries(manifest[section])) !== JSON.stringify(entries(locked[section]))) {
      throw new Error(`Pi install lock ${section} mismatch: ${label}`);
    }
  }
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
  const packages = [];
  for (const name of STOCK_PI_PACKAGES) {
    const selected = runtime.packages[name];
    const path = relative(runtime.root, selected.dir).split(sep).join("/");
    const entry = locked.packages[path];
    const expectedUrl = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${STOCK_PI_VERSION}.tgz`;
    if (!entry || entry.link || entry.version !== selected.version || entry.resolved !== expectedUrl) {
      throw new Error(`Pi install lock identity mismatch: ${name} at ${path}`);
    }
    if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) {
      throw new Error(`Pi install lock lacks pinned sha512 integrity: ${name}`);
    }
    const installed = JSON.parse(await readFile(selected.packageJsonPath, "utf8"));
    sameDeclarations(installed, entry, name);
    packages.push({ name, version: entry.version, path, resolved: entry.resolved, integrity: entry.integrity });
  }
  return { packageJson, lock, packages };
}
