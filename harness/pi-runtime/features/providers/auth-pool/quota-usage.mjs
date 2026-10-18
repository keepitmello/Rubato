import { listSlots } from "./slots.mjs";
import { anthropicEndpointWindows, observedAccountUsage, readObservedUsage, recordObservedUsage } from "./usage-observed.mjs";

// The endpoint spends no inference quota. Setup-tokens cannot read it; their
// real response headers are already recorded by the stream observer.
export function createQuotaUsageReader({ path, fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 60_000 } = {}) {
  const cache = new Map();
  return async function read(credential, signal) {
    const observed = readObservedUsage(path);
    const result = {};
    for (const [key, entry] of Object.entries(observed.accounts)) {
      if (key.startsWith("anthropic/")) result[key.slice("anthropic/".length)] = entry;
    }
    await Promise.all(listSlots(credential).map(async (slot) => {
      const seen = observedAccountUsage(observed, "anthropic", slot.name);
      // Reuse recent real-call or endpoint measurements across processes.
      if (seen && now() - Date.parse(seen.observedAt) < ttlMs) return;
      if (!slot.access || slot.expires <= now()) return;
      let entry = cache.get(slot.name);
      if (!entry || entry.access !== slot.access || now() - entry.at >= ttlMs) {
        entry = { access: slot.access, at: now(), ...(entry?.access === slot.access ? { value: entry.value } : {}) };
        cache.set(slot.name, entry);
        entry.pending = (async () => {
          try {
            const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
              headers: { authorization: `Bearer ${slot.access}`, "anthropic-beta": "oauth-2025-04-20" },
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
            });
            if (!response.ok) return;
            const windows = anthropicEndpointWindows(await response.json());
            if (windows.length) {
              entry.value = { observedAt: new Date(now()).toISOString(), windows };
              try { recordObservedUsage(path, "anthropic", slot.name, windows, now()); } catch { /* cache is still usable */ }
            }
          } catch {
            signal?.throwIfAborted?.();
          }
        })();
      }
      await entry.pending;
      if (entry.value && (!seen || Date.parse(entry.value.observedAt) >= Date.parse(seen.observedAt))) {
        result[slot.name] = entry.value;
      }
    }));
    return result;
  };
}
