// Gemini API(AI Studio) 키는 사용자가 Keychain 서비스 `gemini` 에 넣어 둔다. `/login` 없이
// `auth.apiKey.resolve` 가 그걸 읽게 한다. native `GEMINI_API_KEY` 와 저장된 credential 이
// 먼저다 — 사용자가 명시한 값을 Keychain 이 덮지 않는다.
import { isAbortError, readKeychainSecret, readKeychainSecretShared } from "./keychain-secret.mjs";

export const GEMINI_PROVIDER_ID = "google";
export const GEMINI_KEYCHAIN_SERVICE = "gemini";
export const GEMINI_KEYCHAIN_SOURCE = "gemini Keychain";

/** `security find-generic-password -s gemini -w`. 없거나 못 읽으면 `undefined`. */
export function readGeminiKeychainSecret({ spawnImpl, signal } = {}) {
  const request = { service: GEMINI_KEYCHAIN_SERVICE, signal };
  return spawnImpl ? readKeychainSecret({ ...request, spawnImpl }) : readKeychainSecretShared(request);
}

/**
 * pinned Google(Gemini API) provider 에 Keychain fallback 을 덧댄다.
 *
 * 감싸는 것은 `auth.apiKey.resolve` 하나뿐이다. native 가 값을 주면 그대로 쓴다.
 */
export function withGeminiKeychain(provider, options = {}) {
  const nativeApiKey = provider?.auth?.apiKey;
  if (!nativeApiKey || typeof nativeApiKey.resolve !== "function") {
    throw new Error("pinned googleProvider has no auth.apiKey.resolve to extend");
  }
  const keychainLookup = options.keychainLookup ?? readGeminiKeychainSecret;
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
          return { auth: { apiKey: key }, source: GEMINI_KEYCHAIN_SOURCE };
        },
      },
    },
  };
}
