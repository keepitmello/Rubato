// OpenCode Zen 키는 사용자가 Keychain 에 이미 넣어 둔다. `/login` 없이
// `auth.apiKey.resolve` 가 그걸 읽게 한다. native `OPENCODE_API_KEY` 와 저장된
// credential 이 먼저다 — 사용자가 명시한 값을 Keychain 이 덮지 않는다.
import { spawn } from "node:child_process";

export const OPENCODE_KEYCHAIN_SERVICE = "opencode.ai";
export const OPENCODE_KEYCHAIN_SOURCE = "opencode.ai Keychain";

function abortError(signal) {
  const error = signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/**
 * `security find-generic-password -s opencode.ai -w`
 *
 * 없거나 못 읽으면 `undefined`. 던지지 않는다 — Keychain 이 없는 기기에서
 * OpenCode 만 unavailable 이어야 하고 부팅을 막으면 안 된다. 취소는 예외다.
 */
export function readOpenCodeKeychainSecret({ spawnImpl = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let child;
    let out = "";
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => {
      try {
        child?.kill("SIGTERM");
      } catch {
        // 이미 끝난 자식.
      }
      settle(abortError(signal));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      child = spawnImpl(
        "security",
        ["find-generic-password", "-s", OPENCODE_KEYCHAIN_SERVICE, "-w"],
        { stdio: ["ignore", "pipe", "ignore"], ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) settle(abortError(signal));
      else settle(undefined, undefined);
      return;
    }
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if (signal?.aborted || isAbortError(error)) settle(abortError(signal));
      else settle(undefined, undefined);
    });
    child.on("close", (code) => {
      if (signal?.aborted) settle(abortError(signal));
      else settle(undefined, code === 0 && out.trim() ? out.trim() : undefined);
    });
    if (signal?.aborted) onAbort();
  });
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
