// 요약 응답이 toolCall 을 담고 오면 원래 코드는 그 자리에서 던졌다:
// generateSummaryWithUsage / generateTurnPrefixSummary 둘 다
// "attempted to call a tool" 로 예외를 내고, agent-session 은 그걸
// compaction_end accepted:false, willRetry:false 로 접어 세션을 그대로 막았다.
//
// 1차 patch 는 cache-friendly sourceContext(도구 목록을 실은 provider 컨텍스트)가
// 있을 때만 그걸 벗기고 재시도했다. 하지만 기본 설치는 EXPERIMENTAL=1 이 아닌 한
// sourceContext 를 절대 만들지 않으므로(core/experimental.js) 신고된 실패가 나는
// 통상 경로에서는 벗길 sourceContext 자체가 없어 즉시 재던졌다.
//
// 2차 patch 는 sourceContext 유무와 무관하게 한 번의 재시도를 보장했지만, 그래도
// toolCall 이면 previousSummary 와 대화 내용을 전부 버리는 고정 placeholder 로
// 대체했다 — 이건 "막힌 compaction" 보다 나쁘다: 조용히 사실을 잃는다.
//
// 지금 patch(3차)는 재시도까지 실패해도 previousSummary + 요약 대상 메시지의
// 앞/뒤 bounded excerpt 를 결정적으로 보존한다. tool 인자는 절대 읽지 않는다.
import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { VENDOR_PATCHES } from "../postinstall.mjs";

const senpiRoot = VENDOR_PATCHES[0].resolveRoot();
const compactionModulePath = realpathSync(join(senpiRoot, "dist", "core", "compaction", "compaction.js"));
const { generateSummaryWithUsage } = await import(
  process.platform === "win32" ? `file:///${compactionModulePath.split(sep).join("/")}` : compactionModulePath
);

const model = { maxTokens: 1000, contextWindow: 100_000, reasoning: false, provider: "test", api: "test" };
const UNIQUE_CURRENT_FACT = "widget-count-47281";
const currentMessages = [
  { role: "user", content: [{ type: "text", text: `please track ${UNIQUE_CURRENT_FACT}` }], timestamp: 1 },
];
const sourceContext = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
};

/** Fake stream: each call drains an empty async-iterable then resolves to the next canned response. */
function fakeStreamFn(responses: unknown[]) {
  let call = 0;
  const calls: unknown[] = [];
  const fn = async (_model: unknown, context: unknown) => {
    calls.push(context);
    const response = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      [Symbol.asyncIterator]: async function* () {},
      result: async () => response,
    };
  };
  fn.calls = calls;
  fn.callCount = () => call;
  return fn;
}

const TOOL_ARG_MARKER = "rm-rf-secret-command-9931";
const toolCallResponse = {
  stopReason: "toolUse",
  content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: TOOL_ARG_MARKER } }],
  usage: { input: 1, output: 1 },
};
const textResponse = { stopReason: "stop", content: [{ type: "text", text: "clean summary" }], usage: {} };

async function runSummary(
  streamFn: ReturnType<typeof fakeStreamFn>,
  previousSummary: string | undefined,
  cacheFriendly?: { sourceContext: unknown; requestOptions: Record<string, unknown> },
) {
  return generateSummaryWithUsage(
    currentMessages,
    model,
    2000,
    "key",
    {},
    undefined,
    undefined,
    previousSummary,
    undefined,
    "off",
    streamFn,
    undefined,
    undefined,
    undefined,
    undefined,
    "sess-1",
    cacheFriendly,
  );
}

