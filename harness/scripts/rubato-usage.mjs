// `rubato auth usage --json` — subscription usage for every connected account.
//
// The Usage page in the GUI draws one row per account, by provider. This reads each
// account with the credential Rubato already holds and maps the answer into the windows
// that page draws: { id, kind, label, usedPercent (0..100), resetsAt?, windowDurationMins? }.
//
// It never renews or writes a credential. Sessions renew tokens while they use them, and
// Codex and Anthropic rotate the refresh token on renewal, so a second writer here could
// strand an account. An account whose token has lapsed reports `probeFailed` until a
// session uses it again. Antigravity is the one exception: Google keeps the refresh token,
// so a memory-only renewal is harmless.
//
// Anthropic setup-token accounts cannot call the usage endpoint (their token lacks the
// scope, and the endpoint rate-limits them for an hour). Their windows come from the last
// real call's response headers, which the credential pool records
// (pi-runtime/features/providers/auth-pool/usage-observed.mjs).
import { observedAccountUsage, anthropicEndpointWindows } from "../pi-runtime/features/providers/auth-pool/usage-observed.mjs";

const REQUEST_TIMEOUT_MS = 10_000;
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

export class UsageReadError extends Error {}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function isoFromEpochSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function isoFromEpochMillis(value) {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : undefined;
}

