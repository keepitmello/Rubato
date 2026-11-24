import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { agyRewindsNatively, writeAgyCut } from "./RubatoAgyNative.ts";

// The ACP adapter's `nativeRollback` for agy (agy-native-edits.mjs), over RubatoAgyNative.ts's files.
// Kept apart so RubatoLocalAgy.ts, which the Rubato checkout's tests load outside T3, stays free of Effect.
export const rubatoAgyNativeRollback = {
  supported: agyRewindsNatively,
  cut: (input: { readonly sessionId: string; readonly keepThroughTime: string }) =>
    Effect.tryPromise({
      try: () => writeAgyCut(input.sessionId, { throughTime: input.keepThroughTime }),
      catch: (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: `Could not leave the rewind for Antigravity session ${input.sessionId}`,
          cause,
        }),
    }),
  forkMeta: (keepThroughTime: string) => ({ rubato: { keepThroughTime } }),
};

/**
 * An instance behind the bridge before any session opens: T3 decides forks and rollbacks from
 * these, and a session that negotiates otherwise still answers for itself.
 */
export function withAgyNativeRewind(
  capabilities: OrchestrationV2ProviderCapabilities,
): OrchestrationV2ProviderCapabilities {
  return {
    ...capabilities,
    threads: { ...capabilities.threads, canForkThread: true, canForkFromTurn: true },
    checkpointing: { ...capabilities.checkpointing, providerCanRollbackConversation: true },
  };
}
