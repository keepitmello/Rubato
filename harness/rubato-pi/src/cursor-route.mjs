// native Cursor 직결 경로. catalog 공개를 활성화 canary 뒤로 미룬다.
//
// 이 파일이 소유하는 것은 하나다: **언제 Cursor 모델이 보이는가**. transport 는
// pinned `cursorProvider()` 가, stream 의미는 `rubato-stream.mjs` 가, 등록 순서는
// `provider-overlay.mjs` 가 각각 계속 소유한다.
//
// 왜 canary 가 필요한가. Cursor catalog 는 정적 baseline 이 없다 —
// `GetUsableModels` 가 계정별로 돌려주는 것이 전부다. 그래서 discovery 가 성공하는
// 것만으로는 "이 계정으로 실제 turn 을 돌릴 수 있다"를 뜻하지 않는다. discovery 는
// 별개 RPC 이고 pinned 구현은 실패를 `null` 로 접는다(`fetchCursorUsableModels` 의
// catch). 모델을 먼저 공개하면 사용자는 picker 에서 고를 수 있는 모델을 얻고, 첫
// 요청에서 auth/HTTP2 오류를 만난다 — 그 시점의 오류는 활성화 결정에서 멀어져 있다.
//
// Cursor 는 native HTTP/2 Connect `AgentService/Run` 한 경로뿐이다.
// HTTP/2 가 막히면 Cursor 는 없다.
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pinCursorGrokFastSelection } from "./cursor-grok-fast.mjs";
import { resolveCallIdentity } from "./speed-index-identity.mjs";
import { presentCursorPicker } from "./cursor-picker.mjs";
import { senpiNested } from "./engine-paths.mjs";

export const CURSOR_PROVIDER_ID = "cursor";

// ---------------------------------------------------------- activation marker
//
// 왜 marker 가 필요한가. pinned `ModelsImpl.refresh` 는 provider refresh 를 **두 번**
// 부른다(`models.js:83-95`):
//
//   1. `runProviderRefreshPhase(provider, storedCredential, /*allowNetwork*/ false, …)`
//   2. 자격증명을 해결한 뒤 `runProviderRefreshPhase(provider, credential, true, …)`
//
// 1번은 자격증명 해결 **전에**, 무조건 돈다. 그 phase 의 일은 저장분 복원이고,
// 그것을 그냥 통과시키면 저장된 Cursor catalog 가 canary 보다 먼저 공개된다 — 즉
// 부모 프로세스에서 gate 가 무의미해진다. 두 번째 세션부터는 항상 그 상태다.
//
// 그런데 offline phase 에서 canary 를 요구하면 안 된다. 격리 agent 는 부모가 고정한
// descriptor 를 `models.json` 에서 되살리는 경로이고(설계: 격리 agent 는
// `GetUsableModels` 를 다시 부르지 않는다), 거기서 Run 을 요구하면 격리 agent 마다
// vendor 호출이 하나 생긴다.
//
// 그래서 활성화 **증명**을 명시적 상태로 남긴다. 부모가 network canary 를 통과한
// 순간에만 발급하고, 자식은 그 marker 를 확인해서 offline 복원을 허용받는다.
//
// ## 신뢰 경계
//
// marker 는 profile 안의 파일이다. **자격증명 파일과 같은 신뢰 구역**이다 — 그 파일을
// 쓸 수 있는 주체는 `auth.json` 도 쓸 수 있으므로, marker 가 그보다 강한 보증을 줄
// 방법은 없다. 그래서 marker 가 막는 것은 침입자가 아니라 **정적 활성화**다: marker
// 하나가 "Cursor 는 이제 항상 켜짐"으로 굳는 것을 막는다.
//
// 그 목적을 위해 marker 는 두 축에 묶인다.
//
//   - **credential generation**: refresh token 의 salted digest. 다시 로그인하면
//     refresh token 이 바뀌므로 이전 marker 는 무효다. access token 이 아니라 refresh
//     token 을 쓰는 이유는 access 는 정상 refresh 로 계속 바뀌기 때문이다 — access 에
//     묶으면 token 갱신마다 marker 가 죽고, 그것은 격리 agent 를 canary 로 밀어낸다.
//   - **catalog generation**: 공개할 모델 목록의 digest. 저장분이 바뀌었으면(다른 계정,
//     손으로 편집, 다른 도구가 덮음) 그 목록은 canary 가 증명한 그 목록이 아니다.
//
// digest 는 salted SHA-256 이다. marker 에 token 값을 적지 않는다. 그리고 판정은 전부
// **fail closed** 다: 파일이 없거나, 파싱이 안 되거나, version 이 다르거나, 필드가
// 빠졌거나, 어느 축이든 어긋나면 marker 는 없는 것으로 본다.

