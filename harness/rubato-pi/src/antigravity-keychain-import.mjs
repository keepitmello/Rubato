// Antigravity Keychain → profile `auth.json` 일회성 import.
//
// Keychain 은 **입력**일 뿐이다. 권위는 profile `auth.json` 이고, refresh writer 는
// provider `auth.oauth.refresh` 하나다. Keychain 을 상시로 읽으면 writer 가 둘이 되고
// 어느 쪽이 최신인지 알 수 없다.
//
// 규칙:
//   - 직결이 켜져 있고 대상에 `google-antigravity` 가 **없을 때만** 쓴다.
//   - 실 자격이 있으면 덮지 않는다. broker sentinel 은 자격이 아니라 교체한다.
//   - 쓰기 전에 pinned 파서로 검증한다.
//   - 병합은 대상 lock 안에서 한 번에 한다(`credential-import.mjs` 와 같은 이유).
//   - 취소되면 `security` 프로세스를 죽인다.
//   - 오류와 로그에 **값을 싣지 않는다**. provider id 와 고정된 사유 어휘뿐이다.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  credentialFileShapeWith,
  credentialShapeWith,
  defaultTargetAuthPath,
} from "./credential-import.mjs";
import { senpiDir } from "./engine-paths.mjs";

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

/** Keychain 항목. Antigravity 설치가 쓰는 이름이다. */
export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity";

/** go-keyring 이 base64 로 감쌀 때 붙이는 접두사. */
const GO_KEYRING_PREFIX = "go-keyring-base64:";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" ? value : undefined;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/**
 * `security` 로 Keychain 항목을 읽는다.
 *
 * `signal` 이 취소되면 자식을 죽인다. 죽이지 않으면 이 프로세스가 끝날 때까지
 * Keychain 프롬프트가 떠 있을 수 있다.
 */
export function readAntigravityKeychainSecret({ spawnImpl = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let child;
    let out = "";
    let err = "";
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
        ["find-generic-password", "-s", ANTIGRAVITY_KEYCHAIN_SERVICE, "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT, "-w"],
        { stdio: ["ignore", "pipe", "pipe"], signal },
      );
    } catch (error) {
      settle(error);
      return;
    }
    child.stdout?.on("data", (chunk) => { out += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk) => { err += chunk.toString("utf-8"); });
    child.on("error", (error) => {
      settle(error);
    });
    child.on("close", (code) => {
      if (signal?.aborted) settle(abortError(signal));
      else if (code === 0 && out.trim()) settle(undefined, out.trim());
      // stderr 를 그대로 싣지 않는다. `security` 는 항목 이름을 담을 수 있다.
      else settle(new Error(err.trim() ? "antigravity keychain item is unreadable" : "antigravity keychain item is missing"));
    });
    // spawnImpl 가 동기적으로 abort 를 일으킨 뒤 child 를 반환할 수 있다. 먼저 종단
    // listener를 달아야 kill 뒤 늦게 오는 error/close도 process error가 되지 않는다.
    if (signal?.aborted) onAbort();
  });
}

/**
 * Keychain secret 을 token 으로 푼다. 실패 사유에 값을 담지 않는다.
 */
export function decodeAntigravityKeychainSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith(GO_KEYRING_PREFIX)) {
    throw new Error("unexpected antigravity keychain format");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(secret.slice(GO_KEYRING_PREFIX.length), "base64").toString("utf-8"));
  } catch {
    throw new Error("antigravity keychain secret is not valid JSON");
  }
  const token = isObject(parsed) && isObject(parsed.token) ? parsed.token : undefined;
  const access = token ? asString(token.access_token) : undefined;
  const refresh = token ? asString(token.refresh_token) : undefined;
  if (!access || !refresh) throw new Error("antigravity keychain secret has no tokens");
  const expiry = token ? asString(token.expiry) : undefined;
  return { access, refresh, ...(expiry ? { expiry } : {}) };
}

/**
 * 저장할 canonical OAuth credential.
 *
 * **project 를 모르면 만료로 저장한다.** 그래야 첫 요청이 lock 안에서
 * `oauth.refresh` 를 부르고, 그 안에서 `loadCodeAssist` 로 project 를 받아
 * `env.RUBATO_ANTIGRAVITY_PROJECT` 로 굳힌다. `projectId` 를 임의의 OAuth 속성으로
 * 얹으면 pinned `resolveStoredOAuth` 가 그것을 stream 으로 전달하지 않는다 — 그 함수는
 * `credentialEnvironment(credential)` 만 돌려준다.
 */
export function antigravityCredentialFromKeychain(token, { projectId, now = Date.now() } = {}) {
  const expires = projectId
    ? (token.expiry ? Date.parse(token.expiry) || 0 : 0)
    : 0;
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    // project 를 모르면 0 — 즉 이미 만료. 첫 locked refresh 가 채운다.
    expires: projectId ? expires : 0,
    ...(projectId ? { env: { RUBATO_ANTIGRAVITY_PROJECT: projectId } } : {}),
    ...(now === undefined ? {} : {}),
  };
}

async function loadAuthStorageModule() {
  return await import(pathToFileURL(join(senpiDir, "dist/core/auth-storage.js")).href);
}

/** broker 시절 표지. 실 토큰이 아니다. */
export function isBrokerSentinel(entry) {
  return entry?.refresh === "rubato-broker" || entry?.access === "local";
}

/**
 * 대상에 이 provider 자격증명이 이미 있는가. 값은 보지 않는다.
 * broker sentinel 은 자격이 아니다 — 있으면 Keychain import 를 막는다.
 */