describe("compaction toolCall deadlock", () => {
  test("직접 재현: 도구-목록 sourceContext 의 첫 toolCall 은 텍스트만으로 재시도되어 진행된다", async () => {
    const streamFn = fakeStreamFn([toolCallResponse, textResponse]);
    const result = await runSummary(streamFn, undefined, { sourceContext, requestOptions: {} });
    expect(result.text).toBe("clean summary");
    expect(streamFn.callCount()).toBe(2);
  });

  test("sourceContext 가 처음부터 없는(기본 설치, EXPERIMENTAL 꺼짐) 통상 경로에서도 한 번 재시도한다", async () => {
    const streamFn = fakeStreamFn([toolCallResponse, textResponse]);
    const result = await runSummary(streamFn, undefined, undefined);
    expect(result.text).toBe("clean summary");
    expect(streamFn.callCount()).toBe(2);
  });

  test("재시도까지 toolCall 이면 세 번째 호출 없이 진행하고, previousSummary 와 현재 메시지의 고유 사실을 보존한다", async () => {
    const UNIQUE_PREVIOUS_FACT = "prior-decision-xk442";
    const streamFn = fakeStreamFn([toolCallResponse, toolCallResponse]);
    const result = await runSummary(streamFn, `we decided ${UNIQUE_PREVIOUS_FACT}`, { sourceContext, requestOptions: {} });
    expect(streamFn.callCount()).toBe(2);
    expect(result.text).toContain("Automatic compaction summary unavailable");
    // 막힌 것보다 나쁜 것은 조용히 사실을 잃는 것이다 — 둘 다 살아 있어야 한다.
    expect(result.text).toContain(UNIQUE_PREVIOUS_FACT);
    expect(result.text).toContain(UNIQUE_CURRENT_FACT);
    // tool 인자는 절대 요약 텍스트로 새어 나오지 않는다.
    expect(result.text).not.toContain(TOOL_ARG_MARKER);
    expect(result.text).not.toContain("bash");
  });

  test("sourceContext 없이 시작해도(통상 경로) 재시도까지 toolCall 이면 같은 방식으로 사실을 보존한 채 진행한다", async () => {
    const UNIQUE_PREVIOUS_FACT = "prior-decision-qz991";
    const streamFn = fakeStreamFn([toolCallResponse, toolCallResponse]);
    const result = await runSummary(streamFn, `remember ${UNIQUE_PREVIOUS_FACT}`, undefined);
    expect(streamFn.callCount()).toBe(2);
    expect(result.text).toContain(UNIQUE_PREVIOUS_FACT);
    expect(result.text).toContain(UNIQUE_CURRENT_FACT);
    expect(result.text).not.toContain(TOOL_ARG_MARKER);
  });

  test("대체 요약의 재시도 요청에는 sourceContext(도구 목록)를 실어 보내지 않는다", async () => {
    const streamFn = fakeStreamFn([toolCallResponse, toolCallResponse]);
    await runSummary(streamFn, undefined, { sourceContext, requestOptions: {} });
    const secondCallContext = streamFn.calls[1] as { messages?: unknown[] };
    expect(secondCallContext.messages).toHaveLength(1);
  });

  test("긴 previousSummary + 긴 대화도 결정적 예산 안에 bounded 로 잘린다 (compaction 의 목적을 해치지 않는다)", async () => {
    const longPrevious = "x".repeat(50_000);
    const longMessages = [
      { role: "user", content: [{ type: "text", text: `start-marker ${UNIQUE_CURRENT_FACT} ${"y".repeat(50_000)} end-marker` }], timestamp: 1 },
    ];
    const streamFn = fakeStreamFn([toolCallResponse, toolCallResponse]);
    const result = await generateSummaryWithUsage(
      longMessages, model, 2000, "key", {}, undefined, undefined, longPrevious, undefined, "off",
      streamFn, undefined, undefined, undefined, undefined, "sess-1", undefined,
    );
    // maxTokens = floor(0.8*2000)=1600 -> char budget = min(20000, max(2000, 1600*3)) = 4800.
    // Total output (marker + wrapper tags + separators + both excerpts) must fit inside it.
    expect(result.text.length).toBeLessThanOrEqual(4800);
    expect(result.text).toContain("start-marker");
    expect(result.text).toContain("end-marker");
    expect(result.text).not.toContain(TOOL_ARG_MARKER);
  });

  test("previousSummary 의 고유 사실 + 현재 메시지의 첫/끝 고유 사실이 두 번의 toolCall 뒤에도 모두 살아남고, 출력은 bounded 이며, tool 이름/인자는 새어 나오지 않는다", async () => {
    const UNIQUE_PREVIOUS_FACT = "prior-decision-mv7731";
    const UNIQUE_FIRST_FACT = "first-turn-fact-ab1029";
    const UNIQUE_LAST_FACT = "last-turn-fact-cd8845";
    const middleFiller = "filler ".repeat(20_000); // pushes the conversation well past the char budget
    const longConversation = [
      { role: "user", content: [{ type: "text", text: `${UNIQUE_FIRST_FACT} ${middleFiller}` }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: middleFiller }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: `${middleFiller} ${UNIQUE_LAST_FACT}` }], timestamp: 3 },
    ];
    const streamFn = fakeStreamFn([toolCallResponse, toolCallResponse]);
    const result = await generateSummaryWithUsage(
      longConversation, model, 2000, "key", {}, undefined, undefined, `we decided ${UNIQUE_PREVIOUS_FACT}`, undefined, "off",
      streamFn, undefined, undefined, undefined, undefined, "sess-1", undefined,
    );
    expect(streamFn.callCount()).toBe(2);
    // exact bound: maxTokens = floor(0.8*2000) = 1600 -> charBudget = min(20000, max(2000, 1600*3)) = 4800.
    // The fallback must fit within that budget in total (marker + wrapper tags +
    // separators + both excerpts), not just have a small excerpt body.
    expect(result.text.length).toBeLessThanOrEqual(4800);
    expect(result.text.length).toBeLessThan(20_000);
    // head, tail, and the previous summary all survive the elision.
    expect(result.text).toContain(UNIQUE_PREVIOUS_FACT);
    expect(result.text).toContain(UNIQUE_FIRST_FACT);
    expect(result.text).toContain(UNIQUE_LAST_FACT);
    // never the tool call's name or arguments.
    expect(result.text).not.toContain(TOOL_ARG_MARKER);
    expect(result.text).not.toContain("bash");
  });

  test("정상 응답은 그대로 통과한다 (회귀 없음)", async () => {
    const streamFn = fakeStreamFn([textResponse]);
    const result = await runSummary(streamFn, undefined, undefined);
    expect(result.text).toBe("clean summary");
    expect(streamFn.callCount()).toBe(1);
  });
});
