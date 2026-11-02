// macOS Keychain generic password 를 한 번 읽는다. OpenCode·Vertex 레인이 같이 쓴다.
import { spawn } from "node:child_process";

export function keychainAbortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/** How long one Keychain answer serves every caller. */
export const KEYCHAIN_REUSE_MS = 60_000;
const sharedReads = new Map();

/**
 * `readKeychainSecret` 와 같은 답을, 서비스·계정마다 한 번 읽어 `KEYCHAIN_REUSE_MS` 동안 모든 호출에 준다.
 *
 * 모델 목록을 다시 셀 때마다 프로바이더마다 인증을 확인해서, 대화 하나를 여는 데 `security` 가
 * 100번 떴다. 엔진은 대화 전부를 한 스레드에서 돌리니 그 프로세스 생성이 열리는 동안 모든 대화를
 * 6.9초 붙잡았다(2026-11-02 실측). 값이 없다는 답도 같이 기억한다. 공유하는 읽기는 한 호출자의
 * 취소로 끊지 않고, 취소한 호출자만 기다리기를 그만둔다.
 */
export function readKeychainSecretShared({ service, account, signal, read = readKeychainSecret, now = Date.now } = {}) {
  if (signal?.aborted) return Promise.reject(keychainAbortError(signal));
  const key = JSON.stringify([service, account ?? null]);
  let entry = sharedReads.get(key);
  if (!entry || now() - entry.at >= KEYCHAIN_REUSE_MS) {
    entry = { at: now(), value: Promise.resolve().then(() => read({ service, ...(account ? { account } : {}) })) };
    sharedReads.set(key, entry);
    entry.value.catch(() => { if (sharedReads.get(key) === entry) sharedReads.delete(key); });
  }
  if (!signal) return entry.value;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(keychainAbortError(signal));
    signal.addEventListener?.("abort", onAbort, { once: true });
    entry.value.then(resolve, reject).finally(() => signal.removeEventListener?.("abort", onAbort));
  });
}

/** 다음 읽기가 Keychain 에 다시 묻게 한다. 이 프로세스가 값을 바꾼 뒤에 부른다. */
export function forgetKeychainSecrets() {
  sharedReads.clear();
}

/**
 * `security find-generic-password -s <service> [-a <account>] -w`
 *
 * 없거나 못 읽으면 `undefined`. 던지지 않는다 — Keychain 이 없는 기기에서는 그
 * 레인만 unavailable 이어야 하고 부팅을 막으면 안 된다. 취소는 예외다.
 */
export function readKeychainSecret({ service, account, spawnImpl = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(keychainAbortError(signal));
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
      settle(keychainAbortError(signal));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
    try {
      child = spawnImpl("security", args, { stdio: ["ignore", "pipe", "ignore"], ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) settle(keychainAbortError(signal));
      else settle(undefined, undefined);
      return;
    }
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if (signal?.aborted || isAbortError(error)) settle(keychainAbortError(signal));
      else settle(undefined, undefined);
    });
    child.on("close", (code) => {
      if (signal?.aborted) settle(keychainAbortError(signal));
      else settle(undefined, code === 0 && out.trim() ? out.trim() : undefined);
    });
    if (signal?.aborted) onAbort();
  });
}
