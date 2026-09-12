// Build the engine selected for launch, not an unrelated legacy output tree.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStockEngineReceipt, resolveLaunchEngine } from "../rubato-pi/src/engine-selection.mjs";
import { nodeSatisfiesCandidate, selectNodeForEngine } from "../rubato-pi/src/select-node.mjs";
import { sourceFingerprint } from "../pi-runtime/scripts/source-fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildActiveEngine({
  args = [], env = process.env, repoRoot = resolve(here, "../.."),
  legacy = (argv) => {
    const result = spawnSync(process.execPath, [join(here, "build-engine.mjs"), ...argv], { env, stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  },
  update = async () => {
    const { updateStockEngine } = await import("../pi-runtime/scripts/switch-engine.mjs");
    return updateStockEngine({ env });
  },
} = {}) {
  if (args.some((arg) => arg !== "--force" && arg !== "--check") ||
      (args.includes("--force") && args.includes("--check"))) throw new Error("Usage: build-active-engine.mjs [--force|--check]");
  const selection = resolveLaunchEngine({ env });
  // A requested but missing stock install needs installation, not a legacy build.
  if (selection.requested !== "stock-pi") return legacy(args);
  const receipt = readStockEngineReceipt(selection.root);
  const current = selection.engine === "stock-pi" && receipt?.sourceSha256 === await sourceFingerprint(repoRoot);
  if (args.includes("--check")) return current ? 0 : 10;
  if (!args.includes("--force") && current) return 0;
  await update();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const selection = resolveLaunchEngine();
  // Install on a supported runtime rather than failing on an older default node.
  if (selection.requested === "stock-pi" && !args.includes("--check") && !nodeSatisfiesCandidate()) {
    const node = selectNodeForEngine("stock-pi");
    if (!node || !nodeSatisfiesCandidate(node.text)) {
      console.error("Stock Pi build requires Node ^24.15 || >=26");
      process.exitCode = 1;
    } else {
      const child = spawnSync(node.bin, [fileURLToPath(import.meta.url), ...args], { stdio: "inherit" });
      if (child.error) console.error(child.error.message);
      process.exitCode = child.status ?? 1;
    }
  } else {
    buildActiveEngine({ args }).then((code) => { process.exitCode = code; })
      .catch((error) => { console.error(error); process.exitCode = 1; });
  }
}
