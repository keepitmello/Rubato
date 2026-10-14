// OpenCode Zen 키는 사용자가 Keychain 에 이미 넣어 둔다. `/login` 없이
// `auth.apiKey.resolve` 가 그걸 읽게 한다. native `OPENCODE_API_KEY` 와 저장된
// credential 이 먼저다 — 사용자가 명시한 값을 Keychain 이 덮지 않는다.
import { isAbortError, readKeychainSecret } from "./keychain-secret.mjs";

export const OPENCODE_KEYCHAIN_SERVICE = "opencode.ai";
export const OPENCODE_KEYCHAIN_SOURCE = "opencode.ai Keychain";

/** `security find-generic-password -s opencode.ai -w`. 없거나 못 읽으면 `undefined`. */
export function readOpenCodeKeychainSecret({ spawnImpl, signal } = {}) {
  return readKeychainSecret({ service: OPENCODE_KEYCHAIN_SERVICE, signal, ...(spawnImpl ? { spawnImpl } : {}) });
}

/**
 * pinned OpenCode provider 에 Keychain fallback 을 덧댄다.
 *
 * 감싸는 것은 `auth.apiKey.resolve` 하나뿐이다. native 가 값을 주면 그대로 쓴다.
 */
export function withOpenCodeKeychain(provider, options = {}) {
  const nativeApiKey = provider?.auth?.apiKey;
  if (!nativeApiKey || typeof nativeApiKey.resolve !== "function") {
    throw new Error("pinned opencodeProvider has no auth.apiKey.resolve to extend");
  }
  const keychainLookup = options.keychainLookup ?? readOpenCodeKeychainSecret;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...nativeApiKey,
        resolve: async (args) => {
          const native = await nativeApiKey.resolve(args);
          if (native) return native;
          let key;
          try {
            key = await keychainLookup({ signal: args?.signal, ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}) });
          } catch (error) {
            if (args?.signal?.aborted || isAbortError(error)) throw error;
            return undefined;
          }
          if (!key) return undefined;
          return { auth: { apiKey: key }, source: OPENCODE_KEYCHAIN_SOURCE };
        },
      },
    },
  };
}
