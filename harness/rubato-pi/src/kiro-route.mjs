// Kiro 직결 provider. bridge 의 `kiroProvider()` 정의를 in-process 로 옮긴 것이다.
//
// Kiro 구독은 `kiro.rs` 사이드카가 Anthropic Messages 로 번역해 준다. 그래서 새
// transport 를 짜지 않고 **pinned `anthropicMessagesApi()`** 를 loopback 에 붙인다.
// text/image/tool/tool-result/reasoning/usage/abort 의미는 전부 그 pin 이 소유한다 —
// bridge 시절의 FX 변환(`fxPromptToPiContext`)은 이 경로에 없다.
//
// provider 를 새로 만드는 이유는 bridge 주석에 있던 그대로다: 모델 spec 이 자기
// `provider`/`baseUrl` 을 들고 있어서, `anthropicProvider()` 를 spread 로 덮으면 그
// 안의 모델이 여전히 `anthropic` 을 가리켜 "Unknown provider" 로 죽는다.
//
// Claude Code tool-name mapping 은 붙이지 않는다. 사이드카 key 는 `sk-ant-oat` 가
// 아니므로 pinned 판정이 OAuth 경로를 고르지 않고(`api/anthropic-messages.js:1396`),
// 따라서 `toClaudeCodeName` 도 걸리지 않는다. 그것이 옳다 — 상대는 AWS Kiro 다.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { senpiNested } from "./engine-paths.mjs";

export const KIRO_PROVIDER_ID = "kiro";

/**
 * 사이드카 주소. `kiro-setup.sh` 가 `-p 127.0.0.1:8990:8990` 으로 loopback 에만 노출한다.
 */
export const DEFAULT_KIRO_BASE_URL = "http://127.0.0.1:8990";

/** 설정 권위는 `kiro-setup.sh` 다. 그 스크립트가 쓰는 이름을 그대로 읽는다. */
export const KIRO_API_KEY_ENV = "KIRO_API_KEY";
export const KIRO_BASE_URL_ENV = "KIRO_BASE_URL";
export const KIRO_CONFIG_PATH_ENV = "KIRO_CONFIG_PATH";

/** 삭제된 FX bridge 와 그 shadow. 사이드카 주소가 여기를 가리키는 것은 언제나 잘못이다. */
const LEGACY_BRIDGE_PORTS = new Set(["8788", "18788"]);

export const DEFAULT_KIRO_SETUP_PATH = fileURLToPath(new URL("../../scripts/kiro-setup.sh", import.meta.url));

let kiroEnsure;

export function kiroEnsureEnabled(env = process.env) {
  return !env?.RUBATO_NO_KIRO_ENSURE;
}

/**
 * Kiro 첫 호출 직전에 Docker/사이드카를 복원한다. 세션 시작이 아니라 이 자리가
 * 계약이다 — Codex/xAI 세션이 Docker 를 깨우면 안 된다.
 *
 * 동시에 들어온 요청은 한 번의 ensure 를 공유한다. 끝나면 비워서 다음 호출이
 * 죽은 사이드카를 다시 볼 수 있게 한다.
 */
export function ensureKiroSidecar(env = process.env, { spawnImpl = spawn, setupPath } = {}) {
  if (!kiroEnsureEnabled(env)) return Promise.resolve();
  if (kiroEnsure) return kiroEnsure;
  kiroEnsure = new Promise((resolve, reject) => {
    const child = spawnImpl(setupPath ?? env.KIRO_SETUP_PATH ?? DEFAULT_KIRO_SETUP_PATH, ["ensure"], {
      env: {
        ...env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${env.PATH ?? "/usr/bin:/bin"}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `kiro sidecar startup failed with exit ${code}`));
    });
  }).finally(() => {
    kiroEnsure = undefined;
  });
  return kiroEnsure;
}

function wrapStreamWithEnsure(fn, ensure) {
  return (model, context, options) => {
    const ready = Promise.resolve().then(ensure).then(() => fn(model, context, options));
    return {
      [Symbol.asyncIterator]() {
        let iterator;
        return {
          async next() {
            if (!iterator) iterator = (await ready)[Symbol.asyncIterator]();
            return iterator.next();
          },
          async return(value) {
            if (!iterator) iterator = (await ready)[Symbol.asyncIterator]();
            return iterator.return ? iterator.return(value) : { value, done: true };
          },
          async throw(error) {
            if (!iterator) iterator = (await ready)[Symbol.asyncIterator]();
            return iterator.throw ? iterator.throw(error) : Promise.reject(error);
          },
        };
      },
      result() {
        return ready.then((stream) => (typeof stream.result === "function" ? stream.result() : undefined));
      },
    };
  };
}

