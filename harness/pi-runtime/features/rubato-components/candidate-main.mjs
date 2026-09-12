// Explicit incomplete-candidate entry. Never installs itself as the user's
// default engine, and never chooses the user's normal profile implicitly.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCandidateStage } from "./validate-stage.mjs";

export const CANDIDATE_FEATURE_NAMES = Object.freeze(["runtime-factories", "reload", "tool-execution", "input-lifecycle", "abort-provenance",
  "request-run", "extension-rpc", "service-tier", "tool-search", "mcp", "mcp-producers", "codemode",
  "child-runtime", "terminal", "providers", "provider-execution", "media-tools", "video-in", "tool-guards", "tool-policy", "context-window", "session-catalog", "session-picker", "prompt-rules", "prompt-preset", "compaction", "config-reload", "user-commands-agent", "user-commands-session", "remote-surface", "tui-input", "turn-chrome", "statusline", "tui-autocomplete", "model-picker", "thinking-levels", "transcript-cache", "title-guard"]);
const requiredFeatures = [...CANDIDATE_FEATURE_NAMES, "rubato-components"];

export async function runRubatoCandidate(args = process.argv.slice(2)) {
  const requestedAgentDir = process.env.RUBATO_CANDIDATE_AGENT_DIR;
  if (!requestedAgentDir || !isAbsolute(requestedAgentDir)) throw new Error("Incomplete Rubato candidate requires an explicit absolute RUBATO_CANDIDATE_AGENT_DIR");
  const agentDir = resolve(requestedAgentDir);
  const receipt = JSON.parse(await readFile(new URL("../../rubato-pi-stage.json", import.meta.url), "utf8"));
  if (receipt.version !== 1 || receipt.state !== "ready" || receipt.stockVersion !== "0.85.1" ||
      receipt.entryMode !== "unbundled" || receipt.fullRubatoParity !== false ||
      !Array.isArray(receipt.features) || requiredFeatures.some((name) => !receipt.features.includes(name))) {
    throw new Error("Incomplete Rubato candidate is missing its selected runtime features");
  }
  await validateCandidateStage(fileURLToPath(new URL("../..", import.meta.url)), receipt);
  // Set profile identity before importing any provider/state-owning module.
  // Wrappers may carry a live Senpi/Pi package or session location. Those
  // inherited defaults must not redirect this explicit incomplete candidate.
  process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
  delete process.env.PI_MANAGED_INSTALL_ROOT;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.RUBATO_PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");
  const { createRubatoExtensionFactories, validateRubatoBundleAssets } = await import("./bootstrap.mjs");
  await validateRubatoBundleAssets();
  const { main } = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/main.js");
  await main(args, { createExtensionFactories: (context) => {
    if (context.agentDir !== agentDir || !context.settingsManager || !context.modelRuntime) {
      throw new Error("Rubato candidate did not receive canonical stock runtime services");
    }
    return createRubatoExtensionFactories(context).extensionFactories;
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRubatoCandidate().catch((error) => { console.error(error); process.exitCode = 1; });
}