export const CURSOR_ACTIVATION_MARKER_VERSION = 1;
export const CURSOR_ACTIVATION_MARKER_FILE = "cursor-activation.json";

/**
 * marker 유효기간. 신선도 상한일 뿐이고 보안 경계가 아니다.
 *
 * 무한으로 두면 marker 는 사실상 정적 활성화가 된다 — 한 번 통과한 프로필이 영원히
 * 통과한다. 유한하게 두면 부모의 다음 network refresh 가 다시 증명한다. 짧게 두면
 * 격리 agent 가 자주 모델을 잃으므로, 로그인 수명 정도로 넉넉히 잡는다.
 */
export const CURSOR_ACTIVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** marker 가 거절된 사유. 어휘만 남긴다 — 값은 절대 싣지 않는다. */
export const CURSOR_ACTIVATION_REJECTIONS = Object.freeze([
  "malformed_transitions",
  "malformed_history_boundary",
  "absent",
  "unreadable",
  "malformed",
  "version_mismatch",
  "provider_mismatch",
  "expired",
  "credential_generation_mismatch",
  "catalog_generation_mismatch",
]);

const AGENT_DIR_ENV_NAMES = Object.freeze([
  "RUBATO_PI_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
]);

/**
 * marker 경로. 자격증명과 **같은** agent 디렉터리에 둔다.
 *
 * `credential-import.mjs` 의 해결 순서를 여기서 다시 적는 이유는 순환 import 다
 * (credential-import → provider-direct → cursor-route). 규칙은 같다: 명시 override,
 * 그다음 `*_CODING_AGENT_DIR`, 그다음 브랜드 profile 기본값.
 */
export function cursorActivationMarkerPath(env = process.env, home = homedir()) {
  const explicit = env?.RUBATO_CURSOR_ACTIVATION_PATH;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  for (const name of AGENT_DIR_ENV_NAMES) {
    const value = env?.[name];
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 0) {
      const dir = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
      return join(dir, CURSOR_ACTIVATION_MARKER_FILE);
    }
    return join(home, ".rubato-pi", "agent", CURSOR_ACTIVATION_MARKER_FILE);
  }
  return join(home, ".rubato-pi", "agent", CURSOR_ACTIVATION_MARKER_FILE);
}

function digest(salt, material) {
  return createHash("sha256").update(salt).update("\u0000").update(material).digest("hex");
}

/**
 * 자격증명 세대. **refresh token** 에서 파생한다(api_key 는 key).
 *
 * 이유는 위 주석에 있다: access token 은 정상 갱신으로 바뀌므로 세대 축이 될 수 없다.
 * 값 자체는 저장하지 않는다.
 */
export function cursorCredentialGeneration(credential, salt) {
  if (!credential) return undefined;
  const material = credential.type === "oauth" ? credential.refresh : credential.key;
  if (typeof material !== "string" || material.length === 0) return undefined;
  return digest(salt, material);
}

/**
 * catalog 세대. 공개할 모델 id 집합에서 파생한다.
 *
 * 순서에 의존하지 않는다 — 같은 계정의 같은 목록이 다른 순서로 저장돼도 같은 세대다.
 * 모델 개수는 계정·시점마다 다르므로 고정하지 않고, 목록 자체를 세대로 쓴다.
 */
