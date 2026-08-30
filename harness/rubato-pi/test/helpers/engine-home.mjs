import { enginePluginDir, resolveEnginePluginDir } from "../../src/engine-paths.mjs";

/** Pin the built engine so child processes with an isolated HOME still find it. */
export function pinIntendedEngineDir(env = process.env) {
  return env.RUBATO_ENGINE_DIR || resolveEnginePluginDir(env) || enginePluginDir;
}

export function engineChildEnv(extra = {}, env = process.env) {
  const dir = pinIntendedEngineDir(env);
  return dir ? { ...extra, RUBATO_ENGINE_DIR: dir } : { ...extra };
}
