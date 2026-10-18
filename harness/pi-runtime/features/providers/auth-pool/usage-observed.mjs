// Subscription usage as the provider reported it on real calls, per account.
//
// Anthropic sends the account's quota state on every inference response
// (`anthropic-ratelimit-unified-<claim>-utilization|reset`). That is the only place a
// setup-token account can be read: its token lacks the scope for the usage endpoint, and
// asking with a model call would spend the quota being measured. The credential pool knows
// which account answered, so it records the windows here and `rubato auth usage` reads them.
//
// Windows are stored in the shape the Usage page draws (id, kind, label, usedPercent,
// resetsAt, windowDurationMins), so the reader passes them through without a second mapping.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const USAGE_OBSERVED_FILE = "usage-observed.json";

/** Writes for one account at most this often unless a reset time moved. */
const WRITE_INTERVAL_MS = 30_000;

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

// Same ids as the usage endpoint (`five_hour`, `seven_day`, `seven_day_opus`), so an
// observed window and a read one name the same row.
const CLAIMS = Object.freeze({
  "5h": { id: "five_hour", kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  "7d": { id: "seven_day", kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
});

export function usageObservedPath(authPath) {
  return join(dirname(authPath), USAGE_OBSERVED_FILE);
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function") return [...headers.entries()];
  return Object.entries(headers);
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  return headers?.[name];
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function titleCase(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function claimWindow(claim) {
  const known = CLAIMS[claim];
  if (known) return known;
  // A model-scoped weekly (`7d_opus`) is the usage endpoint's `seven_day_opus`.
  const scoped = /^7d_([a-z0-9]+)$/.exec(claim);
  if (scoped) {
    return { id: `seven_day_${scoped[1]}`, kind: "weekly", label: `Weekly · ${titleCase(scoped[1])}`, windowDurationMins: WEEK_MINS };
  }
  return { id: claim, kind: "other", label: claim };
}

/** The quota windows an Anthropic response carries, or undefined when it carries none. */
export function anthropicUsageWindows(headers) {
  const windows = [];
  for (const [rawName, value] of headerEntries(headers)) {
    const match = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/.exec(String(rawName).toLowerCase());
    if (!match) continue;
    const fraction = Number(value);
    if (!Number.isFinite(fraction)) continue;
    const reset = Number(headerValue(headers, `anthropic-ratelimit-unified-${match[1]}-reset`));
    windows.push({
      ...claimWindow(match[1]),
      usedPercent: clampPercent(fraction * 100),
      ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: new Date(reset * 1000).toISOString() } : {}),
    });
  }
  return windows.length > 0 ? windows.sort((a, b) => a.id.localeCompare(b.id)) : undefined;
}

/** OAuth usage endpoint and inference headers share one window vocabulary. */
export function anthropicEndpointWindows(body) {
  const windows = [];
  for (const [id, value] of Object.entries(body ?? {})) {
    if (!/^five_hour$|^seven_day(?:_[a-z0-9]+)?$/.test(id)) continue;
    if (typeof value?.utilization !== "number" || !Number.isFinite(value.utilization)) continue;
    const claim = id === "five_hour" ? "5h" : id.replace("seven_day", "7d");
    const reset = Date.parse(value.resets_at);
    windows.push({
      ...claimWindow(claim),
      usedPercent: clampPercent(value.utilization),
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
    });
  }
  return windows;
}

const PARSERS = Object.freeze({ anthropic: anthropicUsageWindows });

/** Whether responses from this provider can carry usage worth observing. */
export function observesUsage(providerId) {
  return Object.hasOwn(PARSERS, providerId);
}

export function readObservedUsage(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && value.accounts && typeof value.accounts === "object"
      ? value
      : { version: 1, accounts: {} };
  } catch {
    return { version: 1, accounts: {} };
  }
}

/** One account's last observation, or undefined. */
export function observedAccountUsage(observed, providerId, accountName) {
  const entry = observed?.accounts?.[`${providerId}/${accountName}`];
  return entry && Array.isArray(entry.windows) && entry.windows.length > 0 ? entry : undefined;
}

function resetsOf(windows) {
  return windows.map((window) => `${window.id}@${window.resetsAt ?? ""}:${window.usedPercent >= 100}`).join(",");
}

export function recordObservedUsage(path, providerId, accountName, windows, at = Date.now()) {
  if (!path) return;
  const current = readObservedUsage(path);
  current.version = 1;
  const entry = { provider: providerId, account: accountName, observedAt: new Date(at).toISOString(), windows };
  current.accounts[`${providerId}/${accountName}`] = entry;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${at}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Records what `headers` say about one account. Never throws: observation must not break
 * a call. Concurrent writers from other processes can drop one observation; the next
 * response restores it.
 */
export function createUsageObserver({ path, now = Date.now } = {}) {
  const last = new Map();
  return function observe(providerId, accountName, headers) {
    if (!path || typeof accountName !== "string" || !accountName) return;
    const parse = PARSERS[providerId];
    if (!parse) return;
    let windows;
    try { windows = parse(headers); } catch { return; }
    if (!windows) return;
    const key = `${providerId}/${accountName}`;
    const at = now();
    const previous = last.get(key);
    if (previous && at - previous.at < WRITE_INTERVAL_MS && previous.resets === resetsOf(windows)) return;
    last.set(key, { at, resets: resetsOf(windows) });
    try {
      recordObservedUsage(path, providerId, accountName, windows, at);
    } catch {
      // Observation is best effort.
    }
  };
}
