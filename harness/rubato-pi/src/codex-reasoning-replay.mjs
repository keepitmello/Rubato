// Codex 가 돌려준 생각 기록(암호화된 reasoning item) 하나가 다시 실리면 서버가 거의 매번
// "An error occurred while processing your request" 로 거절하는 일이 있다.
//
// 2026-10-12 writing-workbench 의 Astra 세션 하나가 07:45 부터 91번 이 오류를 맞았다. 같은
// 시간 같은 모델의 다른 세션은 0번이었다. 실패가 시작된 턴만 떼어 보낸 확인에서 그대로는
// 4/4 실패, 그 턴의 생각 기록만 빼면 4/4 성공했다. 그 item 은 다른 item 과 필드 순서부터
// 달랐다(서버가 다른 경로로 만든 것). 가끔 성공하는 것은 그것을 읽는 서버에 배정됐을 때다.
// 서버 쪽 결함이라 우리는 무엇을 보내는지만 정할 수 있다.
//
// 그래서 같은 세션에서 이 오류가 연달아 나면, 그 요청까지의 지난 생각 기록을 이후 요청에서
// 계속 뺀다. 계속 빼야 요청 앞부분이 다시 고정되어 캐시가 한 번만 빗나간다. 이후 턴에 새로
// 생기는 생각 기록은 그대로 싣는다. 생각 기록은 지난 턴 것이 없어도 요청이 성립한다.

export const CODEX_REPLAY_FAILURE = /An error occurred while processing your request/;
export const FAILURES_BEFORE_DROP = 2;

const CODEX_API = "openai-codex-responses";

function isCodex(model) {
  return model?.api === CODEX_API;
}

function hasReplayedReasoning(message, api) {
  return message?.role === "assistant" && message.api === api && Array.isArray(message.content)
    && message.content.some((block) => block?.type === "thinking" && block.thinkingSignature);
}

export function createCodexReasoningReplay() {
  // sessionId -> { failures, floor }. floor 는 생각 기록을 빼는 마지막 assistant 의 timestamp 다.
  const sessions = new Map();

  return {
    /** 보낼 context. 뺄 것이 없으면 받은 그대로다. */
    prepare(model, context, sessionId) {
      const floor = isCodex(model) && sessionId ? sessions.get(sessionId)?.floor : undefined;
      if (floor === undefined || !Array.isArray(context?.messages)) return context;
      let changed = false;
      const messages = context.messages.map((message) => {
        if (!hasReplayedReasoning(message, model.api) || !(message.timestamp <= floor)) return message;
        changed = true;
        return { ...message, content: message.content.filter((block) => !(block?.type === "thinking" && block.thinkingSignature)) };
      });
      return changed ? { ...context, messages } : context;
    },

    /** 한 요청의 끝. 연달아 같은 오류면 그 요청까지의 생각 기록을 뺄 자리로 정한다. */
    observe(model, context, sessionId, message) {
      if (!isCodex(model) || !sessionId || !message) return;
      if (message.stopReason === "aborted") return;
      const state = sessions.get(sessionId) ?? { failures: 0, floor: undefined };
      sessions.set(sessionId, state);
      if (message.stopReason !== "error" || !CODEX_REPLAY_FAILURE.test(message.errorMessage ?? "")) {
        state.failures = 0;
        return;
      }
      state.failures += 1;
      if (state.failures < FAILURES_BEFORE_DROP) return;
      const replayed = (context?.messages ?? []).filter((entry) => hasReplayedReasoning(entry, model.api));
      const latest = replayed.reduce((max, entry) => (typeof entry.timestamp === "number" && entry.timestamp > (max ?? -Infinity) ? entry.timestamp : max), undefined);
      if (latest !== undefined) state.floor = Math.max(state.floor ?? latest, latest);
      state.failures = 0;
    },
  };
}

export const codexReasoningReplay = createCodexReasoningReplay();
