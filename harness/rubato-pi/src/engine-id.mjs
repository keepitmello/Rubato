// Canonical product engine name. "stock-pi" was the cutover contrast with the
// retired senpi fork; the only launchable engine is now just pi.
export const ENGINE_ID = "pi";
export const LEGACY_ENGINE_ID = "stock-pi";
export const RETIRED_ENGINE_ID = "senpi";

export const PI_ENGINE_DIRNAME = "pi";
export const LEGACY_PI_ENGINE_DIRNAME = "stock-engine";

export const PI_ENGINE_DIR_ENV = "RUBATO_PI_ENGINE_DIR";
export const LEGACY_PI_ENGINE_DIR_ENV = "RUBATO_STOCK_ENGINE_DIR";

export function isLaunchableEngineId(value) {
  return value === ENGINE_ID || value === LEGACY_ENGINE_ID;
}

export function normalizeEngineId(value) {
  return isLaunchableEngineId(value) ? ENGINE_ID : value;
}

export function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}