export function cursorCatalogGeneration(models, salt) {
  const ids = (Array.isArray(models) ? models : [])
    .map((model) => model?.id)
    .filter((id) => typeof id === "string" && id.length > 0)
    .sort();
  if (ids.length === 0) return undefined;
  return digest(salt, ids.join("\u0000"));
}

/** 파일 기반 marker store. temp write → rename 으로 반쯤 쓰인 marker 를 남기지 않는다. */
export function fileActivationMarkerStore(path) {
  return {
    path,
    read() {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return undefined;
      }
    },
    write(text) {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, text, { encoding: "utf-8", mode: 0o600 });
        renameSync(temp, path);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}

/**
 * marker 를 판정한다. 통과하면 `{ok:true}`, 아니면 `{ok:false, reason}`.
 *
 * 전부 fail closed 다. 판정에 쓰는 것은 marker 안의 salt 와 **지금** 손에 있는
 * credential/catalog 뿐이다 — marker 가 자기 정당성을 스스로 주장하지 못한다.
 *
 * 옛 이중 경로 필드는 읽되 그것으로 경로를 고르지 않는다. native 가 아닌
 * marker 는 복원 증명이 아니므로 거절한다.
 */
export function verifyCursorActivationMarker({ marker, credential, models, now = Date.now(), ttlMs = CURSOR_ACTIVATION_TTL_MS }) {
  if (marker === undefined || marker === null || marker === "") return { ok: false, reason: "absent" };
  let parsed;
  try {
    parsed = typeof marker === "string" ? JSON.parse(marker) : marker;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
  if (parsed.version !== CURSOR_ACTIVATION_MARKER_VERSION) return { ok: false, reason: "version_mismatch" };
  if (parsed.provider !== CURSOR_PROVIDER_ID) return { ok: false, reason: "provider_mismatch" };
  const { salt, credentialGeneration, catalogGeneration, issuedAt } = parsed;
  if (typeof salt !== "string" || salt.length === 0) return { ok: false, reason: "malformed" };
  if (typeof credentialGeneration !== "string" || typeof catalogGeneration !== "string") return { ok: false, reason: "malformed" };
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) return { ok: false, reason: "malformed" };
  // 미래에 발급된 marker 도 신선하지 않다. 시계가 뒤로 간 프로필에서 marker 가
  // 영원히 유효해지는 경로를 막는다.
  if (issuedAt > now || now - issuedAt > ttlMs) return { ok: false, reason: "expired" };
  if (cursorCredentialGeneration(credential, salt) !== credentialGeneration) {
    return { ok: false, reason: "credential_generation_mismatch" };
  }
  if (cursorCatalogGeneration(models, salt) !== catalogGeneration) {
    return { ok: false, reason: "catalog_generation_mismatch" };
  }
  if (parsed.historyTruncatedBefore !== undefined) {
    const value = parsed.historyTruncatedBefore;
    if (typeof value !== "number" || !Number.isFinite(value) || value > issuedAt) {
      return { ok: false, reason: "malformed_history_boundary" };
    }
  }
  if (parsed.transitions !== undefined) {
    if (!Array.isArray(parsed.transitions)) return { ok: false, reason: "malformed_transitions" };
    for (const entry of parsed.transitions) {
      if (!entry || typeof entry !== "object") return { ok: false, reason: "malformed_transitions" };
      if (typeof entry.at !== "number" || !Number.isFinite(entry.at) || entry.at > issuedAt) {
        return { ok: false, reason: "malformed_transitions" };
      }
      if (entry.route !== "native" && entry.route !== "fallback") return { ok: false, reason: "malformed_transitions" };
    }
  }
  const lastTransition = Array.isArray(parsed.transitions) ? parsed.transitions.at(-1)?.route : undefined;
  if (parsed.route === "fallback" || lastTransition === "fallback") {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, issuedAt, route: "native" };
}

