import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const factoryHooks = ["dist/main.js", "dist/main.d.ts", "dist/core/agent-session-services.js", "dist/core/agent-session-services.d.ts"];
const codingPackage = "node_modules/@earendil-works/pi-coding-agent/";

/** Detect incomplete/stale selected payloads before importing stock main. This
 * validates the local build receipt, not an externally signed trust chain.
 */
export async function validateCandidateStage(root, receipt) {
  if (!Array.isArray(receipt.files) || !Array.isArray(receipt.addedFiles) || !Array.isArray(receipt.binShims)) {
    throw new Error("Candidate stage is missing its payload records");
  }
  for (const path of factoryHooks) {
    const record = receipt.files.find((entry) => entry.path === `${codingPackage}${path}`);
    if (!record?.patches?.includes(`runtime-factories/${path}`)) {
      throw new Error(`Candidate stage is missing required factory hook: ${path}`);
    }
  }
  const canonicalRoot = await realpath(root);
  const entries = [
    { path: "package.json", sha256: receipt.packageSha256 },
    { path: "package-lock.json", sha256: receipt.lockSha256 },
    ...receipt.files.map((entry) => ({ path: entry.path, sha256: entry.after })),
    ...receipt.addedFiles,
    ...receipt.binShims,
  ];
  const seen = new Set();
  for (const entry of entries) {
    const path = entry?.path;
    if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..") ||
        seen.has(path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid candidate stage payload record: ${String(path)}`);
    }
    seen.add(path);
    const resolved = await realpath(join(canonicalRoot, path));
    const location = relative(canonicalRoot, resolved);
    if (!location || location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location) || !(await stat(resolved)).isFile()) {
      throw new Error(`Candidate stage payload escaped runtime: ${path}`);
    }
    const hash = createHash("sha256").update(await readFile(resolved)).digest("hex");
    if (hash !== entry.sha256) throw new Error(`Candidate stage payload hash mismatch: ${path}`);
  }
}