export function antigravityCredentialPresent(targetPath, { read = readFileSync, ReadOnlyAuthStorage } = {}) {
  let raw;
  try {
    raw = read(targetPath, "utf-8");
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isObject(parsed)) return false;
  const entry = parsed[ANTIGRAVITY_PROVIDER_ID];
  if (!isObject(entry) || isBrokerSentinel(entry)) return false;
  if (!ReadOnlyAuthStorage) return true;
  return credentialShapeWith(ReadOnlyAuthStorage, ANTIGRAVITY_PROVIDER_ID, entry).ok;
}

/** login() 이 AuthStorage.set 에 넘길 credential. 값은 로그하지 않는다. */
export function readStoredAntigravityCredential(targetPath, { read = readFileSync } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(read(targetPath, "utf-8"));
  } catch {
    return undefined;
  }
  const entry = parsed?.[ANTIGRAVITY_PROVIDER_ID];
  if (!isObject(entry) || isBrokerSentinel(entry)) return undefined;
  if (typeof entry.access !== "string" || entry.access.length === 0) return undefined;
  if (typeof entry.refresh !== "string" || entry.refresh.length === 0) return undefined;
  return entry;
}

/**
 * 일회성 import. 상태 문자열만 돌려준다 — 값은 절대 돌려주지 않는다.
 *
 * status 어휘:
 *   `disabled` | `already_present` | `keychain_unavailable` | `keychain_invalid`
 *   | `rejected` | `target_invalid_json` | `target_not_an_object`
 *   | `target_rejected_by_engine` | `imported` | `skipped`
 */
export async function importAntigravityKeychainCredential({
  env = process.env,
  enabled,
  targetPath = env?.RUBATO_TARGET_AUTH_PATH ?? defaultTargetAuthPath(homedir(), env),
  read = readFileSync,
  spawnImpl = spawn,
  signal,
  backendFactory,
  ReadOnlyAuthStorage,
  projectId = env?.RUBATO_ANTIGRAVITY_PROJECT,
  resolveProjectId,
} = {}) {
  if (enabled !== true) return { status: "disabled" };

  const module = ReadOnlyAuthStorage && backendFactory ? undefined : await loadAuthStorageModule();
  const Parser = ReadOnlyAuthStorage ?? module?.ReadOnlyAuthStorage;
  const Backend = backendFactory ?? module?.FileAuthStorageBackend;
  if (typeof Parser !== "function") throw new Error("pinned senpi has no ReadOnlyAuthStorage");
  if (typeof Backend !== "function") throw new Error("pinned senpi has no FileAuthStorageBackend");

  // 1) 대상을 먼저 본다. 있으면 Keychain 을 **읽지도 않는다** — 프롬프트를 띄우지 않는다.
  if (antigravityCredentialPresent(targetPath, { read, ReadOnlyAuthStorage: Parser })) {
    return { status: "already_present" };
  }

  // 2) Keychain 을 읽고 푼다.
  let token;
  try {
    token = decodeAntigravityKeychainSecret(await readAntigravityKeychainSecret({ spawnImpl, signal }));
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    const message = error instanceof Error ? error.message : "";
    return { status: message.includes("keychain secret") || message.includes("keychain format") ? "keychain_invalid" : "keychain_unavailable" };
  }

  // 3) project를 import 시점에 확정한다. project 없는 access token을 저장하면 pinned
  // resolver가 refresh 전에 아직 유효하다고 보고 request를 보내, transport env가 빈다.
  // access 가 이미 만료면 loadCodeAssist 가 401 이다. 그때는 거절하지 않고 expires=0
  // 으로 저장한다 — `antigravityCredentialFromKeychain` 이 그 계약을 갖고 있다.
  let resolvedProjectId = projectId;
  if ((!resolvedProjectId || typeof resolvedProjectId !== "string") && typeof resolveProjectId === "function") {
    try {
      resolvedProjectId = await resolveProjectId(token, { signal });
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      resolvedProjectId = undefined;
    }
  }

  // 쓰기 전에 검증한다. 엔진이 거절할 항목을 우리가 넣으면 파일 전체가 거절된다.
  const credential = antigravityCredentialFromKeychain(token, { projectId: resolvedProjectId });
  const shape = credentialShapeWith(Parser, ANTIGRAVITY_PROVIDER_ID, credential);
  if (!shape.ok) return { status: "rejected", reason: shape.reason };

  // 4) 대상 lock 안에서 한 번에 병합한다.
  const backend = new Backend(targetPath);
  let status = "imported";
  await backend.withLockAsync(async (current) => {
    let data = {};
    if (typeof current === "string" && current.trim().length > 0) {
      let parsed;
      try {
        parsed = JSON.parse(current);
      } catch {
        status = "target_invalid_json";
        return { result: undefined };
      }
      if (!isObject(parsed)) {
        status = "target_not_an_object";
        return { result: undefined };
      }
      if (!credentialFileShapeWith(Parser, current).ok) {
        status = "target_rejected_by_engine";
        return { result: undefined };
      }
      data = parsed;
    }
    // lock 안에서 다시 본다. 그 사이 로그인이 채운 실 자격이 이긴다.
    // sentinel 은 있는 키가 아니다 — 그대로 두면 Keychain import 가 영구히 skip 된다.
    if (ANTIGRAVITY_PROVIDER_ID in data && !isBrokerSentinel(data[ANTIGRAVITY_PROVIDER_ID])) {
      status = "skipped";
      return { result: undefined };
    }
    return {
      result: undefined,
      next: JSON.stringify({ ...data, [ANTIGRAVITY_PROVIDER_ID]: credential }, null, 2),
    };
  });

  return { status };
}
