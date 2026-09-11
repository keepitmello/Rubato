import { shouldTriggerCompaction } from "./policy.mjs";

export const IDLE_COMPACTION_INSTRUCTIONS = "Proactively compact at idle before the next agent turn, while the user is not waiting.";
const PERSISTENT_MODES = new Set(["tui", "rpc", "app-server"]);
const WARM_GENERATION_FLOOR_RATIO = 0.6;

function isIdleEligible(decision) {
  if (decision.willRetry) return false;
  if (decision.aborted) return false;
  if (!PERSISTENT_MODES.has(decision.mode)) return false;
  if (!decision.settings.enabled) return false;
  if (decision.settings.idleCompactionEnabled === false) return false;
  if (decision.breakerTripped) return false;
  if (!decision.usage) return false;
  return decision.usage.tokens !== null;
}

export function shouldRunIdleCompaction(decision) {
  if (!isIdleEligible(decision) || !decision.usage) return false;
  return shouldTriggerCompaction(decision.usage, decision.contextWindow, decision.settings, decision.lastYield);
}

export function shouldWarmAtIdle(decision) {
  if (!isIdleEligible(decision) || !decision.usage || decision.usage.tokens === null) return false;
  return decision.usage.tokens >= decision.contextWindow * WARM_GENERATION_FLOOR_RATIO;
}
