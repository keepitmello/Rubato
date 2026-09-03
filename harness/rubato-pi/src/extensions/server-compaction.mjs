// Anthropic 서버 컴팩션 ↔ senpi 컴팩션 생명주기 연결.
//
// - `session_before_compact`: 지원 모델의 자동 컴팩션을 `external-owner` 로 거절한다
//   (Claude-SDK 레인과 같은 계약; agent-session `_isCompactionDelegated` 가 용인).
// - `turn_end`: 서버 컴팩션 블록이 세션에 저장된 뒤(message_end 확장 이벤트는
//   appendMessage 보다 먼저 발화하므로 turn_end 를 쓴다) 요약을 CompactionEntry 로
//   투영한다. `ctx.applyCompaction(precomputed)` 는 prepareCompaction 과 LLM 요약을
//   건너뛰고 stale/overflow 검사 → appendCompaction → 메시지 재구성만 수행한다.
//   `ctx.compact()` 는 실행 중인 에이전트를 중단시키므로 쓰지 않는다.
import { projectServerCompaction, serverCompactionRejection } from "../server-compaction-projection.mjs";

export function installServerCompaction(pi, options = {}) {
  const diagnostic = typeof options.onDiagnostic === "function" ? options.onDiagnostic : () => {};
  // 같은 assistant 항목에 대한 진단은 한 번만 — 항목이 안 생기는 경우(null 요약)는
  // 다음 컴팩션까지 매 turn_end 에 다시 발견되기 때문.
  let lastReported;

  pi.on("session_before_compact", async (event, ctx) => serverCompactionRejection(ctx?.model, event?.reason));

  pi.on("turn_end", async (_event, ctx) => {
    const outcome = await projectServerCompaction(ctx);
    if (outcome.status === "none") return;
    const key = `${outcome.status}:${outcome.entryId}:${outcome.reason ?? ""}`;
    if (key === lastReported) return;
    lastReported = key;
    diagnostic(outcome);
  });
}
