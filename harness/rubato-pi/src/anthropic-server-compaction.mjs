// Anthropic 서버 컴팩션(beta `compact-2026-01-12`) 을 쓰는 모델의 **유일한** 판별점.
//
// 문서(platform.claude.com/docs/en/build-with-claude/compaction)의 지원 목록과
// 현재 피커(`picker-catalog.mjs` ANTHROPIC_PICKER_IDS)의 교집합이다. Haiku 4.5 는
// 공식 목록에 없으므로 기존 클라이언트 컴팩션을 그대로 쓴다. 모델 id 문자열을 다른
// 파일에서 다시 검사하지 말고 여기 predicate 를 import 한다.

export const ANTHROPIC_SERVER_COMPACTION_BETA = "compact-2026-01-12";
export const ANTHROPIC_SERVER_COMPACTION_EDIT_TYPE = "compact_20260112";

/** 서버 컴팩션이 만들어 돌려주는 콘텐츠 블록의 wire type 과 delta type. */
export const ANTHROPIC_COMPACTION_BLOCK_TYPE = "compaction";
export const ANTHROPIC_COMPACTION_DELTA_TYPE = "compaction_delta";

export const ANTHROPIC_SERVER_COMPACTION_MODEL_IDS = Object.freeze([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
]);

const SERVER_COMPACTION_IDS = new Set(ANTHROPIC_SERVER_COMPACTION_MODEL_IDS);

// 필수 트랜스폼이 실제로 적용됐는지 알리는 표시. 로더(`no-changelog-hooks.mjs`) 는 니들이 어긋나면
// 경고만 내고 원본을 태우므로, 어댑터 패치(블록 수신·재전송) 나 레인 패치(senpi 자동 컴팩션
// 정지) 없이 와이어만 켜지면 서버가 압축한 요약을 버리게 된다. 와이어는 둘 다 켜져 있을 때만 동작한다.
export const ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER = "rubato.anthropicServerCompaction.adapter";
export const ANTHROPIC_SERVER_COMPACTION_LANE_MARKER = "rubato.anthropicServerCompaction.lane";

/** 트랜스폼이 패치된 모듈 끝에 붙이는 한 줄. */
export function serverCompactionMarkerStatement(marker) {
  return `\nglobalThis[Symbol.for(${JSON.stringify(marker)})] = true;\n`;
}

export function anthropicServerCompactionArmed() {
  return (
    globalThis[Symbol.for(ANTHROPIC_SERVER_COMPACTION_ADAPTER_MARKER)] === true &&
    globalThis[Symbol.for(ANTHROPIC_SERVER_COMPACTION_LANE_MARKER)] === true
  );
}

/**
 * `model` 은 pi-ai Model 객체(`{ provider, id }`) 또는 `{ provider, modelId }` 꼴의
 * 세션 설정을 받는다. provider 가 `anthropic` 이고 id 가 지원 목록에 있을 때만 true.
 */
export function supportsAnthropicServerCompaction(model) {
  if (!model || typeof model !== "object") return false;
  if (model.provider !== "anthropic") return false;
  const id = typeof model.id === "string" ? model.id : model.modelId;
  return typeof id === "string" && SERVER_COMPACTION_IDS.has(id);
}

/**
 * pi-ai 가 만든 AssistantMessage 안에서 서버 컴팩션 블록을 찾는다. 어댑터 패치는
 * 이 블록을 `{ type: "providerNative", subtype: "compaction", raw: { type: "compaction",
 * content: string | null } }` 로 보존한다 — 세션에 남는 계약이자 다른 모듈이 읽는 계약.
 */
export function isAnthropicCompactionBlock(block) {
  return (
    !!block &&
    typeof block === "object" &&
    block.type === "providerNative" &&
    block.subtype === ANTHROPIC_COMPACTION_BLOCK_TYPE &&
    !!block.raw &&
    typeof block.raw === "object" &&
    block.raw.type === ANTHROPIC_COMPACTION_BLOCK_TYPE
  );
}

/** 마지막 컴팩션 블록의 summary 문자열. 없거나 `content: null`(서버 요약 실패)이면 undefined. */
export function lastAnthropicCompactionSummary(content) {
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (!isAnthropicCompactionBlock(block)) continue;
    return typeof block.raw.content === "string" && block.raw.content.length > 0 ? block.raw.content : undefined;
  }
  return undefined;
}
