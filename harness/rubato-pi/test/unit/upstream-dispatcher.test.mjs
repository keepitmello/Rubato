// 업스트림 Agent 의 연결 설정.
//
// 이 Agent 는 엔진 dispatcher(`core/http-dispatcher.js`)를 우회한다. 그래서 엔진이
// 고지연 회선을 위해 넣은 happy-eyeballs 시도 기한도 저절로 따라오지 않는다 —
// 빠지면 Node 기본(250~500ms)으로 돌아가 핫스팟에서 멀쩡한 연결 시도를 끊는다.
import assert from "node:assert/strict";
import test from "node:test";
import {
  UPSTREAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  UPSTREAM_BODY_TIMEOUT_MS,
  upstreamAgentOptions,
} from "../../src/upstream-dispatcher.mjs";

test("업스트림 Agent 는 엔진과 같은 happy-eyeballs 시도 기한(2초)을 쓴다", () => {
  assert.equal(UPSTREAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS, 2_000);
  assert.equal(upstreamAgentOptions().connect?.autoSelectFamilyAttemptTimeout, 2_000);
});

test("본문 idle 기한은 공유 Agent 의 실측 최대 내용 간격(92.6s)보다 크게 남는다", () => {
  assert.ok(UPSTREAM_BODY_TIMEOUT_MS > 92_600);
  assert.equal(upstreamAgentOptions().bodyTimeout, UPSTREAM_BODY_TIMEOUT_MS);
});
