import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export function compileCacheDir(home = homedir(), env = process.env) {
  if (typeof env.NODE_COMPILE_CACHE === "string" && env.NODE_COMPILE_CACHE.trim()) {
    return env.NODE_COMPILE_CACHE;
  }
  return join(home, ".rubato-pi", "compile-cache");
}

/** Warm Node compile cache for the senpi graph. Failures are ignored. */
export function enableRubatoCompileCache(env = process.env) {
  const dir = compileCacheDir(undefined, env);
  try {
    enableCompileCache(dir);
    if (!env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = dir;
    return dir;
  } catch {
    return undefined;
  }
}
