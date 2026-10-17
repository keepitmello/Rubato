import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  anthropicUsageWindows as observedAnthropicWindows,
  createUsageObserver,
  readObservedUsage,
} from "../pi-runtime/features/providers/auth-pool/usage-observed.mjs";
import {
  anthropicUsageWindows,
  codexUsageWindows,
  collectUsage,
  cursorUsageWindows,
  grokUsageWindows,
} from "./rubato-usage.mjs";
import { usageJson } from "./rubato-auth.mjs";

const scratch = mkdtempSync(join(tmpdir(), "rubato-usage-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-17T18:00:00Z");

// What Anthropic sent with a real reply on a setup-token account (2026-10-17).
const REPLY_HEADERS = {
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.5",
  "anthropic-ratelimit-unified-5h-reset": "1792267200",
  "anthropic-ratelimit-unified-7d-utilization": "0.72",
  "anthropic-ratelimit-unified-7d-reset": "1792404000",
  "anthropic-ratelimit-unified-reset": "1792267200",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
};

test("reply headers become the same windows the usage endpoint names", () => {
  assert.deepEqual(observedAnthropicWindows(new Headers(REPLY_HEADERS)), [
    { id: "five_hour", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 50, resetsAt: "2026-10-17T20:00:00.000Z" },
    { id: "seven_day", kind: "weekly", label: "Weekly", windowDurationMins: 10080, usedPercent: 72, resetsAt: "2026-10-19T10:00:00.000Z" },
  ]);
  assert.equal(observedAnthropicWindows(new Headers({ "content-type": "text/event-stream" })), undefined);
  const scoped = observedAnthropicWindows({ "anthropic-ratelimit-unified-7d_opus-utilization": "0.25" });
  assert.deepEqual(scoped.map((window) => [window.id, window.label, window.usedPercent]), [["seven_day_opus", "Weekly · Opus", 25]]);
});

test("the observer files a reply under its account and skips repeats within the interval", () => {
  const path = join(scratch, "observer", "usage-observed.json");
  let now = NOW;
  const observe = createUsageObserver({ path, now: () => now });
  observe("anthropic", "setup-token", new Headers(REPLY_HEADERS));
  const first = readObservedUsage(path).accounts["anthropic/setup-token"];
  assert.equal(first.observedAt, "2026-10-17T18:00:00.000Z");
  assert.equal(first.windows[0].usedPercent, 50);

  now += 5_000;
  observe("anthropic", "setup-token", new Headers({ ...REPLY_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.6" }));
  assert.equal(readObservedUsage(path).accounts["anthropic/setup-token"].windows[0].usedPercent, 50, "same resets, too soon: no write");

  now += 30_000;
  observe("anthropic", "setup-token", new Headers({ ...REPLY_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.6" }));
  assert.equal(readObservedUsage(path).accounts["anthropic/setup-token"].windows[0].usedPercent, 60);

  observe("anthropic", "login-2", new Headers({ ...REPLY_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.02" }));
  observe("xai", "default", new Headers(REPLY_HEADERS));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).accounts).sort(), ["anthropic/login-2", "anthropic/setup-token"]);
});

test("provider answers map to windows the Usage page draws", () => {
  assert.deepEqual(codexUsageWindows({
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 62, limit_window_seconds: 604800, reset_at: 1792651174 },
      secondary_window: null,
    },
  }), [{ id: "primary", kind: "weekly", label: "Weekly", usedPercent: 62, windowDurationMins: 10080, resetsAt: "2026-10-22T06:39:34.000Z" }]);

  assert.deepEqual(anthropicUsageWindows({
    five_hour: { utilization: 2.0, resets_at: "2026-10-17T20:59:59.830584+00:00" },
    seven_day: { utilization: 13.0, resets_at: "2026-10-22T08:59:59.830604+00:00" },
    seven_day_opus: null,
    tangelo: { utilization: 99 },
  }).map((window) => [window.id, window.usedPercent, window.resetsAt]), [
    ["five_hour", 2, "2026-10-17T20:59:59.830Z"],
    ["seven_day", 13, "2026-10-22T08:59:59.830Z"],
  ]);

  assert.deepEqual(cursorUsageWindows({
    billingCycleEnd: "1794846840000",
    planUsage: { totalPercentUsed: 0.08, autoPercentUsed: 0.06, apiPercentUsed: 0.74 },
  }).map((window) => [window.id, window.label, window.kind]), [
    ["totalPercentUsed", "Overall", "monthly"],
    ["autoPercentUsed", "Cursor Models", "monthly"],
    ["apiPercentUsed", "Other Models", "monthly"],
  ]);

  assert.deepEqual(grokUsageWindows({
    config: { creditUsagePercent: 5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-23T21:06:17.270640+00:00" } },
  }), [{ id: "subscription", kind: "weekly", label: "Weekly", usedPercent: 5, resetsAt: "2026-10-23T21:06:17.270Z" }]);
  assert.deepEqual(grokUsageWindows({ config: {} }), []);
});

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.authorization });
    const route = routes[String(url)];
    if (!route) return new Response("", { status: 404 });
    const { status = 200, body } = typeof route === "function" ? route(init) : route;
    return new Response(JSON.stringify(body ?? {}), { status });
  };
  return { fetchImpl, calls };
}

const PROVIDERS = [
  { id: "openai-codex", label: "Codex" },
  { id: "anthropic", label: "Anthropic" },
  { id: "opengateway", label: "OpenGateway" },
];

test("every account gets its own row; setup-token reads its last reply, failures say why", async () => {
  const credentials = {
    "openai-codex": { type: "oauth", access: "codex-access", refresh: "r", expires: NOW + 3_600_000 },
    anthropic: {
      type: "oauth",
      access: "oauth-a",
      refresh: "r",
      expires: NOW + 3_600_000,
      accounts: [
        { name: "default", source: "login", access: "oauth-a", refresh: "r", expires: NOW + 3_600_000 },
        { name: "login-2", source: "login", access: "oauth-b", refresh: "r", expires: NOW + 3_600_000 },
      ],
    },
    opengateway: { type: "api_key", key: "og" },
  };
  const accounts = {
    "openai-codex": [{ name: "default", source: "login" }],
    anthropic: [
      { name: "default", source: "login" },
      { name: "login-2", source: "login" },
      { name: "setup-token", source: "setup-token" },
      { name: "ANTHROPIC_API_KEY", source: "env" },
    ],
    opengateway: [{ name: "default", source: "login" }],
  };
  const { fetchImpl, calls } = fakeFetch({
    "https://chatgpt.com/backend-api/wham/usage": {
      body: { email: "me@example.com", plan_type: "pro", rate_limit: { primary_window: { used_percent: 62, limit_window_seconds: 604800, reset_at: 1792651174 } } },
    },
    "https://api.anthropic.com/api/oauth/usage": (init) => init.headers.authorization === "Bearer oauth-a"
      ? { body: { five_hour: { utilization: 2, resets_at: "2026-10-17T20:59:59Z" } } }
      : { status: 429 },
  });
  const observed = {
    version: 1,
    accounts: {
      "anthropic/setup-token": { observedAt: "2026-10-17T17:55:00.000Z", windows: observedAnthropicWindows(new Headers(REPLY_HEADERS)) },
    },
  };
  const { accounts: rows } = await collectUsage({
    providers: PROVIDERS,
    accountsOf: async (id) => accounts[id] ?? [],
    credentialOf: async (id) => credentials[id],
    slotOf: (credential, name) => credential?.accounts?.find((slot) => slot.name === name) ?? (name === "default" ? credential : undefined),
    observed,
    fetchImpl,
    now: () => NOW,
  });

  const byAccount = Object.fromEntries(rows.map((row) => [`${row.provider}/${row.account}`, row]));
  assert.deepEqual(Object.keys(byAccount), [
    "openai-codex/default",
    "anthropic/default",
    "anthropic/login-2",
    "anthropic/setup-token",
  ], "an env API key and a provider with no subscription reader get no row");
  assert.equal(byAccount["openai-codex/default"].email, "me@example.com");
  assert.equal(byAccount["openai-codex/default"].plan, "ChatGPT Pro");
  assert.equal(byAccount["anthropic/default"].usageLimits.windows[0].usedPercent, 2);
  assert.equal(byAccount["anthropic/default"].usageLimits.checkedAt, new Date(NOW).toISOString());

  const refused = byAccount["anthropic/login-2"].usageLimits;
  assert.deepEqual(refused.windows, []);
  assert.equal(refused.unavailable.reason, "probeFailed");
  assert.match(refused.unavailable.message, /rate limiting/);

  const setupToken = byAccount["anthropic/setup-token"].usageLimits;
  assert.equal(setupToken.checkedAt, "2026-10-17T17:55:00.000Z", "a reply's reading is as old as the reply");
  assert.deepEqual(setupToken.windows.map((window) => window.usedPercent), [50, 72]);
  assert.equal(calls.filter((call) => call.url.includes("anthropic")).length, 2, "setup-token never calls the usage endpoint");
});

test("an OAuth account whose read fails falls back to its last reply", async () => {
  const { fetchImpl } = fakeFetch({ "https://api.anthropic.com/api/oauth/usage": { status: 429 } });
  const { accounts: rows } = await collectUsage({
    providers: [{ id: "anthropic", label: "Anthropic" }],
    accountsOf: async () => [{ name: "login-2", source: "login" }],
    credentialOf: async () => ({ type: "oauth", accounts: [{ name: "login-2", access: "oauth-b" }] }),
    slotOf: (credential, name) => credential.accounts.find((slot) => slot.name === name),
    observed: { accounts: { "anthropic/login-2": { observedAt: "2026-10-17T17:00:00.000Z", windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 3 }] } } },
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(rows[0].usageLimits.unavailable, undefined);
  assert.equal(rows[0].usageLimits.windows[0].usedPercent, 3);
  assert.equal(rows[0].usageLimits.checkedAt, "2026-10-17T17:00:00.000Z");
});

test("an expired Antigravity token is renewed in memory only", async () => {
  const renewed = [];
  const { fetchImpl, calls } = fakeFetch({
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": {
      body: { groups: [{ buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.75 }] }] },
    },
  });
  const credential = { type: "oauth", access: "stale", refresh: "keep", expires: NOW - 1, env: { RUBATO_ANTIGRAVITY_PROJECT: "p" } };
  const { accounts: rows } = await collectUsage({
    providers: [{ id: "google-antigravity", label: "Antigravity" }],
    accountsOf: async () => [{ name: "default", source: "login" }],
    credentialOf: async () => credential,
    slotOf: (value) => value,
    observed: { accounts: {} },
    fetchImpl,
    now: () => NOW,
    renewAntigravity: async (value) => {
      renewed.push(value.refresh);
      return { access: "fresh" };
    },
  });
  assert.deepEqual(renewed, ["keep"]);
  assert.equal(calls[0].authorization, "Bearer fresh");
  assert.equal(credential.access, "stale", "the stored credential is untouched");
  assert.deepEqual(rows[0].usageLimits.windows.map((window) => [window.id, window.label, window.usedPercent]), [
    ["3p-weekly", "Claude & GPT (shared) · Weekly", 25],
  ]);
});

test("usageJson reads accounts and observations from the agent directory", async () => {
  const home = join(scratch, "home");
  const agentDir = join(home, ".rubato-pi", "agent");
  const observe = createUsageObserver({ path: join(agentDir, "usage-observed.json"), now: () => NOW });
  observe("anthropic", "setup-token", new Headers(REPLY_HEADERS));
  const { fetchImpl } = fakeFetch({});
  const result = await usageJson({
    env: { HOME: home, RUBATO_PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir },
    home,
    credentials: { read: async () => undefined },
  }, {
    providers: [{ id: "anthropic", label: "Anthropic" }],
    accountsOf: async () => [{ name: "setup-token", source: "setup-token" }],
    fetchImpl,
  });
  assert.deepEqual(result.accounts.map((row) => [row.account, row.usageLimits.windows.length]), [["setup-token", 2]]);
});
