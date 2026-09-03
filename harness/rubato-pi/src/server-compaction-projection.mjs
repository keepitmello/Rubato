// Anthropic 서버 컴팩션과 senpi 컴팩션 생명주기의 공존 규칙 — 순수 함수만 둔다.
//
// 1) 소유권: 지원 모델에서는 threshold / overflow / pre_prompt 자동 컴팩션이 클라이언트
//    LLM 요약을 돌리지 않는다. Claude-SDK 레인과 같은 `external-owner` 거절을 돌려주면
//    agent-session 의 `_isCompactionDelegated` 가 overflow 복구에서 이를 용인한다.
//    수동 `/compact` 는 열어 둔다 — 서버는 150K 기본 트리거를 강제할 수 없으므로 사용자가
//    지금 줄이고 싶으면 클라이언트 요약이 그 길이다. senpi 내장 확장의 레인 스위치도
//    (`core-lane-policy.mjs`) manual 을 같은 규칙으로 통과시킨다.
//    `extension`(투영 자체)·`branch`·`manual` 은 건드리지 않는다.
//
// 2) 투영: 서버 컴팩션 블록을 담은 assistant 메시지가 세션에 저장되면 그 요약을
//    `CompactionEntry` 로 옮긴다. `firstKeptEntryId` 를 그 assistant 항목으로 잡으면
//    `buildSessionContext()` 가 이전 기록을 버리고 summary user 메시지를 앞에 넣는다.
//    Anthropic 으로 되돌려 보낼 때는 assistant 메시지가 그대로 남으므로 native 블록도
//    유지되고, 다른 공급자로 바꾸면 그 공급자 컨버터가 providerNative 블록만 떨군다.
import { lastAnthropicCompactionSummary, isAnthropicCompactionBlock, supportsAnthropicServerCompaction } from "./anthropic-server-compaction.mjs";

export const SERVER_COMPACTION_REJECTION_REASON = "Anthropic server compaction owns compaction for this session";

/** 서버가 소유하는 컴팩션 사유. `extension`(투영)·`branch`·`manual` 은 건드리지 않는다. */
export const SERVER_OWNED_COMPACTION_REASONS = Object.freeze(["threshold", "overflow", "pre_prompt"]);

/** CompactionEntry.details 에 남기는 출처 표식 — 재투영 방지와 진단용. */
export const SERVER_COMPACTION_DETAILS_SOURCE = "anthropic-server-compaction";

const OWNED_REASONS = new Set(SERVER_OWNED_COMPACTION_REASONS);

/**
 * `session_before_compact` 결과. 지원 모델 + 자동 사유일 때만 external-owner 거절,
 * 그 외에는 undefined 를 돌려서 기존 경로를 바이트 단위로 그대로 둔다.
 */
export function serverCompactionRejection(model, reason) {
  if (!supportsAnthropicServerCompaction(model)) return undefined;
  if (!OWNED_REASONS.has(reason)) return undefined;
  return { cancel: true, rejectionCause: "external-owner", reason: SERVER_COMPACTION_REJECTION_REASON };
}

function assistantCompactionBlock(entry) {
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  for (let i = message.content.length - 1; i >= 0; i -= 1) {
    if (isAnthropicCompactionBlock(message.content[i])) return message.content[i];
  }
  return undefined;
}

/**
 * 브랜치를 끝에서 거슬러 올라가 아직 투영되지 않은 서버 컴팩션을 찾는다.
 * 어떤 종류든 `compaction` 항목을 만나면 멈춘다 — 그 이전 블록은 이미 투영됐거나
 * 다른 컴팩션이 덮어썼으므로 다시 만들면 안 된다(하나의 블록 → 하나의 항목).
 *
 * @returns `{ entryId, summary }` 또는 `content: null` 이면 `{ entryId, summary: undefined }`, 없으면 undefined
 */
export function findUnprojectedServerCompaction(branch) {
  if (!Array.isArray(branch)) return undefined;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "compaction") return undefined;
    const block = assistantCompactionBlock(entry);
    if (!block) continue;
    return { entryId: entry.id, summary: lastAnthropicCompactionSummary(entry.message.content) };
  }
  return undefined;
}

function contextTokensOf(usage) {
  if (!usage || typeof usage !== "object") return 0;
  // 서버가 압축한 순간의 입력이 compaction iteration 에 남는다(어댑터 패치가
  // `usage.compaction` 으로 옮김). 최상위 usage 는 압축 *이후* 의 실효 컨텍스트다.
  // iteration 의 `input` 은 캐시 밖 부분만이라 cacheRead/cacheWrite 를 더해야 청구 컨텍스트다.
  const compaction = usage.compaction;
  if (compaction && typeof compaction === "object") {
    const compacted = (["input", "cacheRead", "cacheWrite"]).reduce((acc, key) => acc + (Number(compaction[key]) || 0), 0);
    if (compacted > 0) return compacted;
  }
  const total = Number(usage.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  const sum = ["input", "output", "cacheRead", "cacheWrite"].reduce((acc, key) => acc + (Number(usage[key]) || 0), 0);
  return sum;
}

/**
 * `ctx.applyCompaction` 에 넘길 precomputed CompactionResult. `tokensBefore` 는 서버가
 * 압축한 요청의 청구 컨텍스트(그 assistant 의 usage) — 클라이언트 추정치보다 정확하다.
 */
export function serverCompactionResult(branch, found) {
  const entry = branch.find((candidate) => candidate?.id === found.entryId);
  return {
    summary: found.summary,
    firstKeptEntryId: found.entryId,
    tokensBefore: contextTokensOf(entry?.message?.usage),
    details: { source: SERVER_COMPACTION_DETAILS_SOURCE, assistantEntryId: found.entryId },
  };
}

/**
 * turn_end 마다 한 번. 결과:
 *  - `{ status: "applied" | "rejected", entryId }` 투영 시도
 *  - `{ status: "summary-null", entryId }` 서버가 요약에 실패 — 항목 없음, 진단만
 *  - `{ status: "none" }` 할 일 없음
 */
export async function projectServerCompaction(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  const found = findUnprojectedServerCompaction(branch);
  if (!found) return { status: "none" };
  if (found.summary === undefined) return { status: "summary-null", entryId: found.entryId };
  if (typeof ctx.applyCompaction !== "function") return { status: "rejected", entryId: found.entryId, reason: "no-apply" };
  const result = serverCompactionResult(branch, found);
  const outcome = await ctx.applyCompaction(result, { reason: "extension" });
  return outcome?.applied
    ? { status: "applied", entryId: found.entryId }
    : { status: "rejected", entryId: found.entryId, reason: outcome?.reason };
}
