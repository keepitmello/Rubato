import * as breaker from "./circuit-breaker.mjs";
import { shouldRunIdleCompaction } from "./idle.mjs";
import { isOpenAiRemoteCompactionModel } from "./openai-remote-model.mjs";
import { runOpenAiRemoteCompaction } from "./openai-remote.mjs";

const HISTORY_NOTES_MODE = "history-notes";
const SUMMARY_MODE = "summary";

function contextMode(env) {
  const raw = env.RUBATO_CONTEXT_MODE?.trim();
  if (!raw) return HISTORY_NOTES_MODE;
  return raw;
}

/** Notes-aware window owns cuts in history-notes; this overlay must not compact there. */
export function summaryCompactionAllowed(env, settings) {
  if (!settings?.enabled) return false;
  return contextMode(env) === SUMMARY_MODE;
}

function compactionSettingsFor(settingsManager, model) {
  const base = settingsManager.getCompactionSettings();
  const raw = settingsManager.getGlobalSettings?.()?.compaction
    ?? settingsManager.getProjectSettings?.()?.compaction
    ?? {};
  return {
    ...base,
    idleCompactionEnabled: raw.idleCompactionEnabled ?? true,
    thresholdRatio: raw.thresholdRatio,
    models: raw.models ?? raw.thresholdByModel,
    model,
  };
}

function benignCompactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Nothing to compact|Already compacted|cancelled/i.test(message);
}

export function createCompactionExtension({
  settingsManager,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!settingsManager) throw new TypeError("compaction requires the parent SettingsManager");
  return (pi) => {
    let state = { consecutiveFailures: 0, trippedAt: null, lastYield: undefined };
    let idleInFlight = false;

    pi.on("session_before_compact", async (event, ctx) => {
      const settings = compactionSettingsFor(settingsManager, ctx.model);
      if (!summaryCompactionAllowed(env, settings)) return undefined;
      if (event.signal?.aborted) return { cancel: true };
      if (!breaker.shouldBypass(state, { reason: event.reason }) && breaker.isTripped(state, now())) {
        return { cancel: true };
      }
      if (!isOpenAiRemoteCompactionModel(ctx.model)) return undefined;
      try {
        const compaction = await runOpenAiRemoteCompaction({
          model: ctx.model,
          event,
          systemPrompt: ctx.getSystemPrompt?.(),
          fetchImpl,
          now,
        });
        if (!compaction) return undefined;
        return { compaction };
      } catch {
        return undefined;
      }
    });

    pi.on("session_compact", async (event) => {
      state = breaker.recordSuccess(state);
      const before = event.compactionEntry?.tokensBefore;
      const after = event.compactionEntry?.tokensAfter ?? event.compactionEntry?.estimatedTokensAfter;
      if (typeof before === "number" && typeof after === "number" && before > after) {
        state = { ...state, lastYield: { savedTokens: before - after, tokensBefore: before } };
      }
    });

    pi.on("session_compact_failed", async (event) => {
      if (event.aborted) return;
      state = breaker.recordFailure(state, now(), { route: event.reason });
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (idleInFlight) return;
      const settings = compactionSettingsFor(settingsManager, ctx.model);
      if (!summaryCompactionAllowed(env, settings)) return;
      const usage = ctx.getContextUsage?.();
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
      const decision = {
        willRetry: false,
        aborted: false,
        mode: ctx.mode,
        settings,
        usage,
        contextWindow,
        breakerTripped: breaker.isTripped(state, now()),
        lastYield: state.lastYield,
      };
      if (!shouldRunIdleCompaction(decision)) return;
      idleInFlight = true;
      ctx.compact({
        customInstructions: "Proactively compact at idle before the next agent turn, while the user is not waiting.",
        onComplete: () => { idleInFlight = false; },
        onError: (error) => {
          idleInFlight = false;
          if (!benignCompactError(error)) {
            state = breaker.recordFailure(state, now(), { route: "idle" });
          }
        },
      });
    });
  };
}

export default createCompactionExtension;
