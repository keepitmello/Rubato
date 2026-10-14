// Google Vertex 자격증명은 사용자가 Keychain 서비스 `vertex` 에 넣어 둔다. `/login` 없이
// `auth.apiKey.resolve` 가 그걸 읽게 한다. 저장된 credential 과 native 경로(GOOGLE_CLOUD_API_KEY,
// gcloud ADC)가 먼저다 — 사용자가 명시한 값을 Keychain 이 덮지 않는다.
//
// 값은 둘 중 하나다.
//   - 서비스 계정 JSON (`"type": "service_account"`): project 는 JSON 의 project_id, location 은
//     GOOGLE_CLOUD_LOCATION 이 없으면 global. JSON 은 요청 env 로만 넘기고 디스크에 쓰지 않는다.
//     pinned google-vertex 는 서비스 계정을 파일 경로로만 받아서, 그 env 를 읽는 자리는
//     pi-runtime providers 기능의 google-vertex 패치가 연다.
//   - 그 밖의 문자열: Vertex express 모드 API 키.
import { isAbortError, readKeychainSecret } from "./keychain-secret.mjs";

export const VERTEX_PROVIDER_ID = "google-vertex";
export const VERTEX_KEYCHAIN_SERVICE = "vertex";
/** 같은 서비스에 항목이 여럿일 때 고를 계정. 없으면 서비스만으로 찾는다. */
export const VERTEX_KEYCHAIN_ACCOUNT_ENV = "RUBATO_VERTEX_KEYCHAIN_ACCOUNT";
export const VERTEX_KEYCHAIN_SOURCE = "vertex Keychain";
/** 서비스 계정 JSON 을 요청 env 로 실어 나르는 이름. pinned google-vertex 패치가 같은 이름을 읽는다. */
export const VERTEX_SERVICE_ACCOUNT_JSON_ENV = "RUBATO_VERTEX_SERVICE_ACCOUNT_JSON";
export const VERTEX_DEFAULT_LOCATION = "global";

/**
 * `security -w` 는 값에 줄바꿈 같은 비인쇄 문자가 있으면 hex 로 찍는다. hex 로 보이고 풀어서
 * JSON 객체가 되면 푼 값을, 아니면 받은 그대로를 돌려준다.
 */
export function decodeKeychainValue(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return value;
  const decoded = Buffer.from(value, "hex").toString("utf-8").trim();
  return decoded.startsWith("{") ? decoded : value;
}

/** 서비스 계정 JSON 이면 그 객체를, 아니면 `undefined`. */
export function parseServiceAccount(value) {
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed?.type !== "service_account") return undefined;
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return undefined;
  if (typeof parsed.project_id !== "string" || parsed.project_id.length === 0) return undefined;
  return parsed;
}

/** Keychain 값 하나를 provider auth resolution 으로 바꾼다. 쓸 수 없는 값이면 `undefined`. */
export function vertexAuthFromSecret(raw, { location } = {}) {
  const value = decodeKeychainValue(raw);
  if (!value) return undefined;
  const account = parseServiceAccount(value);
  if (account) {
    return {
      auth: {},
      env: {
        GOOGLE_CLOUD_PROJECT: account.project_id,
        GOOGLE_CLOUD_LOCATION: location || VERTEX_DEFAULT_LOCATION,
        [VERTEX_SERVICE_ACCOUNT_JSON_ENV]: JSON.stringify(account),
      },
      source: VERTEX_KEYCHAIN_SOURCE,
    };
  }
  // JSON 처럼 생겼는데 서비스 계정이 아니면 API 키로 보내지 않는다 — 키 자리에 JSON 이 나간다.
  if (value.startsWith("{")) return undefined;
  return { auth: { apiKey: value }, source: VERTEX_KEYCHAIN_SOURCE };
}

export function readVertexKeychainSecret({ spawnImpl, signal, account } = {}) {
  return readKeychainSecret({
    service: VERTEX_KEYCHAIN_SERVICE,
    ...(account ? { account } : {}),
    signal,
    ...(spawnImpl ? { spawnImpl } : {}),
  });
}

async function contextEnv(args, env, name) {
  const scoped = typeof args?.ctx?.env === "function" ? await args.ctx.env(name) : undefined;
  return scoped || env?.[name] || undefined;
}

/**
 * pinned google-vertex provider 에 Keychain fallback 을 덧댄다.
 *
 * 감싸는 것은 `auth.apiKey.resolve` 하나뿐이다. native 가 값을 주면 그대로 쓴다.
 */
export function withVertexKeychain(provider, options = {}) {
  const nativeApiKey = provider?.auth?.apiKey;
  if (!nativeApiKey || typeof nativeApiKey.resolve !== "function") {
    throw new Error("pinned googleVertexProvider has no auth.apiKey.resolve to extend");
  }
  const env = options.env ?? process.env;
  const keychainLookup = options.keychainLookup ?? readVertexKeychainSecret;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...nativeApiKey,
        resolve: async (args) => {
          const native = await nativeApiKey.resolve(args);
          if (native) return native;
          let secret;
          try {
            secret = await keychainLookup({
              signal: args?.signal,
              account: await contextEnv(args, env, VERTEX_KEYCHAIN_ACCOUNT_ENV),
              ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
            });
          } catch (error) {
            if (args?.signal?.aborted || isAbortError(error)) throw error;
            return undefined;
          }
          if (!secret) return undefined;
          return vertexAuthFromSecret(secret, { location: await contextEnv(args, env, "GOOGLE_CLOUD_LOCATION") });
        },
      },
    },
  };
}