function isoFromText(value) {
  if (typeof value !== "string" || !value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function titleCase(word) {
  return typeof word === "string" && word ? word[0].toUpperCase() + word.slice(1) : word;
}

function jwtClaims(token) {
  const part = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function requestJson(fetchImpl, url, init, what) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new UsageReadError(`${what} did not answer (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UsageReadError(`${what} refused the stored token. It renews the next time Rubato uses this account.`);
  }
  if (response.status === 429) throw new UsageReadError(`${what} is rate limiting usage reads.`);
  if (!response.ok) throw new UsageReadError(`${what} answered ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new UsageReadError(`${what} answered with something other than JSON.`);
  }
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexKind(mins) {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

/** `chatgpt.com/backend-api/wham/usage` → windows. Ids match T3's Codex driver. */
export function codexUsageWindows(body) {
  const limit = body?.rate_limit;
  const monthlyPlan = body?.plan_type === "free" || body?.plan_type === "go";
  const windows = [];
  for (const [id, window, fallbackMins] of [
    ["primary", limit?.primary_window, monthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", limit?.secondary_window, WEEK_MINS],
  ]) {
    const used = Number(window?.used_percent);
    if (!window || !Number.isFinite(used)) continue;
    const seconds = Number(window.limit_window_seconds);
    const windowDurationMins = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : fallbackMins;
    const kind = codexKind(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.reset_at);
    windows.push({
      id,
      kind,
      label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly",
      usedPercent: clampPercent(used),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

async function readCodex({ slot, fetchImpl }) {
  if (!slot?.access) return { unsupported: true };
  const accountId = jwtClaims(slot.access)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  const body = await requestJson(fetchImpl, "https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      authorization: `Bearer ${slot.access}`,
      "user-agent": "codex_cli_rs",
      ...(typeof accountId === "string" && accountId ? { "chatgpt-account-id": accountId } : {}),
    },
  }, "Codex");
  return {
    windows: codexUsageWindows(body),
    ...(typeof body?.email === "string" && body.email ? { email: body.email } : {}),
    ...(typeof body?.plan_type === "string" && body.plan_type ? { plan: `ChatGPT ${titleCase(body.plan_type)}` } : {}),
  };
}

// ── Anthropic ───────────────────────────────────────────────────────────────

/** `api.anthropic.com/api/oauth/usage` → windows. `utilization` is already a percentage. */
export const anthropicUsageWindows = anthropicEndpointWindows;

async function readAnthropic({ slot, account, observed, fetchImpl }) {
  const seen = observedAccountUsage(observed, "anthropic", account.name);
  const fromObservation = () => seen
    ? { windows: seen.windows, checkedAt: seen.observedAt }
    : undefined;
  if (!slot?.access) {
    const known = fromObservation();
    if (known) return known;
    throw new UsageReadError("No reply from this account yet. Its usage shows after Rubato's next call with it.");
  }
  try {
    const body = await requestJson(fetchImpl, "https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${slot.access}`, "anthropic-beta": "oauth-2025-04-20" },
    }, "Anthropic");
    return { windows: anthropicUsageWindows(body) };
  } catch (error) {
    const known = fromObservation();
    if (known) return known;
    throw error;
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────────

// Ids and labels match T3's `CURSOR_USAGE_WINDOWS`.
const CURSOR_WINDOWS = Object.freeze([
  { id: "totalPercentUsed", label: "Overall" },
  { id: "autoPercentUsed", label: "Cursor Models" },
  { id: "apiPercentUsed", label: "Other Models" },
]);

export function cursorUsageWindows(body) {
  const resetsAt = isoFromEpochMillis(body?.billingCycleEnd);
  const windows = [];
  for (const { id, label } of CURSOR_WINDOWS) {
    const used = Number(body?.planUsage?.[id]);
    if (body?.planUsage?.[id] === undefined || !Number.isFinite(used)) continue;
    windows.push({ id, kind: "monthly", label, usedPercent: clampPercent(used), ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

async function readCursor({ slot, fetchImpl }) {
  if (!slot?.access) return { unsupported: true };
  const body = await requestJson(fetchImpl, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${slot.access}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "cli",
    },
    body: "{}",
  }, "Cursor");
  return { windows: cursorUsageWindows(body) };
}

// ── Grok ────────────────────────────────────────────────────────────────────

export function grokUsageWindows(body) {
  const used = Number(body?.config?.creditUsagePercent);
  if (body?.config?.creditUsagePercent === undefined || !Number.isFinite(used)) return [];
  const type = String(body.config.currentPeriod?.type ?? "").replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind = type === "WEEKLY" ? "weekly" : type === "MONTHLY" ? "monthly" : "other";
  const resetsAt = isoFromText(body.config.currentPeriod?.end);
  return [{
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: clampPercent(used),
    ...(resetsAt ? { resetsAt } : {}),
  }];
}

async function readGrok({ slot, fetchImpl }) {
  // An xAI API key has no subscription to report.
  if (!slot?.access) return { unsupported: true };
  const body = await requestJson(fetchImpl, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: { authorization: `Bearer ${slot.access}` },
  }, "Grok");
  return { windows: grokUsageWindows(body) };
}

// ── Antigravity ─────────────────────────────────────────────────────────────

const ANTIGRAVITY_ENDPOINTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];

function quotaWindow(id, label, quota, kind = "other", windowDurationMins) {
  const remaining = Number(quota?.remainingFraction);
  if (quota?.remainingFraction === undefined || !Number.isFinite(remaining)) return undefined;
  const resetsAt = isoFromText(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

/** `retrieveUserQuotaSummary` → windows, named as T3's Antigravity driver names them. */
export function antigravitySummaryWindows(summary) {
  const windows = new Map();
  const groups = summary?.groups?.some((group) => group.buckets?.length) ? summary.groups : [{ buckets: summary?.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group?.buckets ?? []) {
      if (!bucket?.bucketId || bucket.disabled) continue;
      const family = bucket.bucketId.startsWith("gemini-") ? "Gemini"
        : bucket.bucketId.startsWith("3p-") ? "Claude & GPT (shared)"
          : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        bucket,
        weekly ? "weekly" : session ? "session" : "other",
        weekly ? WEEK_MINS : session ? SESSION_MINS : undefined,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** `fetchAvailableModels` → windows, for accounts that have no quota summary. */
export function antigravityModelWindows(body) {
  const windows = new Map();
  for (const [modelId, model] of Object.entries(body?.models ?? {})) {
    const family = model?.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-") ? "Gemini"
      : model?.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-") ? "Claude"
        : model?.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-") ? "GPT"
          : undefined;
    if (!family) continue;
    for (const [suffix, quota] of [["quota", model.quotaInfo], ["weekly", model.weeklyQuotaInfo]]) {
      if (!quota) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? WEEK_MINS : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

async function readAntigravity({ slot, credential, fetchImpl, now, renewAntigravity }) {
  if (!slot?.access && !slot?.refresh) return { unsupported: true };
  let access = slot.access;
  if ((typeof slot.expires !== "number" || slot.expires <= now() + 60_000) && slot.refresh) {
    try {
      access = (await renewAntigravity({ ...credential, refresh: slot.refresh }))?.access ?? access;
    } catch (error) {
      throw new UsageReadError(`Antigravity could not renew its token in memory (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  const project = credential?.env?.RUBATO_ANTIGRAVITY_PROJECT;
  const read = async (operation, parse) => {
    let lastError;
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const windows = parse(await requestJson(fetchImpl, `${endpoint}/v1internal:${operation}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${access}`,
            "content-type": "application/json",
            "user-agent": "antigravity/hub/1.0.0 (aidev_client; os_type=darwin; arch=arm64)",
          },
          body: JSON.stringify(project ? { project } : {}),
        }, "Antigravity"));
        if (windows.length > 0) return windows;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return [];
  };
  let windows = [];
  try { windows = await read("retrieveUserQuotaSummary", antigravitySummaryWindows); } catch { /* fall back below */ }
  if (windows.length === 0) windows = await read("fetchAvailableModels", antigravityModelWindows);
  return { windows };
}

// ── Collecting ──────────────────────────────────────────────────────────────

/** Providers that report subscription usage, in the order the page lists them. */
export const USAGE_READERS = Object.freeze({
  "openai-codex": readCodex,
  anthropic: readAnthropic,
  cursor: readCursor,
  xai: readGrok,
  "google-antigravity": readAntigravity,
});

/**
 * @param {object} input
 * @param {readonly { id: string, label: string }[]} input.providers
 * @param {(providerId: string) => Promise<readonly { name: string, source: string }[]>} input.accountsOf
 * @param {(providerId: string) => Promise<object | undefined>} input.credentialOf
 * @param {(credential: object | undefined, name: string) => object | undefined} input.slotOf
 * @param {object} input.observed  `readObservedUsage(...)`
 */
export async function collectUsage({
  providers,
  accountsOf,
  credentialOf,
  slotOf,
  observed,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  renewAntigravity = async () => { throw new Error("no renewal configured"); },
}) {
  const jobs = [];
  for (const provider of providers) {
    const reader = USAGE_READERS[provider.id];
    if (!reader) continue;
    const [accounts, credential] = await Promise.all([accountsOf(provider.id), credentialOf(provider.id)]);
    for (const account of accounts) {
      // An account from environment variables is an API key; it has no subscription.
      if (account.source === "env") continue;
      jobs.push((async () => {
        const slot = account.source === "setup-token" ? undefined : slotOf(credential, account.name);
        const checkedAt = new Date(now()).toISOString();
        let result;
        try {
          result = await reader({ slot, account, credential, observed, fetchImpl, now, renewAntigravity });
        } catch (error) {
          return {
            provider: provider.id,
            providerLabel: provider.label,
            account: account.name,
            source: account.source,
            usageLimits: {
              checkedAt,
              windows: [],
              unavailable: { reason: "probeFailed", message: error instanceof Error ? error.message : String(error) },
            },
          };
        }
        if (result.unsupported) return undefined;
        return {
          provider: provider.id,
          providerLabel: provider.label,
          account: account.name,
          source: account.source,
          ...(result.email ? { email: result.email } : {}),
          ...(result.plan ? { plan: result.plan } : {}),
          usageLimits: { checkedAt: result.checkedAt ?? checkedAt, windows: result.windows },
        };
      })());
    }
  }
  return { accounts: (await Promise.all(jobs)).filter(Boolean) };
}