/**
 * stream 면에만 ensure 를 건다. getModels / auth resolve 는 사이드카를 깨우지 않는다.
 */
export function withKiroSidecarEnsure(provider, ensure) {
  const wrapPair = (source) => ({
    ...(typeof source?.stream === "function" ? { stream: wrapStreamWithEnsure(source.stream.bind(source), ensure) } : {}),
    ...(typeof source?.streamSimple === "function"
      ? { streamSimple: wrapStreamWithEnsure(source.streamSimple.bind(source), ensure) }
      : {}),
  });
  const top = wrapPair(provider);
  const nested = provider?.api ? wrapPair(provider.api) : undefined;
  return {
    ...provider,
    ...top,
    ...(nested ? { api: { ...provider.api, ...nested } } : {}),
  };
}

export function defaultKiroConfigPath(home = homedir()) {
  return join(home, ".rubato-pi", "kiro", "config.json");
}

export function kiroConfigPath(env = process.env, home = homedir()) {
  const explicit = env?.[KIRO_CONFIG_PATH_ENV];
  return typeof explicit === "string" && explicit.length > 0 ? explicit : defaultKiroConfigPath(home);
}

/**
 * loopback 인가. 사이드카는 이 기기의 컨테이너이고, 그 앞에 붙는 자격증명은 로컬
 * 전용 key 다. 원격 host 를 허용하면 그 key 가 네트워크로 나간다 — 설정 실수 하나가
 * 자격증명 유출이 된다. 그래서 주소는 **loopback 만** 받는다.
 */
export function isLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * 사이드카 주소를 정한다. loopback 이 아니면 **기본값으로 되돌리고** 사유를 알린다.
 *
 * 여기서 던지지 않는다. 던지면 Kiro 설정 오타 하나가 Codex·xAI·Cursor 까지 포함한
 * 세션 부팅 전체를 막는다. 값을 무시하고 기본값으로 가는 쪽이 안전하고, 무엇이
 * 무시됐는지는 경고 한 줄로 남는다(값은 싣지 않는다).
 */
export function kiroBaseUrl(env = process.env, { onReject } = {}) {
  const configured = env?.[KIRO_BASE_URL_ENV];
  if (typeof configured !== "string" || configured.length === 0) return DEFAULT_KIRO_BASE_URL;
  const trimmed = configured.replace(/\/$/, "");
  if (!isLoopbackUrl(trimmed)) {
    onReject?.({ reason: "not_loopback" });
    return DEFAULT_KIRO_BASE_URL;
  }
  // 삭제된 FX bridge 로 되돌아가는 문. loopback 이라는 이유로 통과시키면 사이드카 대신
  // legacy gateway 와 말하게 되고, 이 기기에서는 그 포트에 다른 세션들이 쓰는 공유 bridge 가
  // 살아 있다. 여기서도 던지지 않고 기본값으로 되돌린다 — 이유는 위와 같다.
  if (LEGACY_BRIDGE_PORTS.has(new URL(trimmed).port)) {
    onReject?.({ reason: "legacy_bridge_port" });
    return DEFAULT_KIRO_BASE_URL;
  }
  return trimmed;
}

/**
 * 사이드카 key 를 읽는다. **env 가 config 파일보다 먼저다.**
 *
 * 파일을 읽는 이유는 bridge 주석에 있던 그대로다: env 로만 받으면 셸마다 export 해야
 * 하고, 그러면 "내 기기에서만 도는 고침"이 된다. `kiro-setup.sh` 가 써 둔 config 를
 * 직접 읽어 한 번 설정하면 재기동 뒤에도 붙게 한다.
 *
 * 파일이 없거나 JSON 이 깨졌거나 `apiKey` 가 문자열이 아니면 **auth 만 비활성**이다.
 * 던지지 않는다 — Kiro 를 쓰지 않는 사용자의 세션에서 다른 provider 를 막지 않는다.
 *
 * 캐시하지 않는다. 파일 하나를 요청마다 읽는 비용은 loopback 왕복에 비해 무시할 수
 * 있고, 캐시하면 `kiro-setup.sh` 가 key 를 바꾼 뒤에도 옛 key 로 계속 붙는다.
 */
