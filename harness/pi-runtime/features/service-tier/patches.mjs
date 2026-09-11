import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_VERSION = "0.85.1";

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
    `import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.js";
function isMergeableObject(value) {`,
    `import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.js";
const MODEL_SERVICE_TIER_VALUES = new Set(["auto", "flex", "priority"]);
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
    "ee4f52d1dd4f1c18d5d814be4ba260ddf7fe40b7b70c2f0732a30a8b287111ad",
    patchSettingsRuntime,
  ),
  patch(
    "dist/core/settings-manager.d.ts",
    "a5318385802b507ce35bc3c5e430843d7366d3fb4d8ced6e4503ff8f76298f6f",
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
