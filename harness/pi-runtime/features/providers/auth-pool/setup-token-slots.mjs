export const SETUP_TOKEN_SLOT_NAME = "setup-token";
export const SETUP_TOKEN_LANE = "setup-token";
export const SETUP_TOKEN_ENV_NAME = "claude-setup-token";

function envRecord(env) {
  if (typeof env === "function") {
    return new Proxy(Object.create(null), {
      get: (_target, name) => (typeof name === "string" ? env(name) : undefined),
    });
  }
  return env ?? {};
}

async function defaultReadClaudeSetupToken(args) {
  const candidates = [
    new URL("../src/anthropic-setup-token.mjs", import.meta.url),
    new URL("../../../../rubato-pi/src/anthropic-setup-token.mjs", import.meta.url),
  ];
  let lastError;
  for (const url of candidates) {
    try {
      const mod = await import(url.href);
      if (typeof mod.readClaudeSetupToken === "function") {
        return await mod.readClaudeSetupToken(args);
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return undefined;
}

export async function discoverSetupTokenSlots(providerId, env, options = {}) {
  if (providerId !== "anthropic") return [];
  const read = options.readClaudeSetupToken ?? defaultReadClaudeSetupToken;
  let found;
  try {
    found = await read({ env: envRecord(env), signal: options.signal });
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    return [];
  }
  if (!found?.token) return [];
  return [{
    name: SETUP_TOKEN_SLOT_NAME,
    lane: SETUP_TOKEN_LANE,
    envVarName: SETUP_TOKEN_ENV_NAME,
    key: found.token,
    source: "setup-token",
  }];
}
