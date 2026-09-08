import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const DISPLAY_NAMES = { anthropic: "Anthropic", cursor: "Cursor", kiro: "Kiro", xai: "xAI" };
export const SUPPORTED_PROVIDER_IDS = Object.freeze(Object.keys(DISPLAY_NAMES).sort());

function safeModelIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((model) => typeof model === "string"
    && model.length > 0
    && model === model.trim()
    && !/[\u0000-\u001f\u007f]/.test(model));
}

function providerModels(config, providerId, rootConfig) {
  const configured = safeModelIds(config.models);
  const custom = Array.isArray(rootConfig.customModels)
    ? rootConfig.customModels
      .filter((model) => model && model.provider === providerId)
      .map((model) => model.modelId)
    : [];
  const candidates = Array.isArray(config.selectedModels) && config.selectedModels.length > 0
    ? safeModelIds(config.selectedModels)
    : [...configured, ...safeModelIds(custom)];
  const disabled = new Set(safeModelIds(rootConfig.disabledModels));
  return [...new Set(candidates)]
    .map((model) => `${providerId}/${model}`)
    .filter((model) => !disabled.has(model))
    .sort();
}

export function parseProviderArgument(value) {
  if (value === "none") return [];
  const providers = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!providers.length) throw new Error("--providers needs 'none' or a comma-separated provider list");
  if (providers.some((item) => !/^[a-z0-9][a-z0-9_-]*$/i.test(item))) throw new Error("--providers contains an invalid provider id");
  return [...new Set(providers)].sort();
}

export async function discoverProviderCatalog(options = {}) {
  const home = resolve(options.opencodexHome || process.env.OPENCODEX_HOME || join(homedir(), ".opencodex"));
  const configPath = join(home, "config.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {
      status: "missing",
      configPath,
      providers: SUPPORTED_PROVIDER_IDS.map((id) => ({ id, displayName: DISPLAY_NAMES[id], source: "opencodex-registry", configured: false, models: [] })),
    };
    return { status: "unreadable", configPath, providers: [], error: error.message };
  }
  if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
    return { status: "unreadable", configPath, providers: [], error: "providers must be an object" };
  }
  const configuredProviders = Object.entries(parsed.providers)
    .filter(([id, config]) => id !== "openai" && config && typeof config === "object" && !Array.isArray(config))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, config]) => ({
      id,
      displayName: DISPLAY_NAMES[id] || id,
      source: "opencodex",
      configured: true,
      models: providerModels(config, id, parsed),
    }));
  const configuredIds = new Set(configuredProviders.map((provider) => provider.id));
  const providers = [
    ...configuredProviders,
    ...SUPPORTED_PROVIDER_IDS.filter((id) => !configuredIds.has(id)).map((id) => ({
      id,
      displayName: DISPLAY_NAMES[id],
      source: "opencodex-registry",
      configured: false,
      models: [],
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return { status: "available", configPath, port: Number.isInteger(parsed.port) ? parsed.port : undefined, roster: safeModelIds(parsed.subagentModels), providers };
}

export async function promptForProviders(catalog, input = process.stdin, output = process.stdout) {
  if (!catalog.providers.length) return [];
  output.write("Optional OpenCodex providers (native Codex is always enabled):\n");
  catalog.providers.forEach((provider, index) => output.write(`  [ ] ${index + 1}. ${provider.displayName} (${provider.id})\n`));
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question("Select providers by number or id (comma-separated; Enter = none): ")).trim();
    if (!answer) return [];
    const byNumber = new Map(catalog.providers.map((provider, index) => [String(index + 1), provider.id]));
    return parseProviderArgument(answer.split(",").map((item) => byNumber.get(item.trim()) || item.trim()).join(","));
  } finally {
    prompt.close();
  }
}

export async function resolveProviderSelection({ requested, previous, catalog, interactive, prompt = promptForProviders }) {
  if (requested !== undefined) {
    const selected = parseProviderArgument(requested);
    const available = new Set(catalog.providers.map((provider) => provider.id));
    const missing = selected.filter((id) => !available.has(id));
    if (missing.length) {
      const reason = catalog.status === "available" ? "not configured in OpenCodex" : `OpenCodex config is ${catalog.status}`;
      throw new Error(`provider selection unavailable (${reason}): ${missing.join(", ")}`);
    }
    return { selected, source: "explicit" };
  }
  if (Array.isArray(previous)) return { selected: [...new Set(previous)].sort(), source: "preserved" };
  if (!interactive || !catalog.providers.length) return { selected: [], source: "default" };
  const selected = await prompt(catalog);
  const available = new Set(catalog.providers.map((provider) => provider.id));
  const missing = selected.filter((id) => !available.has(id));
  if (missing.length) throw new Error(`provider selection unavailable: ${missing.join(", ")}`);
  return { selected: [...new Set(selected)].sort(), source: "interactive" };
}

export function makeProviderPolicy(catalog, selectedProviders) {
  const result = {
    version: 1,
    selectedProviders: [...selectedProviders],
    availableProviders: catalog.providers,
    opencodex: { status: catalog.status, configPath: catalog.configPath },
  };
  if (catalog.port !== undefined) result.opencodex.port = catalog.port;
  return `${JSON.stringify(result, null, 2)}\n`;
}