export function kiroApiKey(env = process.env, { readFileImpl = readFileSync, home = homedir() } = {}) {
  const fromEnv = env?.[KIRO_API_KEY_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { key: fromEnv, source: KIRO_API_KEY_ENV };
  }
  const path = kiroConfigPath(env, home);
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(path, "utf-8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const key = parsed.apiKey;
  return typeof key === "string" && key.length > 0 ? { key, source: "kiro config" } : undefined;
}

/**
 * Kiro 가 여는 모델 중 우리가 쓰는 둘.
 *
 * context window 는 `harness/bridge/src/direct-provider.ts` 기준선을 그대로 옮긴 값이다
 * (kiro.rs `converter.rs:315/323` 기준). 설계가 못 박은 대로 이 상한은 실제 상류 계약을
 * 확인하기 전까지 truncation 계산에 쓰지 않는다.
 *
 * 2026-08-28 실측: 사이드카는 usage 를 **퍼센트로 주지 않는다** — 절대 `input_tokens` 와
 * `credit_usage` float 를 돌려준다. 그래서 `pct × window / 100` 역산이 성립하지 않고, 이
 * 값들을 상류에서 확인하는 경로가 아직 없다. 따라서 이 상한은 picker 표시용이고
 * truncation·usage 역산에는 계속 쓰지 않는다.
 */
const KIRO_MODEL_BASELINE = Object.freeze([
  Object.freeze({ id: "claude-opus-5", name: "Opus 5 (Kiro)", contextWindow: 1_000_000 }),
  Object.freeze({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol (Kiro)", contextWindow: 272_000 }),
]);

const KIRO_MAX_TOKENS = 64_000;
const KIRO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function kiroModels(baseUrl) {
  return KIRO_MODEL_BASELINE.map((model) => ({
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
    provider: KIRO_PROVIDER_ID,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: model.contextWindow,
    maxTokens: KIRO_MAX_TOKENS,
    // 구독이므로 과금이 없다. 값을 비워 두면 pinned cost 계산이 `undefined` 를 곱한다.
    cost: { ...KIRO_COST },
    // temperature 는 상류가 받지 않고, tool schema 는 strict 여야 한다.
    compat: { supportsTemperature: false, supportsStrictTools: true },
  }));
}

/**
 * 사이드카 key auth. `x-api-key` 로 나간다 — loopback 이라 OAuth 흐름이 없다.
 *
 * `login` 은 실패시킨다. 이 자격증명은 우리가 만드는 것이 아니라 `kiro-setup.sh` 가
 * 만든다. 조용히 성공하는 login 을 두면 사용자는 붙었다고 믿고 첫 요청에서 401 을 본다.
 */
export function kiroApiKeyAuth({ env = process.env, readFileImpl, home } = {}) {
  return {
    name: "Kiro (kiro.rs local)",
    login: async () => {
      throw new Error("kiro 는 harness/scripts/kiro-setup.sh 로 설정한다");
    },
    resolve: async ({ credential, signal } = {}) => {
      signal?.throwIfAborted?.();
      // 저장된 자격증명이 있으면 그것이 먼저다. pinned api key auth 들과 같은 순서다.
      if (typeof credential?.key === "string" && credential.key.length > 0) {
        return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
      }
      const found = kiroApiKey(env, { ...(readFileImpl ? { readFileImpl } : {}), ...(home ? { home } : {}) });
      return found ? { auth: { apiKey: found.key }, source: found.source } : undefined;
    },
  };
}

async function loadPinned(file, exportName) {
  const module = await import(pathToFileURL(senpiNested(`@earendil-works/pi-ai/dist/${file}`)).href);
  const value = module[exportName];
  if (typeof value !== "function") throw new Error(`pinned pi-ai has no ${exportName} in ${file}`);
  return value;
}

/**
 * 직결에 등록할 Kiro provider. pinned `createProvider` + pinned `anthropicMessagesApi()` 다.
 *
 * module import 시점에는 사용자 설정을 **읽지 않는다**. 경로 결정과 파일 읽기는 이
 * 함수가 불릴 때(overlay 구성 시점)와 요청별 auth resolve 에서만 일어난다.
 */
export async function kiroDirectProvider({ env = process.env, readFileImpl, home, onReject, createProvider, anthropicMessagesApi } = {}) {
  const factory = createProvider ?? (await loadPinned("models.js", "createProvider"));
  const api = anthropicMessagesApi ?? (await loadPinned("api/anthropic-messages.lazy.js", "anthropicMessagesApi"));
  const baseUrl = kiroBaseUrl(env, { onReject });
  return factory({
    id: KIRO_PROVIDER_ID,
    name: "Kiro",
    baseUrl,
    auth: { apiKey: kiroApiKeyAuth({ env, readFileImpl, home }) },
    models: kiroModels(baseUrl),
    api: api(),
  });
}
