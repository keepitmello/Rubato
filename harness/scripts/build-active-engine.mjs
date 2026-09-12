// Build the engine selected for launch, not an unrelated legacy output tree.
//
// Since the senpi fallback was retired, resolveLaunchEngine always reports
// stock-pi, so this script has exactly one job: install or refresh the stock
// candidate. The old `requested !== "stock-pi"` branch into the senpi plugin
// build became unreachable and is gone; that plugin build is still reachable
// on its own as `npm run build:senpi` until the senpi excision removes it.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStockEngineReceipt, resolveLaunchEngine } from "../rubato-pi/src/engine-selection.mjs";
import { nodeSatisfiesCandidate, selectNodeForEngine } from "../rubato-pi/src/select-node.mjs";
import { sourceFingerprint } from "../pi-runtime/scripts/source-fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildActiveEngine({
  args = [], env = process.env, repoRoot = resolve(here, "../.."),
  update = async () => {
    const { updateStockEngine } = await import("../pi-runtime/scripts/switch-engine.mjs");
    return updateStockEngine({ env });
  },
} = {}) {
  if (args.some((arg) => arg !== "--force" && arg !== "--check") ||
      (args.includes("--force") && args.includes("--check"))) throw new Error("Usage: build-active-engine.mjs [--force|--check]");
  const selection = resolveLaunchEngine({ env });
  const receipt = readStockEngineReceipt(selection.root);
  const current = selection.engine === "stock-pi" && receipt?.sourceSha256 === await sourceFingerprint(repoRoot);
  if (args.includes("--check")) return current ? 0 : 10;
  if (!args.includes("--force") && current) return 0;
  await update();
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // Install on a supported runtime rather than failing on an older default node.
  if (!args.includes("--check") && !nodeSatisfiesCandidate()) {
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