/** canary 를 통과한 순간 발급한다. salt 는 marker 마다 새로 만든다. */
export function issueCursorActivationMarker({ credential, models, now = Date.now(), salt = randomBytes(16).toString("hex") }) {
  const credentialGeneration = cursorCredentialGeneration(credential, salt);
  const catalogGeneration = cursorCatalogGeneration(models, salt);
  if (!credentialGeneration || !catalogGeneration) return undefined;
  return {
    version: CURSOR_ACTIVATION_MARKER_VERSION,
    provider: CURSOR_PROVIDER_ID,
    issuedAt: now,
    salt,
    credentialGeneration,
    catalogGeneration,
    route: "native",
    // 감사용. 개수는 계약이 아니다(계정·시점마다 다르다) — 판정은 catalogGeneration 이 한다.
    modelCount: models.length,
  };
}


/** canary 세션 id 접두. 사용자 세션과 절대 겹치지 않아야 한다 — checkpoint 를 오염시킨다. */
export const CURSOR_CANARY_SESSION_PREFIX = "rubato-cursor-canary-";

/**
 * 종료 종류 중 transport/protocol 후보. vendor patch 의 typed
 * discriminator 어휘를 그대로 쓴다 — 여기서 문자열을 다시 정의하면 두 어휘가 갈린다.
 *
 * 어느 것도 다른 경로로 보내지 않는다. 판정만 남긴다.
 */
export const CURSOR_FALLBACK_ELIGIBLE_KINDS = Object.freeze(["transport", "protocol"]);

/** canary 가 fail closed 하는 사유. 값이 아니라 어휘다 — 오류 메시지에 자격증명이 실리지 않는다. */
export const CURSOR_CANARY_FAILURES = Object.freeze([
  "no_credential",
  "no_trusted_catalog",
  "auth",
  "oauth",
  "cancelled",
  "content",
  "transport",
  "protocol",
  "unknown",
]);

export const CURSOR_HTTP2_REQUIRED_MESSAGE =
  "Cursor requires HTTP/2 to api2.cursor.sh; there is no proxy fallback.";

/** pinned vendor 가 오류 객체에 붙이는 kind. enumerable 이 아니라서 JSON 으로 새지 않는다. */
const kCursorFailureKind = Symbol.for("pi-ai.cursor.failureKind");

function cursorFailureKind(value) {
  const tagged = value?.[kCursorFailureKind];
  if (typeof tagged === "string" && CURSOR_CANARY_FAILURES.includes(tagged)) return tagged;
  const kind = value?.cursorFailure?.kind;
  return typeof kind === "string" && CURSOR_CANARY_FAILURES.includes(kind) ? kind : undefined;
}

function cursorFailureText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value?.errorMessage === "string") return value.errorMessage;
  if (typeof value?.message === "string") return value.message;
  return "";
}

/**
 * HTTP/2 협상 실패인가. 문자열 매칭만으로 고르지 않는다 — vendor 가 transport 로
 * 태그한 종료와, 태그 없는 ALPN/`ERR_HTTP2` 오류를 같이 본다.
 */
export function isCursorHttp2Failure(value) {
  const text = cursorFailureText(value);
  const code = value?.code ?? value?.cause?.code;
  if (code === "ERR_HTTP2_ERROR" || code === "ERR_HTTP2_SESSION_ERROR") return true;
  if (/could not negotiate HTTP\/2/i.test(text)) return true;
  return cursorFailureKind(value) === "transport" && /HTTP\/2|h2 is not supported|ERR_HTTP2/i.test(text);
}

export function rewriteCursorHttp2Error(error) {
  if (!isCursorHttp2Failure(error)) return error;
  if (error instanceof Error) {
    error.message = CURSOR_HTTP2_REQUIRED_MESSAGE;
    return error;
  }
  return new Error(CURSOR_HTTP2_REQUIRED_MESSAGE);
}

