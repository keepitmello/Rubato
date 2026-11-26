import { usageJson } from '../scripts/rubato-auth.mjs';
import { formatUsageOneLine } from '../scripts/rubato-usage.mjs';

export const DEFAULT_QUOTA_TTL_MS = 5 * 60_000;
export const DEFAULT_QUOTA_STALE_MS = 30 * 60_000;
export const DEFAULT_QUOTA_TIMEOUT_MS = 4000;

/**
 * Cached one-line quota summary across Anthropic (main/sub), Codex (+ reset passes) and
 * Antigravity (Neon). Never throws: if live lookup fails or times out, returns the last cached
 * line up to `staleMs` old, otherwise an empty string.
 */
export function createQuotaReader({
  ttlMs = DEFAULT_QUOTA_TTL_MS,
  staleMs = DEFAULT_QUOTA_STALE_MS,
  timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
  fetchUsage = (env) => usageJson({ env }),
  now = Date.now,
  timeZone,
} = {}) {
  let cached = null; // { line: string, at: number }
  let pending = null;

  async function refresh(env) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => fetchUsage(env)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('quota timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const line = formatUsageOneLine(result, { timeZone });
      if (line) cached = { line, at: now() };
      return line || (cached && now() - cached.at <= staleMs ? cached.line : '');
    } catch {
      return cached && now() - cached.at <= staleMs ? cached.line : '';
    } finally {
      clearTimeout(timer);
    }
  }

  return async function readQuotaLine({ env = process.env, force = false } = {}) {
    const current = now();
    if (!force && cached && current - cached.at < ttlMs) return cached.line;
    if (!pending) {
      pending = refresh(env).finally(() => { pending = null; });
    }
    return pending;
  };
}

export const readQuotaLine = createQuotaReader();
