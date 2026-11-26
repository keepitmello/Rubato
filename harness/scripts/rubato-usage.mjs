// `rubato auth usage --json` — subscription usage for every connected account.
//
// The Usage page in the GUI draws one row per account, by provider. This reads each
// account with the credential Rubato already holds and maps the answer into the windows
// that page draws: { id, kind, label, usedPercent (0..100), resetsAt?, windowDurationMins? }.
//
// It never renews or writes a credential. Sessions renew tokens while they use them, and
// Codex and Anthropic rotate the refresh token on renewal, so a second writer here could
// strand an account. An account whose token has lapsed reports `probeFailed` until a
// session uses it again. The local agy CLI's Google login is read the same way: its token
// is used as it is, and a lapsed one waits for agy's next run.
//
// Anthropic setup-token accounts cannot call the usage endpoint (their token lacks the
// scope, and the endpoint rate-limits them for an hour). Their windows come from the last
// real call's response headers, which the credential pool records
// (pi-runtime/features/providers/auth-pool/usage-observed.mjs).
import { observedAccountUsage, anthropicEndpointWindows } from "../pi-runtime/features/providers/auth-pool/usage-observed.mjs";
import { geminiDailyWindows, readGeminiRequests } from "../rubato-pi/src/gemini-request-count.mjs";
import { ANTIGRAVITY_USER_AGENT } from "../rubato-pi/src/antigravity-id.mjs";

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

/** `wham/rate-limit-reset-credits` → the passes still usable, soonest expiry first. */
export function codexResetCredits(body) {
  return (Array.isArray(body?.credits) ? body.credits : [])
    .filter((credit) => credit?.status === "available" && credit.is_supported_by_plan !== false)
    .map((credit) => {
      const expiresAt = isoFromText(credit.expires_at);
      return expiresAt ? { expiresAt } : {};
    })
    .sort((left, right) => (left.expiresAt ?? "~").localeCompare(right.expiresAt ?? "~"));
}

