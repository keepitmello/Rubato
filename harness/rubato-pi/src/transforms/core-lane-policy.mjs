import { replaceOnce } from "./core-replace.mjs";
import {
  ANTHROPIC_SERVER_COMPACTION_LANE_MARKER,
  ANTHROPIC_SERVER_COMPACTION_MODEL_IDS,
  serverCompactionMarkerStatement,
} from "../anthropic-server-compaction.mjs";

// senpi 내장 compaction 확장은 `lanePolicy.disablesSenpiCompaction(ctx)` 하나로
// speculative / idle / hard-limit / emergency-prune / degradation-recovery 를 전부
// 세운다 (Claude Agent SDK 레인용). Anthropic 서버 컴팩션 모델도 같은 스위치를 타야
// `session_before_compact` 를 우회하는 speculative·idle 경로가 클라이언트 요약을
// 돌리지 않는다. 모델 id 목록은 `anthropic-server-compaction.mjs` 에서 한 번만 읽어
// 여기 replacement 에 굽는다 — 두 번째 정의를 두지 않는다.

const MODEL_IDS_LITERAL = JSON.stringify([...ANTHROPIC_SERVER_COMPACTION_MODEL_IDS]);

const POLICY_NEEDLE =
  "        disablesSenpiCompaction(context) {\n" +
  "            if (context.model?.provider !== CLAUDE_SDK_OAUTH_PROVIDER_ID)\n" +
  "                return false;\n";

const POLICY_REPLACEMENT =
  "        disablesSenpiCompaction(context) {\n" +
  "            if (isAnthropicServerCompactionModel(context.model))\n" +
  "                return true;\n" +
  "            if (context.model?.provider !== CLAUDE_SDK_OAUTH_PROVIDER_ID)\n" +
  "                return false;\n";

const CONST_NEEDLE =
  'export const SDK_NATIVE_LANE_REJECTION_REASON = "the Claude Agent SDK owns compaction for this session";\n';

const CONST_REPLACEMENT =
  CONST_NEEDLE +
  'export const ANTHROPIC_SERVER_COMPACTION_REJECTION_REASON = "Anthropic server compaction owns compaction for this session";\n' +
  `const ANTHROPIC_SERVER_COMPACTION_MODEL_IDS = new Set(${MODEL_IDS_LITERAL});\n` +
  "export function isAnthropicServerCompactionModel(model) {\n" +
  '    return model?.provider === "anthropic" && ANTHROPIC_SERVER_COMPACTION_MODEL_IDS.has(model.id);\n' +
  "}\n" +
  "/** 레인이 senpi 컴팩션을 세울 때 사용자에게 보이는 사유. */\n" +
  "export function laneRejectionReason(model) {\n" +
  "    return isAnthropicServerCompactionModel(model) ? ANTHROPIC_SERVER_COMPACTION_REJECTION_REASON : SDK_NATIVE_LANE_REJECTION_REASON;\n" +
  "}\n" +
  "/** 서버는 자동 컴팩션만 가져간다 — 사용자의 /compact 는 클라이언트 요약으로 계속 동작한다. */\n" +
  "export function laneAllowsManualCompaction(model, reason) {\n" +
  '    return reason === "manual" && isAnthropicServerCompactionModel(model);\n' +
  "}\n";

const INDEX_IMPORT_NEEDLE =
  'import { CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE, collectCompactBoundaryEntries, createCompactionLanePolicy, SDK_NATIVE_LANE_REJECTION_REASON, } from "./lane-policy.js";';

const INDEX_IMPORT_REPLACEMENT =
  'import { CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE, collectCompactBoundaryEntries, createCompactionLanePolicy, laneAllowsManualCompaction, laneRejectionReason, } from "./lane-policy.js";';

const INDEX_REASON_NEEDLE =
  "            if (lanePolicy.disablesSenpiCompaction(ctx)) {\n" +
  "                return {\n" +
  "                    cancel: true,\n" +
  '                    rejectionCause: "external-owner",\n' +
  "                    reason: SDK_NATIVE_LANE_REJECTION_REASON,\n" +
  "                };\n" +
  "            }\n";

const INDEX_REASON_REPLACEMENT =
  "            if (lanePolicy.disablesSenpiCompaction(ctx) && !laneAllowsManualCompaction(ctx.model, event.reason)) {\n" +
  "                return {\n" +
  "                    cancel: true,\n" +
  '                    rejectionCause: "external-owner",\n' +
  "                    reason: laneRejectionReason(ctx.model),\n" +
  "                };\n" +
  "            }\n";

export function isLanePolicyUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/lane-policy.js");
}

export function isCompactionIndexUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/builtin/compaction/index.js");
}

/** Anthropic 서버 컴팩션 모델을 SDK 레인과 같은 "외부 소유" 로 선언한다. */
export function injectLanePolicy(source) {
  const next = replaceOnce(source, CONST_NEEDLE, CONST_REPLACEMENT, "lane-policy server-compaction predicate");
  return replaceOnce(next, POLICY_NEEDLE, POLICY_REPLACEMENT, "lane-policy disablesSenpiCompaction") +
    serverCompactionMarkerStatement(ANTHROPIC_SERVER_COMPACTION_LANE_MARKER);
}

/** 거절 사유 문구를 레인에 맞게 고른다 (SDK 문구가 Anthropic 세션에 뜨지 않게). */
export function injectCompactionIndexReason(source) {
  const next = replaceOnce(source, INDEX_IMPORT_NEEDLE, INDEX_IMPORT_REPLACEMENT, "compaction index lane import");
  return replaceOnce(next, INDEX_REASON_NEEDLE, INDEX_REASON_REPLACEMENT, "compaction index lane reason");
}
