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
/** 청크 사이 간격. 0 은 죽은 스트림을 영영 붙든다. */
export const UPSTREAM_BODY_TIMEOUT_MS = 120_000;
export const UPSTREAM_HEADERS_TIMEOUT_MS = 600_000;

function createAgent() {
  return new Agent({
    connections: UPSTREAM_CONNECTIONS,
    allowH2: false,
    bodyTimeout: UPSTREAM_BODY_TIMEOUT_MS,
    headersTimeout: UPSTREAM_HEADERS_TIMEOUT_MS,
  });
}

let agent;

function getAgent() {
  agent ??= createAgent();
  return agent;
}

export function upstreamDispatcherEnabled(env = process.env) {
  return env?.[UPSTREAM_DISPATCHER_FLAG] !== "0";
}

/**
 * undici fetch 를 이 프로세스 Agent 에 묶는다. `Request` 입력도 init.dispatcher 로
 * 탄다 — 본문을 다시 읽지 않는다.
 *
 * @param {import("undici").Dispatcher} [dispatcher]
 */
export function bindUpstreamFetch(dispatcher = getAgent()) {
  return function upstreamFetch(input, init) {
    return undiciFetch(input, { ...init, dispatcher });
  };
}

export const upstreamFetch = bindUpstreamFetch();

/** 꺼져 있으면 undefined — 호출자가 fetch 를 안 준 것과 같다. */
export function resolveUpstreamFetch(env = process.env) {
  return upstreamDispatcherEnabled(env) ? upstreamFetch : undefined;
}
