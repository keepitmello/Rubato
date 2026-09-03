import { replaceOnce } from "./core-replace.mjs";

// pi-agent-core 의 `withEmptyAssistantRecovery` 는 "빈 응답이면 한 번 더" 를 위해
// 보이는 내용(text_delta·toolcall_start)이 나올 때까지 `start`·`thinking_delta` 를
// 전부 버퍼에 쥔다. 그동안 agent-loop 의 stream-start 감시(기본 90초)는 첫 event 를
// 못 보므로, Claude 가 90초 넘게 생각만 하면 상류가 멀쩡히 흐르는데도
// "Provider stream start timed out" 으로 끊긴다. 재시도해도 같은 자리에서 같은
// 길이로 생각하니 연속으로 터진다 (2026-09-03 daker 세션 5연속, 08-31 opus 4연속).
//
// 고침: 감시가 마감에서 묻는 `hasPendingLocalWork()` 를 outerStream 에 달아,
// 버퍼링 중 상류 event 가 있었으면 "살아 있다" 고 답해 재무장시킨다. 플래그는
// 물을 때 소비하므로 한 마감 창(90초) 안의 활동만 센다. 상류 stream 의 local
// work(Cursor exec) 도 같이 위임해서, 래퍼가 그 신호를 삼키던 것도 함께 고친다.

const STATE_NEEDLE =
  "function createRetryingStream(firstStream, createStream) {\n" +
  "    const outerStream = createAssistantMessageEventStream();\n" +
  "    void (async () => {\n" +
  "        try {\n" +
  "            let stream = firstStream;\n";

const STATE_REPLACEMENT =
  "function createRetryingStream(firstStream, createStream) {\n" +
  "    const outerStream = createAssistantMessageEventStream();\n" +
  "    // Liveness while events are held back: the agent loop's stream-start guard\n" +
  "    // never sees buffered `start`/`thinking_delta` events, so a long thinking\n" +
  "    // prefix would look like a dead request. The guard consults\n" +
  "    // `hasPendingLocalWork()` at its deadline; answer true when upstream moved\n" +
  "    // since the last check so it re-arms instead of aborting a live stream.\n" +
  "    let upstreamActivity = false;\n" +
  "    let currentStream = firstStream;\n" +
  "    outerStream.hasPendingLocalWork = () => {\n" +
  "        const seen = upstreamActivity;\n" +
  "        upstreamActivity = false;\n" +
  "        return seen || currentStream?.hasPendingLocalWork?.() === true;\n" +
  "    };\n" +
  "    void (async () => {\n" +
  "        try {\n" +
  "            let stream = firstStream;\n";

const EVENT_NEEDLE =
  "                for await (const event of stream) {\n" +
  "                    if (event.type === \"done\") {\n";

const EVENT_REPLACEMENT =
  "                for await (const event of stream) {\n" +
  "                    if (!forwarding)\n" +
  "                        upstreamActivity = true;\n" +
  "                    if (event.type === \"done\") {\n";

const FORWARD_NEEDLE =
  "                    if (eventStartsVisibleContent(event)) {\n" +
  "                        for (const pending of buffered)\n" +
  "                            outerStream.push(pending);\n" +
  "                        forwarding = true;\n" +
  "                    }\n";

const FORWARD_REPLACEMENT =
  "                    if (eventStartsVisibleContent(event)) {\n" +
  "                        for (const pending of buffered)\n" +
  "                            outerStream.push(pending);\n" +
  "                        forwarding = true;\n" +
  "                        // Forwarded events reset the guard themselves.\n" +
  "                        upstreamActivity = false;\n" +
  "                    }\n";

const RETRY_NEEDLE =
  "                retrying = true;\n" +
  "                stream = await createStream();\n";

const RETRY_REPLACEMENT =
  "                retrying = true;\n" +
  "                stream = await createStream();\n" +
  "                currentStream = stream;\n";

export function isEmptyRecoveryUrl(url) {
  return url.includes("@earendil-works/pi-agent-core/dist/empty-assistant-recovery.js");
}

/** Buffered thinking prefix must count as stream liveness for the start/idle guards. */
export function injectEmptyRecoveryLiveness(source) {
  let next = replaceOnce(source, STATE_NEEDLE, STATE_REPLACEMENT, "empty-recovery liveness state");
  next = replaceOnce(next, EVENT_NEEDLE, EVENT_REPLACEMENT, "empty-recovery event activity");
  next = replaceOnce(next, FORWARD_NEEDLE, FORWARD_REPLACEMENT, "empty-recovery forwarding reset");
  return replaceOnce(next, RETRY_NEEDLE, RETRY_REPLACEMENT, "empty-recovery retry stream");
}
