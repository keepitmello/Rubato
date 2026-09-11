import { registerApplyPatchExtension } from "./apply-patch.mjs";
import { loopGuardExtension } from "./loop-guard.mjs";
import { toolPairGuardExtension } from "./tool-pair.mjs";

export {
  APPLY_PATCH_FREEFORM_DESCRIPTION,
  APPLY_PATCH_JSON_DESCRIPTION,
  APPLY_PATCH_LARK_GRAMMAR,
  APPLY_PATCH_NAME,
  createApplyPatchTool,
  getApplyPatchWireMode,
  normalizeApplyPatchArguments,
  registerApplyPatchExtension,
} from "./apply-patch.mjs";

export { applyPatchDetailed, buildPartialFailureText, getPendingMutationCount } from "./patch-engine.mjs";
export { normalizePatchText, parsePatch, replaceChunks, seekSequenceWithFuzz, stripHeredoc } from "./patch-format.mjs";

export {
  CONTINUATION_HOLD_STATE_EVENT,
  IdenticalLoopEscalation,
  LOOP_GUARD_ESCALATION_CUSTOM_TYPE,
  LOOP_GUARD_NOTICE_CUSTOM_TYPE,
  LOOP_GUARD_RECOVERY_CUSTOM_TYPE,
  NoticeGate,
  ToolCallTracker,
  WAKE_SOURCE_STATE_EVENT,
  canonicalizeArgs,
  detectCycle,
  detectIdenticalRun,
  detectLoop,
  detectSimilarRun,
  loopGuardExtension,
} from "./loop-guard.mjs";

export {
  sanitizeAnthropicToolPairs,
  sanitizeOpenAIChatCompletionsPayload,
  sanitizeOpenAIResponsesPayload,
  sanitizeToolPairs,
  toolPairGuardExtension,
} from "./tool-pair.mjs";

/** Load order is part of the contract: loop guard vetoes before later hooks or permissions. */
export function createToolGuardExtensionFactories() {
  return [
    { name: "rubato-loop-guard", factory: loopGuardExtension },
    { name: "rubato-gpt-apply-patch", factory: registerApplyPatchExtension },
    { name: "rubato-tool-pair-guard", factory: toolPairGuardExtension },
  ];
}
