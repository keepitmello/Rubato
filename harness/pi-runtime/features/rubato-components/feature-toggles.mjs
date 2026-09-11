import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Factories the candidate cannot run without; a toggle naming them is a configuration error, not a no-op. */
export const REQUIRED_FACTORIES = Object.freeze(["rubato-assets", "providers", "rubato-components"]);

/**
 * Reads the disabled-feature list for a candidate profile.
 * Sources, merged: `<agentDir>/rubato-features.json` (`{ "disabled": ["rubato-goal", ...] }`)
 * and `RUBATO_DISABLED_FEATURES` (comma-separated). Names are bootstrap factory names.
 */
export function readDisabledFeatures({ agentDir, env = process.env } = {}) {
  const disabled = new Set();
  if (agentDir) {
    try {
      const parsed = JSON.parse(readFileSync(join(agentDir, "rubato-features.json"), "utf8"));
      if (parsed && !Array.isArray(parsed.disabled ?? [])) throw new Error("rubato-features.json: \"disabled\" must be an array");
      for (const name of parsed?.disabled ?? []) disabled.add(String(name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const name of String(env.RUBATO_DISABLED_FEATURES ?? "").split(",")) if (name.trim()) disabled.add(name.trim());
  for (const name of disabled) if (REQUIRED_FACTORIES.includes(name)) throw new Error(`Rubato feature "${name}" is required and cannot be disabled`);
  return disabled;
}

/** Drops disabled named factories; unknown names are reported so typos do not silently keep a feature on. */
export function applyFeatureToggles(extensionFactories, disabled) {
  const known = new Set(extensionFactories.map((entry) => entry.name));
  const unknown = [...disabled].filter((name) => !known.has(name));
  const kept = extensionFactories.filter((entry) => !disabled.has(entry.name));
  return { extensionFactories: kept, disabled: [...disabled].filter((name) => known.has(name)), unknown };
}
