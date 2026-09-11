import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STORE_NAME = "rubato-fallback.json";

function formatModel(model) {
  return model.provider + "/" + model.id;
}

function parseSelector(value) {
  const [provider, ...rest] = String(value).split("/");
  const id = rest.join("/");
  if (!provider || !id) return undefined;
  return { provider, id, thinking: undefined, raw: value };
}

async function loadStore(agentDir) {
  try {
    return JSON.parse(await readFile(join(agentDir, STORE_NAME), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { modelFallback: false, revertPolicy: "cooldown-expiry", chains: {} };
    throw error;
  }
}

async function saveStore(agentDir, store) {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, STORE_NAME), JSON.stringify(store, null, 2) + "\n");
}

function renderState(store, currentModel) {
  const rows = Object.entries(store.chains ?? {}).map(([target, entries]) => target + " -> " + entries.join(", "));
  const chains = rows.length > 0 ? rows.join("\n") : "No fallback chains configured.";
  const current = currentModel ? formatModel(currentModel) : "none";
  return [
    chains,
    "Model fallback: disabled (automatic retry path stays off)",
    "Revert policy: " + (store.revertPolicy ?? "cooldown-expiry"),
    "Current model: " + current,
    "Use /fallback now to switch to the first fallback of the current model.",
  ].join("\n");
}

export function createModelFallbackExtension(options = {}) {
  return (pi) => {
    pi.registerFlag("no-model-fallback", {
      type: "boolean",
      default: true,
      description: "Disable retry model fallback for this run. The candidate keeps the automatic path off.",
    });
    pi.registerCommand("fallback", {
      description: "View and manage retry model fallback chains, or switch now.",
      argumentHint: "[now | target fallback1 fallback2 ...]",
      handler: async (rawArgs, ctx) => {
        const agentDir = options.agentDir ?? ctx.sessionManager.getSessionDir?.() ?? ctx.cwd;
        const store = await loadStore(agentDir);
        const args = rawArgs.trim().split(/\s+/).filter(Boolean);
        if (args.length === 0) {
          ctx.ui.notify(renderState(store, ctx.model), "info");
          return;
        }
        if (args.length === 1 && args[0].toLowerCase() === "now") {
          const current = ctx.model ? formatModel(ctx.model) : undefined;
          const chain = current ? store.chains?.[current] : undefined;
          if (!chain || chain.length === 0) {
            ctx.ui.notify("No fallback chain for the current model. Save one with /fallback <target> <fallback...>.", "warning");
            return;
          }
          const next = parseSelector(chain[0]);
          const model = next && ctx.modelRegistry.find(next.provider, next.id);
          if (!model) {
            ctx.ui.notify("Fallback model not found: " + chain[0], "error");
            return;
          }
          const switched = await pi.setModel(model);
          if (!switched) {
            ctx.ui.notify("Could not switch to " + formatModel(model) + ".", "error");
            return;
          }
          ctx.ui.notify("Switched to fallback model " + formatModel(model) + ".", "info");
          return;
        }
        if (args.length < 2) {
          ctx.ui.notify("Usage: /fallback <target> <fallback1> [fallback2 ...]\n       /fallback now", "error");
          return;
        }
        const target = args[0];
        const entries = args.slice(1);
        const available = new Set(ctx.modelRegistry.getAvailable().map(formatModel));
        const unknown = [target, ...entries].map(parseSelector).filter((item) => !item || !available.has(item.provider + "/" + item.id));
        if (unknown.length > 0) {
          ctx.ui.notify("Unknown model in fallback chain: " + args.join(", "), "warning");
          return;
        }
        store.modelFallback = false;
        store.chains = { ...store.chains, [target]: entries };
        await saveStore(agentDir, store);
        ctx.ui.notify("Fallback chain saved for " + target + ".", "info");
      },
    });
  };
}

export default createModelFallbackExtension;