export class CursorCanaryError extends Error {
  constructor(reason, { fallbackEligible = false, cause } = {}) {
    const message = isCursorHttp2Failure(cause)
      ? CURSOR_HTTP2_REQUIRED_MESSAGE
      : `cursor activation canary failed (${reason})`;
    super(message);
    this.name = "CursorCanaryError";
    this.reason = isCursorHttp2Failure(cause) ? "transport" : reason;
    this.fallbackEligible = fallbackEligible;
  }
}

export function cursorCanarySessionId(id = randomUUID()) {
  return `${CURSOR_CANARY_SESSION_PREFIX}${id}`;
}

function isCanarySessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith(CURSOR_CANARY_SESSION_PREFIX);
}

/** oauth 는 access, api_key 는 key. pinned `fetchCursorModels` 와 같은 판정이다. */
export function cursorAccessToken(credential) {
  if (!credential) return undefined;
  return credential.type === "oauth" ? credential.access : credential.key;
}

/**
 * terminal stream 에서 typed 종료 종류를 읽는다.
 *
 * 문자열 매칭을 하지 않는다. canonical vendor patch 가 `output.cursorFailure` 를
 * 구조로 붙인다(`{kind, fallbackEligible}`). 그 필드가 없는 종료는 `unknown` 이다.
 */
export function cursorTerminalFailure(output) {
  const kind = cursorFailureKind(output)
    ?? (typeof output?.cursorFailure?.kind === "string" && CURSOR_CANARY_FAILURES.includes(output.cursorFailure.kind)
      ? output.cursorFailure.kind
      : undefined);
  if (kind) return { kind, fallbackEligible: CURSOR_FALLBACK_ELIGIBLE_KINDS.includes(kind) };
  if (isCursorHttp2Failure(output)) return { kind: "transport", fallbackEligible: true };
  return { kind: "unknown", fallbackEligible: false };
}

function rewriteCursorHttp2Message(message) {
  if (!message || typeof message !== "object") return message;
  if (!isCursorHttp2Failure(message) && !isCursorHttp2Failure({ errorMessage: message.errorMessage, cursorFailure: message.cursorFailure })) {
    return message;
  }
  message.errorMessage = CURSOR_HTTP2_REQUIRED_MESSAGE;
  return message;
}

