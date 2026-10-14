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
