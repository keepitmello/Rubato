// 업스트림 HTTP 전용 undici Agent.
//
// Node 내장 fetch 는 유휴 연결을 오리진당 1개로 회수하고, 그 연결 안에서 요청을
// 한 줄로 세운다. 같은 프로세스에서 child/team 이 동시에 돌면 xAI 가 74~155s 로
// 늘어났던 그 병리다. 여기 Agent 는 오리진당 풀을 따로 잡고 HTTP/1.1 만 써서
// 한 소켓에 스트림이 몰리지 않게 한다.
//
// 주입 면은 pi-ai 의 `options.fetch` 하나다. Codex WebSocket 은 `ws` 패키지라
// 이 fetch 를 안 타고, Cursor 는 `node:http2` 라 역시 안 탄다.
import { Agent, fetch as undiciFetch } from "undici";

export const UPSTREAM_DISPATCHER_FLAG = "RUBATO_UPSTREAM_DISPATCHER";

/** 오리진별로 풀이 잡히므로 프로바이더끼리 연결을 안 뺏는다. */
export const UPSTREAM_CONNECTIONS = 16;
/**
 * 청크 사이 간격. 0 은 죽은 스트림을 영영 붙든다.
 *
 * 죽은 스트림을 더 빨리 끊으려고 낮추지 않는다. 이 Agent 는 fetch 를 쓰는 provider
 * 전부가 함께 쓰고, 성공한 스트림에서 잰 내용 간격이 이미 크다 — 2026-09-25
 * speed-index 실측(성공 약 5.2만 건): xAI 92.6s, cursor 42.7s, codex 30.0s,
 * Anthropic Opus 5.5 9.6s (첫 출력까지는 76.4s). ping 같은 비내용 바이트는
 * 재지 않았으므로 내용 간격이 바이트 간격의 상한일 뿐이고, 그 이상 근거가 없다.
 */
export const UPSTREAM_BODY_TIMEOUT_MS = 120_000;
export const UPSTREAM_HEADERS_TIMEOUT_MS = 600_000;
/**
 * IPv6/IPv4 happy-eyeballs 한 주소의 시도 기한. 엔진 dispatcher
 * (`pi-coding-agent/dist/core/http-dispatcher.js` 의 DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS)
 * 와 같은 값이다. 이 Agent 는 엔진 dispatcher 를 우회하므로 그 설정도 따라오지 않는다 —
 * 지정하지 않으면 Node 기본(250~500ms)이라 핫스팟처럼 지연이 큰 회선에서 멀쩡한
 * 연결 시도를 끊고 다음 주소로 넘어간다. api.anthropic.com 은 A 와 AAAA 가 둘 다 있다.
 */
export const UPSTREAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export function upstreamAgentOptions() {
  return {
    connections: UPSTREAM_CONNECTIONS,
    allowH2: false,
    bodyTimeout: UPSTREAM_BODY_TIMEOUT_MS,
    headersTimeout: UPSTREAM_HEADERS_TIMEOUT_MS,
    connect: {
      autoSelectFamilyAttemptTimeout: UPSTREAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    },
  };
}

function createAgent() {
  return new Agent(upstreamAgentOptions());
}

let agent;

function getAgent() {
  agent ??= createAgent();
  return agent;
}

export function upstreamDispatcherEnabled(env = process.env) {
  return env?.[UPSTREAM_DISPATCHER_FLAG] !== "0";
}

function isUrlInput(input) {
  return typeof input === "string" || input instanceof URL;
}

function bodyNeedsDuplex(body) {
  return body != null
    && typeof body === "object"
    && (typeof body.getReader === "function" || typeof body.pipe === "function");
}

/**
 * undici 8 은 다른 realm 의 `Request` 를 URL 로 파싱하지 못한다. string/URL 이
 * 아니면 `input.url` 과 method/headers/body/signal 을 init 으로 옮긴다. 호출자가
 * 준 init 필드가 Request 에서 파생한 값보다 이긴다.
 */
function adaptFetchArgs(input, init) {
  const derived = isUrlInput(input)
    ? {}
    : {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal,
    };
  const next = { ...derived, ...init };
  if (next.duplex === undefined && bodyNeedsDuplex(next.body)) next.duplex = "half";
  return [isUrlInput(input) ? input : input.url, next];
}

/**
 * undici fetch 를 이 프로세스 Agent 에 묶는다.
 *
 * @param {import("undici").Dispatcher} [dispatcher]
 */
export function bindUpstreamFetch(dispatcher) {
  return function upstreamFetch(input, init) {
    const [url, adapted] = adaptFetchArgs(input, init);
    return undiciFetch(url, { ...adapted, dispatcher: dispatcher ?? getAgent() });
  };
}

export const upstreamFetch = bindUpstreamFetch();

/** 꺼져 있으면 undefined — 호출자가 fetch 를 안 준 것과 같다. */
export function resolveUpstreamFetch(env = process.env) {
  return upstreamDispatcherEnabled(env) ? upstreamFetch : undefined;
}

/** 싱글턴 Agent 를 닫고 다음 fetch 가 새 풀을 만들게 한다. 호출 연결은 없다. */
export function closeUpstreamAgent() {
  const current = agent;
  agent = undefined;
  return current?.close();
}
