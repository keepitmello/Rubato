// Resolves stock @earendil-works/pi-ai@0.84.2 plus Rubato-owned overlay files.
// Never walks @code-yeongyu/senpi. Lead stages stock pi-ai, applies pi-ai patches,
// then copies harness/pi-patches/pi-ai/0.84.2/owned/ onto that tree.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
export const PI_AI_OWNED_OVERLAY = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2", "owned");
export const PI_AGENT_CORE_OWNED_OVERLAY = join(
  repoRoot,
  "harness",
  "pi-patches",
  "pi-agent-core",
  "0.84.2",
  "owned",
);
const STOCK_NAME = "@earendil-works/pi-ai";
const STOCK_VERSION = "0.84.2";

function readIdentity(root) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

function isStockPiAi(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  if (pkg.version !== STOCK_VERSION) return false;
  const name = String(pkg.name ?? "");
  if (name.includes("senpi")) return false;
  return name === STOCK_NAME || name.endsWith("/pi-ai");
}

/**
 * Stock pi-ai 0.84.2 root. Set PI_STOCK_PI_AI_DIR, or install
 * @earendil-works/pi-ai@0.84.2 at repo node_modules (not a senpi alias).
 */
export function resolvePiAiRoot(env = process.env) {
  const explicit = env?.PI_STOCK_PI_AI_DIR;
  if (typeof explicit === "string" && explicit.trim()) {
    const root = explicit.trim();
    const pkg = readIdentity(root);
    if (!isStockPiAi(pkg)) {
      throw new Error(
        `pi-provider-bridge: PI_STOCK_PI_AI_DIR is ${pkg?.name}@${pkg?.version}, want ${STOCK_NAME}@${STOCK_VERSION}`,
      );
    }
    return root;
  }
  const installed = join(repoRoot, "node_modules", "@earendil-works", "pi-ai");
  const pkg = readIdentity(installed);
  if (isStockPiAi(pkg)) return installed;
  throw new Error(
    "pi-provider-bridge: set PI_STOCK_PI_AI_DIR to an unpacked @earendil-works/pi-ai@0.84.2 tree",
  );
}

/**
 * File under stock pi-ai, falling back to the owned overlay for fork-only modules
 * (cursor tree, visible-text, empty-recovery-gate).
 */
export function resolvePiAiFile(rel, env = process.env) {
  const root = resolvePiAiRoot(env);
  const staged = join(root, rel);
  if (existsSync(staged)) return staged;
  const owned = join(PI_AI_OWNED_OVERLAY, rel);
  if (existsSync(owned)) return owned;
  throw new Error(`pi-provider-bridge: missing ${rel} under stock ${root} and owned overlay`);
}