function wrapCursorHttp2Stream(inner) {
  if (!inner || typeof inner !== "object") return inner;
  const rewriteEvent = (event) => {
    if (event?.type === "error" && event.error) {
      if (event.error instanceof Error) event.error = rewriteCursorHttp2Error(event.error);
      else rewriteCursorHttp2Message(event.error);
    }
    return event;
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === Symbol.asyncIterator) {
        return () => {
          const iterator = target[Symbol.asyncIterator]();
          return {
            next: async () => {
              const step = await iterator.next();
              if (!step.done) rewriteEvent(step.value);
              return step;
            },
            return: iterator.return ? (value) => iterator.return(value) : undefined,
            throw: iterator.throw ? (error) => iterator.throw(error) : undefined,
          };
        };
      }
      if (property === "result") {
        return () => Promise.resolve(target.result()).then((message) => rewriteCursorHttp2Message(message));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapCursorHttp2Fn(inner, getCatalog) {
  if (typeof inner !== "function") return inner;
  return (model, context, options) => {
    // --model / 세션 복원은 getModels() 저장분을 쓴다. Fast map 은 filterModels
    // 피커 객체에만 있으므로, 저장 catalog 에서 variant 를 다시 본다.
    const catalog = typeof getCatalog === "function" ? getCatalog() : undefined;
    const pinned = pinCursorGrokFastSelection(model, options, catalog);
    const identity = resolveCallIdentity(pinned.model, pinned.options);
    try { pinned.options?.onResolvedCall?.(identity); } catch {}
    try {
      return wrapCursorHttp2Stream(inner(pinned.model, context, pinned.options));
    } catch (error) {
      throw rewriteCursorHttp2Error(error);
    }
  };
}

/**
 * 실제 Run seam 을 한 번 돌려 turn 이 성립하는지 본다.
 *
 * 기본 구현은 provider 의 `streamSimple` 이다 — 세션이 쓰는 그 축이다. 테스트는
 * `run` 을 주입해 offline 으로 돌린다. 여기서 별도 transport 를 만들지 않는다:
 * 만들면 canary 가 통과해도 세션 경로가 통과한다는 뜻이 아니게 된다.
 */
async function defaultCursorRun({ provider, model, credential, sessionId, signal }) {
  const stream = provider.streamSimple(
    model,
    { messages: [{ role: "user", content: "ping" }] },
    {
      apiKey: cursorAccessToken(credential),
      sessionId,
      // 세션 경로와 같은 identity 를 준다. pinned sanitizeCursorCallerHeaders 가
      // 이 header 를 보존하므로 wire 까지 간다.
      headers: { "x-session-id": sessionId },
      signal,
    },
  );
  return await stream.result();
}

/**
 * canary 한 번. 성공이면 `{ok:true}`, 실패면 `CursorCanaryError` 를 던진다.
 *
 * 모델은 discovery 결과에서 고른다. 정적 후보를 두지 않는다 — 계정에 없는 모델을
 * canary 로 쓰면 계정 문제와 모델 문제를 구분할 수 없다.
 */
export async function runCursorCanary({ provider, models, credential, run = defaultCursorRun, signal, sessionId = cursorCanarySessionId() }) {
  if (!cursorAccessToken(credential)) throw new CursorCanaryError("no_credential");
  if (!Array.isArray(models) || models.length === 0) throw new CursorCanaryError("no_trusted_catalog");
  if (!isCanarySessionId(sessionId)) throw new CursorCanaryError("unknown");

  const model = models[0];
  let output;
  try {
    output = await run({ provider, model, credential, sessionId, signal });
  } catch (error) {
    // 던져진 오류에도 같은 판정을 적용한다. transport 예외가 여기로 나오는 경로가 있다.
    const rewritten = rewriteCursorHttp2Error(error);
    const { kind, fallbackEligible } = cursorTerminalFailure(rewritten);
    throw new CursorCanaryError(kind, { fallbackEligible, cause: rewritten });
  }
  if (output?.stopReason === "aborted") throw new CursorCanaryError("cancelled");
  if (output?.stopReason === "error" || output?.errorMessage) {
    rewriteCursorHttp2Message(output);
    const { kind, fallbackEligible } = cursorTerminalFailure(output);
    throw new CursorCanaryError(kind, { fallbackEligible, cause: output });
  }
  return { ok: true, modelId: model.id, sessionId };
}

/**
 * `refreshModels` 를 감싸 공개를 활성화 증명 뒤로 미룬다.
 *
 * pinned `ModelsImpl.refresh` 는 provider 당 refresh 를 **두 번** 부른다
 * (`models.js:83-95`): 자격증명 해결 **전의** `allowNetwork:false` 복원 phase, 그리고
 * `allowNetwork:true` 발견 phase. network phase 만 gate 하면 저장분이 canary 보다 먼저
 * 공개되어, 두 번째 세션부터 gate 가 무의미해진다. 그래서 **두 phase 를 다 가로막는다.**
 *
 *   - offline phase: 공개를 버퍼에 담고, 상속된 marker 가 **지금의** credential 과
 *     **지금의** 저장 catalog 에 동시에 묶여 있을 때만 흘린다. 아니면 아무것도 공개하지
 *     않고 조용히 끝낸다 — 여기서 던지면 pinned refresh 의 operation 이 죽어 network
 *     phase 가 아예 오지 않고, 그러면 부모는 영원히 활성화할 수 없다.
 *   - network phase: 발견을 버퍼에 담고 canary 를 한 번 돌린다. 통과하면 marker 를
 *     발급하고 공개한다. 실패하면 던진다 — 사용자가 활성화를 직접 시도한 경로라 실패는
 *     보여야 하고, pinned refresh 가 그것을 errors map 에 담는다.
 *
 * canary 는 provider 당 single-flight 다. 같은 프로세스에서 refresh 가 겹쳐도 Run 은
 * 한 번만 나간다.
 */
export function withCursorActivationCanary(provider, {
  run,
  sessionIdFactory = cursorCanarySessionId,
  onDecision,
  env = process.env,
  markerStore,
  now = Date.now,
  ttlMs = CURSOR_ACTIVATION_TTL_MS,
  // Senpi `/login` 직후 동기화와 `--print` 부팅은 allowNetwork:false 다.
  // refresh token 이 바뀌거나 저장 catalog 가 마지막 증명과 어긋나면 옛 marker 는
  // 죽고, 오프라인 복원은 모델을 숨긴 채 끝난다. `--print --model cursor/…` 는
  // 그 다음 network phase 가 없어서 Cursor 가 빈 채로 죽는다. 부모 세션만 그
  // 자리에서 canary 를 다시 돌린다 — 격리 자식이 각자 Run 하면 안 된다.
  reactivateOnCredentialRotation = false,
} = {}) {
  const nativeRefresh = provider.refreshModels;
  if (typeof nativeRefresh !== "function") throw new Error("pinned cursorProvider has no refreshModels to gate");
  const store = markerStore ?? fileActivationMarkerStore(cursorActivationMarkerPath(env));
  let inflight = null;

  const gate = ({ models, credential, signal }) => {
    // single-flight: 동시에 겹친 호출만 공유한다. settle 뒤에도 남겨 두면 재로그인
    // 오프라인 동기화가 옛 성공 Promise 를 재사용해 새 자격증명을 검증하지 않는다.
    inflight ??= runCursorCanary({ provider, models, credential, run, signal, sessionId: sessionIdFactory() })
      .then(
        (result) => {
          onDecision?.({ ok: true, phase: "activate", route: "native", ...result });
          return { ...result, route: "native" };
        },
        (error) => {
          const reason = error?.reason ?? "unknown";
          const eligible = error?.fallbackEligible === true;
          onDecision?.({ ok: false, phase: "activate", route: "native", reason, fallbackEligible: eligible });
          throw error;
        },
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  /** 이 refresh 가 보는 Cursor 저장분. catalog 세대 판정의 근거다. */
  const storedCursorModels = (context) =>
    (Array.isArray(context.stored?.models) ? context.stored.models : []).filter(
      (model) => model?.provider === CURSOR_PROVIDER_ID,
    );

  /** native refresh 를 돌리되 publish 를 버퍼로 돌린다. 두 phase 가 같은 방식으로 막힌다. */
  const buffered = async (context) => {
    const publications = [];
    let discovered = [];
    await nativeRefresh({
      ...context,
      publish: async (publication) => {
        publications.push(publication);
        // 아직 공개하지 않는다. 그런데 `true` 를 돌려준다 — pinned refreshModels 는
        // `false` 를 "generation 이 바뀌었다"로 읽고 **discovery 자체를 건너뛴다**.
        // 여기서 false 를 주면 canary 가 볼 catalog 가 아예 생기지 않는다.
        const models = publication.persist?.models;
        if (Array.isArray(models) && models.length > 0) discovered = models;
        return true;
      },
    });
    return { publications, discovered };
  };

  const release = async (context, publications) => {
    for (const publication of publications) {
      if (!(await context.publish(publication))) return false;
    }
    return true;
  };

  return {
    ...provider,
    refreshModels: async (context) => {
      const { publications, discovered } = await buffered(context);
      if (publications.length === 0) return;

      if (!context.allowNetwork) {
        const verdict = verifyCursorActivationMarker({
          marker: store.read(),
          credential: context.credential,
          models: storedCursorModels(context),
          now: now(),
          ttlMs,
        });
        if (!verdict.ok) {
          const stored = storedCursorModels(context);
          if (
            reactivateOnCredentialRotation &&
            (verdict.reason === "credential_generation_mismatch" ||
              verdict.reason === "catalog_generation_mismatch" ||
              verdict.reason === "expired") &&
            stored.length > 0 &&
            cursorAccessToken(context.credential)
          ) {
            await gate({ models: stored, credential: context.credential, signal: context.signal });
            const rotated = issueCursorActivationMarker({
              credential: context.credential,
              models: stored,
              now: now(),
            });
            if (rotated) {
              try {
                store.write(`${JSON.stringify(rotated)}\n`);
              } catch {
                onDecision?.({ ok: false, phase: "persist_marker", reason: "write_failed", fallbackEligible: false });
              }
            }
            await release(context, publications);
            return;
          }
          onDecision?.({
            ok: false,
            phase: "restore",
            reason: verdict.reason,
            conservativeBoundary: true,
            fallbackEligible: false,
          });
          return;
        }
        onDecision?.({ ok: true, phase: "restore", inherited: true, route: "native" });
        await release(context, publications);
        return;
      }

      // discovery 가 없으면(복원분 publish 만 있었다) 저장분을 canary 근거로 쓴다.
      // pinned 복원 publication 에는 `persist` 가 없으므로 목록은 `context.stored` 에서 읽는다.
      const models = discovered.length > 0 ? discovered : storedCursorModels(context);
      await gate({ models, credential: context.credential, signal: context.signal });
      const marker = issueCursorActivationMarker({
        credential: context.credential,
        models,
        now: now(),
      });
      if (marker) {
        try {
          store.write(`${JSON.stringify(marker)}\n`);
        } catch {
          // canary 는 이 프로세스에서 이미 통과했다. 자식이 복원하지 못한다는 것만
          // 알리고 이번 공개는 막지 않는다.
          onDecision?.({ ok: false, phase: "persist_marker", reason: "write_failed", fallbackEligible: false });
        }
      }
      await release(context, publications);
    },
  };
}

/** pinned factory 를 그 자리에서 불러온다. 정적 Cursor 모델을 만들지 않는다. */
export async function loadPinnedCursorProvider() {
  const module = await import(
    pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/cursor.js")).href
  );
  if (typeof module.cursorProvider !== "function") throw new Error("pinned pi-ai has no cursorProvider in providers/cursor.js");
  return module.cursorProvider();
}

function withCursorHttp2Errors(provider) {
  const catalog = () => (typeof provider.getModels === "function" ? provider.getModels() : []);
  const wrapPair = (source) => ({
    ...(typeof source?.stream === "function" ? { stream: wrapCursorHttp2Fn(source.stream, catalog) } : {}),
    ...(typeof source?.streamSimple === "function" ? { streamSimple: wrapCursorHttp2Fn(source.streamSimple, catalog) } : {}),
  });
  const top = wrapPair(provider);
  const api = provider.api ? { ...provider.api, ...wrapPair(provider.api) } : provider.api;
  return {
    ...provider,
    ...top,
    ...(api ? { api } : {}),
  };
}

function withCursorPickerPresentation(provider) {
  const nativeFilter = provider.filterModels;
  return {
    ...provider,
    filterModels: (models, credential) =>
      presentCursorPicker(nativeFilter ? nativeFilter(models, credential) : models),
  };
}

/**
 * 직결에 등록할 Cursor provider. pinned provider + canary gate 뿐이다.
 *
 * `restoreModels`, `auth.oauth`, `api`(cursor-agent), `baseUrl`, exec 의미는 전부
 * pinned 그대로 남는다. 모델 정의는 만들지 않는다 — 공개 시점만 바꾸고, 피커에는
 * 쓰던 일곱과 Grok 4.6 Fast 정체성만 보여 준다.
 */
export async function cursorDirectProvider(options = {}) {
  const native = options.provider ?? (await loadPinnedCursorProvider());
  return withCursorPickerPresentation(withCursorActivationCanary(withCursorHttp2Errors(native), options));
}

/** Post-pin identity the outer stream records. Tests pin through this helper. */
export function resolvedCursorCallIdentity(model, options = {}, catalog) {
  const pinned = pinCursorGrokFastSelection(model, options, catalog);
  return {
    pinned,
    identity: resolveCallIdentity(pinned.model, pinned.options),
  };
}
