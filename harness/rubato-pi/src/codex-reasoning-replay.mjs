// Codex 가 돌려준 생각 기록(암호화된 reasoning item) 하나가 다시 실리면 서버가 거의 매번
// "An error occurred while processing your request" 로 거절하는 일이 있다.
//
// 2026-10-12 writing-workbench 의 Astra 세션 하나가 07:45 부터 91번 이 오류를 맞았다. 같은
// 시간 같은 모델의 다른 세션은 0번이었다. 실패가 시작된 턴만 떼어 보낸 확인에서 그대로는
// 4/4 실패, 그 턴의 생각 기록만 빼면 4/4 성공했다. HTTPS 로 보내도 3/4 실패했다. 우리는 받은
// item 을 바이트 그대로 돌려주므로 서버 쪽 결함이고, 우리는 무엇을 보내는지만 정할 수 있다.
//
// 평소에는 공식 Codex CLI 처럼 생각 기록을 전부 그대로 보낸다. GPT-5.6 이후 모델은 지난 턴의
// 생각 기록도 다음 답에 쓰므로 빼면 손해다. 같은 오류가 연달아 나면 범인 하나만 찾는다:
// 가장 최근 기록부터 하나씩 빼고 다시 보내, 성공하면 그 하나만 계속 빼고, 실패하면 되돌리고
// 그다음 것을 뺀다. 후보가 다 떨어지면 그때만 전부 빼서 세션이 멈추지 않게 한다. 실패한
// 요청은 사용량이 0 이라 찾는 비용은 재시도 시간뿐이다. 찾은 기록은 세션별 파일에 남겨
// 엔진을 다시 켜도 다시 찾지 않는다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSpeedIndexAgentDir } from "./speed-index-store.mjs";

export const CODEX_REPLAY_FAILURE = /An error occurred while processing your request/;
export const FAILURES_BEFORE_SEARCH = 2;

const CODEX_API = "openai-codex-responses";

function isCodex(model) {
  return model?.api === CODEX_API;
}

function reasoningId(block) {
  if (block?.type !== "thinking" || !block.thinkingSignature) return undefined;
  try {
    const id = JSON.parse(block.thinkingSignature)?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 이 요청이 다시 싣는 생각 기록 id, 오래된 것부터. */
function replayedIds(model, context) {
  const ids = [];
  for (const message of context?.messages ?? []) {
    if (message?.role !== "assistant" || message.api !== model.api || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const id = reasoningId(block);
      if (id) ids.push(id);
    }
  }
  return ids;
}

function sessionFile(dir, sessionId) {
  return dir ? join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`) : undefined;
}

/**
 * `dir` 은 찾은 기록을 남기는 폴더다. 없으면 기억은 프로세스 안에만 있다.
 */
export function createCodexReasoningReplay({ dir } = {}) {
  // sessionId -> { failures, dropped: Set, probe, tried: Set }
  const sessions = new Map();

  const load = (sessionId) => {
    let state = sessions.get(sessionId);
    if (state) return state;
    let dropped = [];
    const file = sessionFile(dir, sessionId);
    if (file) {
      try { dropped = JSON.parse(readFileSync(file, "utf8")).dropped ?? []; } catch {}
    }
    state = { failures: 0, dropped: new Set(dropped), probe: undefined, tried: new Set() };
    sessions.set(sessionId, state);
    return state;
  };

  const save = (sessionId, state) => {
    const file = sessionFile(dir, sessionId);
    if (!file) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({ dropped: [...state.dropped] })}\n`, { mode: 0o600 });
    } catch {}
  };

  return {
    /** 보낼 context. 뺄 것이 없으면 받은 그대로다. */
    prepare(model, context, sessionId) {
      if (!isCodex(model) || !sessionId || !Array.isArray(context?.messages)) return context;
      const state = load(sessionId);
      if (state.dropped.size === 0 && !state.probe) return context;
      const skip = (id) => state.dropped.has(id) || id === state.probe;
      let changed = false;
      const messages = context.messages.map((message) => {
        if (message?.role !== "assistant" || message.api !== model.api || !Array.isArray(message.content)) return message;
        const content = message.content.filter((block) => {
          const id = reasoningId(block);
          return !(id && skip(id));
        });
        if (content.length === message.content.length) return message;
        changed = true;
        return { ...message, content };
      });
      return changed ? { ...context, messages } : context;
    },

    /** 한 요청의 끝. `context` 는 빼기 전의 원래 context 다. */
    observe(model, context, sessionId, message) {
      if (!isCodex(model) || !sessionId || !message || message.stopReason === "aborted") return;
      const state = load(sessionId);
      if (message.stopReason !== "error") {
        if (state.probe) {
          state.dropped.add(state.probe);
          save(sessionId, state);
        }
        state.probe = undefined;
        state.tried.clear();
        state.failures = 0;
        return;
      }
      if (!CODEX_REPLAY_FAILURE.test(message.errorMessage ?? "")) return;
      if (state.probe) state.tried.add(state.probe);
      state.probe = undefined;
      state.failures += 1;
      if (state.failures < FAILURES_BEFORE_SEARCH) return;
      const next = replayedIds(model, context).reverse()
        .find((id) => !state.dropped.has(id) && !state.tried.has(id));
      if (next) {
        state.probe = next;
        return;
      }
      // 하나씩 빼서는 안 됐다. 세션이 멈추지 않게 지금까지의 생각 기록을 전부 뺀다.
      if (state.tried.size > 0) {
        for (const id of replayedIds(model, context)) state.dropped.add(id);
        state.tried.clear();
        save(sessionId, state);
      }
    },
  };
}

function defaultDir(env = process.env) {
  const agentDir = resolveSpeedIndexAgentDir(env);
  return agentDir ? join(agentDir, "codex-reasoning-drops") : undefined;
}

export const codexReasoningReplay = createCodexReasoningReplay({ dir: defaultDir() });
