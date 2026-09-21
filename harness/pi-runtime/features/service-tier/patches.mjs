import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.86.1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`[service-tier:${label}] expected anchor is missing`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[service-tier:${label}] expected anchor is ambiguous`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patch(path, preimageSha256, apply) {
  return Object.freeze({
    id: `service-tier:${path}`,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    path,
    preimageSha256,
    apply,
  });
}

function patchSettingsRuntime(source) {
  let next = replaceOnce(
    source,
    `function isMergeableObject(value) {`,
    `const MODEL_SERVICE_TIER_VALUES = new Set(["auto", "flex", "priority"]);
function modelMemoryKey(provider, modelId) {
    return \`${'${provider}'}/${'${modelId}'}\`;
}
function readModelServiceTier(map, key) {
    if (typeof map !== "object" || map === null || Array.isArray(map))
        return undefined;
    const value = map[key];
    return typeof value === "string" && MODEL_SERVICE_TIER_VALUES.has(value) ? value : undefined;
}
function isMergeableObject(value) {`,
    "settings-runtime-helpers",
  );
  return replaceOnce(
    next,
    `    removeModelThinkingLevel(provider, modelId) {
        if (!this.globalSettings.modelThinkingLevels)
            return;
        delete this.globalSettings.modelThinkingLevels[\`${'${provider}'}/${'${modelId}'}\`];
        if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
            delete this.globalSettings.modelThinkingLevels;
        }
        this.markModified("modelThinkingLevels");
        this.save();
    }
    getTransport() {`,
    `    removeModelThinkingLevel(provider, modelId) {
        if (!this.globalSettings.modelThinkingLevels)
            return;
        delete this.globalSettings.modelThinkingLevels[\`${'${provider}'}/${'${modelId}'}\`];
        if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
            delete this.globalSettings.modelThinkingLevels;
        }
        this.markModified("modelThinkingLevels");
        this.save();
    }
    getModelServiceTier(provider, modelId) {
        return readModelServiceTier(this.settings.modelServiceTiers, modelMemoryKey(provider, modelId));
    }
    setModelServiceTier(provider, modelId, tier) {
        const key = modelMemoryKey(provider, modelId);
        const existing = this.globalSettings.modelServiceTiers;
        const map = typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
        if (tier === undefined)
            delete map[key];
        else
            map[key] = tier;
        this.globalSettings.modelServiceTiers = map;
        this.markModified("modelServiceTiers", key);
        this.save();
    }
    getTransport() {`,
    "settings-runtime-methods",
  );
}

function patchSettingsTypes(source) {
  let next = replaceOnce(
    source,
    `export type TransportSetting = Transport;
/**
 * Package source for npm/git packages.`,
    `export type TransportSetting = Transport;
/** Service tier remembered per model; "auto" explicitly disables inherited priority. */
export type ModelServiceTier = "auto" | "flex" | "priority";
/**
 * Package source for npm/git packages.`,
    "settings-types-tier",
  );
  next = replaceOnce(
    next,
    `    defaultThinkingLevel?: ThinkingLevel;
    modelThinkingLevels?: Record<string, ThinkingLevel>;
    transport?: TransportSetting;`,
    `    defaultThinkingLevel?: ThinkingLevel;
    modelThinkingLevels?: Record<string, ThinkingLevel>;
    modelServiceTiers?: Record<string, ModelServiceTier>;
    transport?: TransportSetting;`,
    "settings-types-field",
  );
  return replaceOnce(
    next,
    `    setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void;
    removeModelThinkingLevel(provider: string, modelId: string): void;
    getTransport(): TransportSetting;`,
    `    setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void;
    removeModelThinkingLevel(provider: string, modelId: string): void;
    /** Service tier last set for this exact model, or undefined when unknown/invalid on disk. */
    getModelServiceTier(provider: string, modelId: string): ModelServiceTier | undefined;
    /** Remember (or with undefined, forget) this model's service tier in global settings. */
    setModelServiceTier(provider: string, modelId: string, tier: ModelServiceTier | undefined): void;
    getTransport(): TransportSetting;`,
    "settings-types-methods",
  );
}

export const patches = Object.freeze([
  patch(
    "dist/core/settings-manager.js",
    "5368b155ec26d88374cec9e66b8e588b5041a0fb0047414f70b34e13892c4f48",
    patchSettingsRuntime,
  ),
  patch(
    "dist/core/settings-manager.d.ts",
    "0531dc8f094401117e237cc97d71b5524b4ff76bf958bda4f552268d76af7d44",
    patchSettingsTypes,
  ),
]);

export const files = Object.freeze([
  Object.freeze({
    target: "runtime",
    version: PACKAGE_VERSION,
    path: "rubato-features/service-tier/extension.mjs",
    sourcePath: fileURLToPath(new URL("./extension.mjs", import.meta.url)),
  }),
  Object.freeze({
    target: "runtime",
    version: PACKAGE_VERSION,
    path: "rubato-features/service-tier/THIRD_PARTY_NOTICES.md",
    sourcePath: fileURLToPath(new URL("./THIRD_PARTY_NOTICES.md", import.meta.url)),
  }),
]);

export const serviceTierRuntimeFeature = Object.freeze({
  id: "service-tier",
  patches,
  files,
});
