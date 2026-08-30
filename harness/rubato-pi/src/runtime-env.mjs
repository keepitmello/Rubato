export const CHILD_EXTENSIONS_ENV = "RUBATO_MEMORY_CHILD_EXTENSIONS";

export function applyChildExtensionsEnv(env, paths, delimiter) {
  env[CHILD_EXTENSIONS_ENV] = paths.join(delimiter);
  return env;
}