async function readCodex({ slot, fetchImpl }) {
  if (!slot?.access) return { unsupported: true };
  const accountId = jwtClaims(slot.access)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  const init = {
    headers: {
      authorization: `Bearer ${slot.access}`,
      "user-agent": "codex_cli_rs",
      ...(typeof accountId === "string" && accountId ? { "chatgpt-account-id": accountId } : {}),
    },
  };
  const body = await requestJson(fetchImpl, "https://chatgpt.com/backend-api/wham/usage", init, "Codex");
  // Reset passes refill the weekly window once it is used up; each expires 30 days after it was granted.
  const count = body?.rate_limit_reset_credits?.available_count;
  let resetCredits;
  if (Number.isInteger(count) && count > 0) {
    try {
      resetCredits = codexResetCredits(await requestJson(fetchImpl, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", init, "Codex"));
    } catch {
      resetCredits = Array.from({ length: count }, () => ({}));
    }
  } else if (Number.isInteger(count)) {
    resetCredits = [];
  }
  return {
    windows: codexUsageWindows(body),
    ...(typeof body?.email === "string" && body.email ? { email: body.email } : {}),
    ...(typeof body?.plan_type === "string" && body.plan_type ? { plan: `ChatGPT ${titleCase(body.plan_type)}` } : {}),
    ...(resetCredits ? { resetCredits } : {}),
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
  const startsAt = isoFromText(body.config.currentPeriod?.start);
  // The period's length lets the Usage page tell the pace and when the quota runs out.
  const windowDurationMins = resetsAt && startsAt
    ? Math.round((Date.parse(resetsAt) - Date.parse(startsAt)) / 60_000)
    : 0;
  return [{
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: clampPercent(used),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins > 0 ? { windowDurationMins } : {}),
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
      // Only the shared pair is plain "Gemini": Pro accounts also get `gemini-argon-wtu-weekly`
      // in a group of its own, which would otherwise draw as a second "Gemini · Weekly".
      const family = /^gemini-(weekly|5h)$/.test(bucket.bucketId) ? "Gemini"
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

async function antigravityWindows({ access, fetchImpl }) {
  const read = async (operation, parse) => {
    let lastError;
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const windows = parse(await requestJson(fetchImpl, `${endpoint}/v1internal:${operation}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${access}`,
            "content-type": "application/json",
            "user-agent": ANTIGRAVITY_USER_AGENT,
          },
          body: "{}",
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
  return windows;
}

/**
 * Gemini quota as the local agy CLI spends it: subagents on `agy/*` run through agy's own
 * Google login (Keychain `gemini`/`antigravity`), not through a Rubato account.
 * `readAgyLogin` resolves `{ access, expiry? }`, or undefined when agy is not signed in.
 */
async function readLocalAgy({ readAgyLogin, fetchImpl, now }) {
  const row = { provider: "google-antigravity", providerLabel: "Antigravity (agy)", account: "agy", source: "agy" };
  const checkedAt = new Date(now()).toISOString();
  const unavailable = (message) => ({ ...row, usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed", message } } });
  let login;
  try {
    login = await readAgyLogin();
  } catch (error) {
    return unavailable(`agy's login could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!login?.access) return undefined;
  const expires = login.expiry ? Date.parse(login.expiry) : Number.NaN;
  if (Number.isFinite(expires) && expires <= now() + 60_000) {
    return unavailable("agy's token has lapsed. It renews the next time agy runs.");
  }
  try {
    return { ...row, usageLimits: { checkedAt, windows: await antigravityWindows({ access: login.access, fetchImpl }) } };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

// ── Gemini API ──────────────────────────────────────────────────────────────

// Gemini API 는 남은 한도를 알려 주지 않는다. 엔진이 요청마다 센 오늘(태평양 시간) 수를
// 무료 등급 하루 한도에 대어 그린다(rubato-pi/src/gemini-request-count.mjs).
async function readGeminiApi({ geminiRequestsPath, now }) {
  const at = now();
  return { plan: "Free tier", windows: geminiDailyWindows(readGeminiRequests(geminiRequestsPath, at), at) };
}

// ── Collecting ──────────────────────────────────────────────────────────────

/** Providers that report subscription usage, in the order the page lists them. */
export const USAGE_READERS = Object.freeze({
  "openai-codex": readCodex,
  anthropic: readAnthropic,
  cursor: readCursor,
  xai: readGrok,
});

/**
 * @param {object} input
 * @param {readonly { id: string, label: string }[]} input.providers
 * @param {(providerId: string) => Promise<readonly { name: string, source: string, modelSuffix?: string | null }[]>} input.accountsOf
 * @param {(providerId: string) => Promise<object | undefined>} input.credentialOf
 * @param {(credential: object | undefined, name: string) => object | undefined} input.slotOf
 * @param {object} input.observed  `readObservedUsage(...)`
 * @param {string} [input.geminiRequestsPath]  where the engine counts Gemini API requests
 * @param {() => Promise<{ access: string, expiry?: string } | undefined>} [input.readAgyLogin]  the local agy CLI's login
 */
export async function collectUsage({
  providers,
  accountsOf,
  credentialOf,
  slotOf,
  observed,
  geminiRequestsPath,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  readAgyLogin = async () => undefined,
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
          result = await reader({ slot, account, credential, observed, geminiRequestsPath, fetchImpl, now });
        } catch (error) {
          return {
            provider: provider.id,
            providerLabel: provider.label,
            account: account.name,
            source: account.source,
            ...lane(account),
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
          ...lane(account),
          ...(result.email ? { email: result.email } : {}),
          ...(result.plan ? { plan: result.plan } : {}),
          ...(result.resetCredits === undefined ? {} : { resetCredits: result.resetCredits }),
          usageLimits: { checkedAt: result.checkedAt ?? checkedAt, windows: result.windows },
        };
      })());
    }
  }
  jobs.push(readLocalAgy({ readAgyLogin, fetchImpl, now }));
  // Within a provider, the main account first, then sub and sub2, as the model picker names them.
  const rows = (await Promise.all(jobs)).filter(Boolean);
  const order = new Map(providers.map((provider, index) => [provider.id, index]));
  const rank = (provider) => order.get(provider) ?? providers.length;
  return {
    accounts: rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => (rank(left.row.provider) - rank(right.row.provider))
        || (laneOrder(left.row.modelSuffix) - laneOrder(right.row.modelSuffix))
        || (left.index - right.index))
      .map(({ row }) => row),
  };
}

/** The model-id suffix of the account's lane: "" is the main account, "-sub" the sub (accounts.mjs). */
function lane(account) {
  return typeof account.modelSuffix === "string" ? { modelSuffix: account.modelSuffix } : {};
}

function laneOrder(modelSuffix) {
  const at = ["", "-sub", "-sub2"].indexOf(modelSuffix);
  return at === -1 ? 3 : at;
}

// ── Text ────────────────────────────────────────────────────────────────────

function localStamp(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

const leftOf = (window) => Math.max(0, Math.round(100 - window.usedPercent));

/**
 * `rubato auth usage`: one line per account saying how much is left, for a person or a lead
 * choosing a model. `collectUsage` reports used percent for the Usage page; this turns it around.
 */
export function formatUsageText({ accounts }, { timeZone } = {}) {
  const laneName = (suffix) => (suffix === "" ? "main" : suffix.replace(/^-/, ""));
  const nameOf = (row) => {
    const label = row.providerLabel ?? row.provider;
    const lanes = accounts.filter((other) => other.provider === row.provider);
    if (typeof row.modelSuffix === "string" && lanes.length > 1) return `${label} ${laneName(row.modelSuffix)}`;
    return lanes.length > 1 ? `${label} ${row.account}` : label;
  };
  const lines = accounts.map((row) => {
    const limits = row.usageLimits ?? {};
    const windows = [...(limits.windows ?? [])].sort((left, right) => (right.kind === "weekly") - (left.kind === "weekly"));
    const parts = windows.map((window) =>
      `${/^\w+$/.test(window.label) ? window.label.toLowerCase() : window.label} ${leftOf(window)}% left${window.resetsAt ? ` (resets ${localStamp(window.resetsAt, timeZone)})` : ""}`);
    if (limits.unavailable) parts.push(`unreadable: ${limits.unavailable.message}`);
    let line = `${nameOf(row)}: ${parts.join(", ") || "no limits reported"}`;
    if (Array.isArray(row.resetCredits) && row.resetCredits.length > 0) {
      const expiries = row.resetCredits.map((credit) => (credit.expiresAt ? localStamp(credit.expiresAt, timeZone) : "unknown"));
      line += ` + ${row.resetCredits.length} reset pass${row.resetCredits.length === 1 ? "" : "es"} of 100% each, used once the week runs out (expire ${expiries.join(", ")})`;
    }
    return line;
  });
  const weekly = new Map();
  for (const row of accounts) {
    const window = row.usageLimits?.windows?.find((entry) => entry.kind === "weekly");
    if (!window) continue;
    const label = row.providerLabel ?? row.provider;
    const total = weekly.get(label) ?? { left: 0, accounts: 0 };
    weekly.set(label, { left: total.left + leftOf(window), accounts: total.accounts + 1 });
  }
  const totals = [...weekly].filter(([, total]) => total.accounts > 1)
    .map(([label, total]) => `${label} weekly, all accounts: ${total.left}% left of ${total.accounts * 100}%`);
  const lanes = accounts.some((row) => row.modelSuffix && row.modelSuffix !== "")
    ? ["sub accounts serve the model ids ending in -sub (anthropic/claude-opus-5-5-sub)."] : [];
  return [...lines, ...(totals.length || lanes.length ? ["", ...totals, ...lanes] : [])].join("\n");
}

/**
 * Compact one-line quota summary across the three default worker providers (Anthropic main/sub,
 * Codex + reset passes, Antigravity Gemini/Neon) for companion heartbeats and session_create
 * results so the companion always sees live room without spending an extra shell turn.
 */
export function formatUsageOneLine({ accounts = [] } = {}, { timeZone } = {}) {
  const stamp = (iso) => (iso ? ` (${localStamp(iso, timeZone)})` : "");
  const parts = [];

  const anthropicRows = accounts.filter((row) => row.provider === "anthropic" && Array.isArray(row.usageLimits?.windows) && row.usageLimits.windows.length > 0);
  if (anthropicRows.length > 0) {
    const lanes = anthropicRows.map((row) => {
      const weekly = row.usageLimits.windows.find((w) => w.kind === "weekly") ?? row.usageLimits.windows[0];
      const name = typeof row.modelSuffix === "string"
        ? (row.modelSuffix === "" ? "main" : row.modelSuffix.replace(/^-/, ""))
        : (row.account || "main");
      return `${name} ${leftOf(weekly)}%${stamp(weekly.resetsAt)}`;
    });
    parts.push(`Anthropic ${lanes.join(" · ")}`);
  }

  const codexRows = accounts.filter((row) => row.provider === "openai-codex" && Array.isArray(row.usageLimits?.windows) && row.usageLimits.windows.length > 0);
  for (const row of codexRows) {
    const weekly = row.usageLimits.windows.find((w) => w.kind === "weekly") ?? row.usageLimits.windows[0];
    let piece = `Codex ${leftOf(weekly)}%${stamp(weekly.resetsAt)}`;
    if (Array.isArray(row.resetCredits) && row.resetCredits.length > 0) {
      const firstExpiry = row.resetCredits[0]?.expiresAt ? ` (${localStamp(row.resetCredits[0].expiresAt, timeZone)})` : "";
      piece += ` +${row.resetCredits.length} pass${row.resetCredits.length === 1 ? "" : "es"}${firstExpiry}`;
    }
    parts.push(piece);
  }

  const agyRows = accounts.filter((row) => row.provider === "antigravity" && Array.isArray(row.usageLimits?.windows) && row.usageLimits.windows.length > 0);
  for (const row of agyRows) {
    const geminiWindows = row.usageLimits.windows.filter((w) => /gemini/i.test(w.label ?? ""));
    const weekly = geminiWindows.find((w) => w.kind === "weekly");
    const session = geminiWindows.find((w) => w.kind !== "weekly");
    const bits = [];
    if (weekly) bits.push(`wk ${leftOf(weekly)}%${stamp(weekly.resetsAt)}`);
    if (session) bits.push(`5h ${leftOf(session)}%`);
    if (bits.length > 0) parts.push(`Neon ${bits.join(" · ")}`);
  }

  return parts.join(" | ");
}
