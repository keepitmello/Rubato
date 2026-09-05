import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { senpiExtensionRunner } from "../../src/engine-paths.mjs";
import {
  appendBrandMark,
  cacheHitPercent,
  cacheStatus,
  formatCacheSegment,
  formatContext,
  formatFooterLatencyMs,
  formatFooterMetrics,
  formatLatency,
  formatLatencyMs,
  formatModelWithEffort,
  formatStatusline,
  formatTokensPerSecond,
  formatWindow,
  currentTurnTiming,
  latestAssistantUsage,
  remainingPercent,
  resolveCachePolicy,
  sessionCacheHitPercent,
  repoBasename,
  shortModelLabel,
  statuslineSegments,
  visibleColumns,
  formatElapsedClock,
  formatBackgroundEntry,
  formatBackgroundLine,
  backgroundEntriesFromEvent,
  layoutStatusLines,
  stripAnsi,
  truncateToWidth,
} from "../../src/statusline.mjs";
import { BRAND_NAME } from "../../src/brand.mjs";
import { installStatusline, extensionStatusLine, canSetFooter, hookExtensionRunnerFooter, ctxFromHostSession, paintStatusLines, registerFooterHost, footerHost, fallbackStatusLines, RUBATO_FOOTER_HOST } from "../../src/extensions/statusline.mjs";
import { createBackgroundTracker } from "../../src/background-tracker.mjs";

function mockSpeedStore({ result, identity } = {}) {
  let active = identity;
  const log = [];
  return {
    log,
    clearActiveIdentity() {
      log.push("clear");
      active = undefined;
    },
    refresh() {
      log.push("refresh");
    },
    getCachedScore(passed) {
      log.push(passed === undefined ? "score" : "score:arg");
      if (typeof result === "function") return result(passed ?? active);
      return result ?? { status: "unavailable", reason: active ? "no_baseline" : "identity", score: undefined };
    },
    activeIdentity() {
      return active;
    },
    setActiveIdentity(next) {
      active = next ? { ...next } : undefined;
    },
  };
}

function paintedFooter(text) {
  return Array.isArray(text) ? text.join("\n") : String(text);
}

function assertNoLegacySpeedMetrics(text) {
  assert.doesNotMatch(paintedFooter(text), /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
}

test("shortens Claude-style model ids the way the statusline does", () => {
  assert.equal(shortModelLabel("claude-opus-4.8"), "Opus 4.8");
  assert.equal(shortModelLabel("anthropic/claude-opus-5:high"), "Opus 5");
  assert.equal(shortModelLabel("anthropic/claude-fable-5-1"), "Fable 5.1");
  assert.equal(shortModelLabel("claude-sonnet-4-6-20251001"), "Sonnet 4.6");
  assert.equal(shortModelLabel("xai/grok-4.6"), "Grok 4.6");
  assert.equal(shortModelLabel("gpt-5.6-sol"), "Sol 5.6");
  assert.equal(shortModelLabel("openai-codex/gpt-5.6-sol"), "Sol 5.6");
  assert.equal(shortModelLabel("gpt-5.6-luna"), "Luna 5.6");
  assert.equal(shortModelLabel("openai-codex/gpt-5.6-luna"), "Luna 5.6");
  assert.equal(shortModelLabel("gpt-5.6-terra"), "Terra 5.6");
  assert.equal(shortModelLabel("openai-codex/gpt-5.6-terra"), "Terra 5.6");
  assert.equal(shortModelLabel("quotio-openai/gpt-5.6-luna-fast"), "Luna 5.6");
  assert.equal(shortModelLabel("openai-codex/gpt-daybreak-blue-latest"), "Daybreak Blue");
  assert.equal(shortModelLabel("openai-codex/gpt-daybreak-blue-latest-fast"), "Daybreak Blue");
  assert.equal(shortModelLabel("openai-codex/gpt-daybreak-blue-latest:high"), "Daybreak Blue");
  assert.equal(shortModelLabel("gpt-6-astra"), "Astra 6");
  assert.equal(shortModelLabel("openai-codex/gpt-6-astra"), "Astra 6");
  assert.equal(shortModelLabel("openai-codex/gpt-6-astra-fast"), "Astra 6");
  assert.equal(shortModelLabel("openai-codex/gpt-6-astra:low"), "Astra 6");
  assert.equal(shortModelLabel("GPT-6 Astra"), "Astra 6");
  assert.equal(shortModelLabel("muse-spark-1.3-contributor-free"), "Muse Spark 1.3");
  assert.equal(shortModelLabel("opencode/muse-spark-1.3-contributor-free"), "Muse Spark 1.3");
  assert.equal(shortModelLabel("opencode/muse-spark-1.3-contributor-free:high"), "Muse Spark 1.3");
  assert.equal(shortModelLabel("Muse Spark 1.3 Free"), "Muse Spark 1.3");
  assert.equal(shortModelLabel("unknown-model:high"), "unknown-model");
});

// Two machines resolve the identical provider/model id but their local catalogs differ in whether
// they carry a friendly display name, so the label arrives as either the id spelling or the
// friendly one. Parent statusline and Task widget must not diverge on that incidental metadata.
test("reads friendly display spellings as the same model as their id spelling", () => {
  assert.equal(shortModelLabel("GPT-5.6 Sol"), "Sol 5.6");
  assert.equal(shortModelLabel("GPT-5.6 Luna"), "Luna 5.6");
  assert.equal(shortModelLabel("GPT-5.6 Terra"), "Terra 5.6");
  assert.equal(shortModelLabel("GPT-5.6 Sol"), shortModelLabel("gpt-5.6-sol"));
  assert.equal(shortModelLabel("GPT-5.6 Luna"), shortModelLabel("openai-codex/gpt-5.6-luna"));
  assert.equal(shortModelLabel("Muse Spark 1.3 Free"), shortModelLabel("muse-spark-1.3-contributor-free"));
  assert.equal(formatModelWithEffort("GPT-5.6 Sol", "high"), "Sol 5.6 high");
  assert.equal(formatModelWithEffort("muse-spark-1.3-contributor-free", "high"), "Muse Spark 1.3 high");
});

test("does not read a variant token that merely prefixes a longer word", () => {
  assert.equal(shortModelLabel("gpt-5.6-solar"), "GPT 5.6");
  assert.equal(shortModelLabel("vendor/gpt-5.6-solar"), "GPT 5.6");
  assert.equal(shortModelLabel("gpt-5.6-lunar"), "GPT 5.6");
});

test("appends reasoning effort next to the short model name", () => {
  assert.equal(formatModelWithEffort("anthropic/claude-opus-5", "high"), "Opus 5 high");
  assert.equal(formatModelWithEffort("xai/grok-4.6", "xhigh"), "Grok 4.6 xhigh");
  assert.equal(
    formatModelWithEffort("xai/grok-4.6", "xhigh", { id: "grok-4.6", provider: "xai", serviceTier: "priority" }),
    "Grok 4.6 xhigh [priority]",
  );
  assert.equal(
    formatModelWithEffort("xai/grok-4.6", "xhigh", { id: "grok-4.6", provider: "xai" }, undefined, true),
    "Grok 4.6 xhigh [priority]",
  );
  assert.equal(
    formatModelWithEffort("openai-codex/gpt-5.6-sol", "high", { provider: "openai-codex" }, undefined, true),
    "Sol 5.6 high",
  );
  assert.equal(formatModelWithEffort("cursor/cursor-grok-4.6", "high"), "Grok 4.6 high [fast]");
  assert.equal(
    formatModelWithEffort("cursor/cursor-grok-4.6", "high", {
      name: "Grok 4.6 Fast",
      compat: { cursorGrokFastByLevel: { high: "cursor-grok-4.6-high-fast" } },
    }),
    "Grok 4.6 high [fast]",
  );
  assert.equal(
    formatModelWithEffort(
      "cursor-grok-4.6",
      "high",
      { id: "cursor-grok-4.6", provider: "cursor", name: "Cursor Grok 4.6" },
      [
        { id: "cursor-grok-4.6", provider: "cursor", name: "Cursor Grok 4.6" },
        { id: "cursor-grok-4.6-high-fast", provider: "cursor", name: "cursor-grok-4.6-high-fast" },
      ],
    ),
    "Grok 4.6 high [fast]",
  );
  assert.equal(
    formatModelWithEffort(
      "cursor-grok-4.6",
      "high",
      { id: "cursor-grok-4.6", provider: "cursor", name: "Cursor Grok 4.6" },
      [{ id: "cursor-grok-4.6", provider: "cursor", name: "Cursor Grok 4.6" }],
    ),
    "Grok 4.6 high [fast]",
  );
  assert.equal(formatModelWithEffort("anthropic/claude-opus-5", "max"), "Opus 5 max");
  assert.equal(formatModelWithEffort("gpt-5.6-sol", "high"), "Sol 5.6 high");
  assert.equal(formatModelWithEffort("openai-codex/gpt-5.6-sol-fast", "medium"), "Sol 5.6 medium [fast]");
  assert.equal(formatModelWithEffort("quotio-openai/gpt-5.6-luna-fast", "high"), "Luna 5.6 high [fast]");
  assert.equal(formatModelWithEffort("openai-codex/gpt-5.6-luna", "high"), "Luna 5.6 high");
  assert.equal(formatModelWithEffort("openai-codex/gpt-5.6-terra", "medium"), "Terra 5.6 medium");
  assert.equal(formatModelWithEffort("anthropic/claude-opus-5:high"), "Opus 5 high");
  assert.equal(formatModelWithEffort("claude-opus-5", "off"), "Opus 5");
});

test("remaining percent is unused context, Claude-style", () => {
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(0.0), 100);
  assert.equal(remainingPercent(40), 60);
  assert.equal(remainingPercent(null), null);
  assert.equal(remainingPercent(undefined), null);
});

test("context window is the active model's max, not a fixed 200K", () => {
  assert.equal(formatWindow(1_000_000), "1M");
  assert.equal(formatWindow(200_000), "200K");
  assert.equal(formatWindow(500_000), "500K");
  assert.equal(formatWindow(372_000), "372K");
  assert.equal(formatContext(60, 1_000_000), "60% (1M)");
  assert.equal(formatContext(100, 200_000), "100% (200K)");
  assert.equal(formatContext(null, 1_000_000), "? (1M)");
});

test("cache percent and lifetime share one segment", () => {
  assert.equal(formatCacheSegment(92, { text: "Cache 40m" }), "Cache 92% (40m)");
  assert.equal(formatCacheSegment(92, { text: "Cache Expired" }), "Cache 92% (Expired)");
  assert.equal(formatCacheSegment(92, { text: "Cache ≥ 29m" }), "Cache 92% (≥ 29m)");
  assert.equal(formatCacheSegment(92, { text: "Cache Miss" }), "Cache 92% (Miss)");
  assert.equal(formatCacheSegment(92, { text: "Cache Hit 1m ago" }), "Cache 92% (Hit 1m ago)");
  assert.equal(formatCacheSegment(92, null), "Cache 92%");
  assert.equal(formatCacheSegment(null, { text: "Cache 4m" }), "Cache 4m");
  assert.equal(formatCacheSegment(null, null), "");
});

test("cache hit percent uses the last prompt, including writes", () => {
  assert.equal(cacheHitPercent({ input: 20, cacheRead: 80, cacheWrite: 0 }), 80);
  assert.equal(cacheHitPercent({ input: 10, cacheRead: 80, cacheWrite: 10 }), 80);
  // 989/1000 = 98.9 — 반올림이면 99, 버림이면 98.
  assert.equal(cacheHitPercent({ input: 11, cacheRead: 989, cacheWrite: 0 }), 99);
  assert.equal(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitPercent(null), null);
});

test("latest assistant usage walks the branch backwards", () => {
  const usage = latestAssistantUsage([
    { type: "message", message: { role: "assistant", usage: { input: 1, cacheRead: 1, cacheWrite: 0 } } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { input: 20, cacheRead: 80, cacheWrite: 0 } } },
  ]);
  assert.deepEqual(usage, { input: 20, cacheRead: 80, cacheWrite: 0 });
  assert.equal(latestAssistantUsage([]), null);
});

test("session cache is the weighted whole-branch total, not latest or unweighted", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 90, cacheRead: 10, cacheWrite: 0 } } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 990, cacheWrite: 0 } } },
  ];
  const latest = cacheHitPercent(latestAssistantUsage(entries));
  const unweighted = Math.round((10 + 99) / 2);
  const weighted = sessionCacheHitPercent(entries);
  assert.equal(latest, 99);
  assert.equal(unweighted, 55);
  // (10+990)/(100+1000) = 90.9 → 91. 마지막 호출 99, 단순평균 55 와 다르다.
  assert.equal(weighted, 91);
  const mutated = [
    ...entries,
    { type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } },
  ];
  assert.equal(sessionCacheHitPercent(mutated), 83);
  assert.notEqual(sessionCacheHitPercent(mutated), weighted);
});

test("session cache ignores negative usage and spans process boundaries", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: -1_000, cacheRead: 100, cacheWrite: -10 },
        timing: { processStartedAt: 41 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, cacheRead: 900, cacheWrite: 0 },
        timing: { processStartedAt: 42 },
      },
    },
  ];
  // 두 프로세스의 유효 usage를 합치되 음수는 0으로 다룬다: 1000 / 1100 = 90.9%.
  assert.equal(sessionCacheHitPercent(entries), 91);
});

test("cache policy distinguishes exact, minimum, and opaque provider guarantees", () => {
  assert.deepEqual(resolveCachePolicy({ provider: "anthropic", api: "openai-completions", id: "claude-opus-5" }), { kind: "sliding", ttlSeconds: 3600 });
  assert.deepEqual(resolveCachePolicy({ provider: "anthropic", api: "claude-sdk-oauth" }), { kind: "sliding", ttlSeconds: 3600 });
  assert.deepEqual(resolveCachePolicy({ provider: "openai", api: "openai-responses", id: "gpt-5.6-sol" }), { kind: "minimum", ttlSeconds: 1800 });
  assert.deepEqual(resolveCachePolicy({ provider: "openai-codex", api: "openai-codex-responses" }), { kind: "opaque" });
  assert.deepEqual(resolveCachePolicy({ provider: "google-antigravity", api: "openai-completions", id: "gemini-3.8-flash" }), { kind: "opaque" });
  assert.deepEqual(resolveCachePolicy({ provider: "xai", api: "openai-completions", id: "xai/grok-4.6" }), { kind: "opaque" });
});

test("cache policy never derives provider TTL from a configurable safe-wait budget", () => {
  const brokerClaude = { provider: "anthropic", api: "openai-completions", id: "claude-opus-5" };
  assert.deepEqual(resolveCachePolicy(brokerClaude, 3300), { kind: "sliding", ttlSeconds: 3600 });
  assert.deepEqual(resolveCachePolicy(brokerClaude, undefined), { kind: "sliding", ttlSeconds: 3600 });
});

test("cache status uses cache-bearing request start and never calls opaque retention expired", () => {
  const entries = [
    { type: "message", message: { role: "assistant", timestamp: 1_000, usage: { cacheRead: 10 }, timing: { sentAt: 1_000 } } },
    { type: "message", message: { role: "user", timestamp: 2_000 } },
    { type: "message", message: { role: "assistant", timestamp: 20_000, usage: { cacheRead: 20 }, timing: { sentAt: 10_000 } } },
  ];
  assert.deepEqual(cacheStatus(entries, { kind: "sliding", ttlSeconds: 300 }, 70_000), { text: "Cache 4m", ticking: true, expired: false });
  assert.deepEqual(cacheStatus(entries, { kind: "sliding", ttlSeconds: 300 }, 310_000), { text: "Cache Expired", ticking: false, expired: true });
  assert.deepEqual(cacheStatus(entries, { kind: "minimum", ttlSeconds: 1800 }, 70_000), { text: "Cache ≥ 29m", ticking: true, expired: false });
  assert.deepEqual(cacheStatus(entries, { kind: "minimum", ttlSeconds: 1800 }, 1_900_000), { text: "Cache Unknown", ticking: false, expired: false });
  assert.equal(cacheStatus(entries, { kind: "opaque" }, 70_000), null);
  assert.equal(cacheStatus([], { kind: "opaque" }, 70_000), null);
});

test("opaque cache with no read or write is unknown, not a miss", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 1_000,
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
        timing: { sentAt: 1_000 },
      },
    },
  ];
  assert.equal(cacheStatus(entries, { kind: "opaque" }, 70_000), null);
  assert.equal(sessionCacheHitPercent(entries), null);
  assert.equal(cacheHitPercent({ input: 20_000, cacheRead: 0, cacheWrite: 0 }), 0);
});

test("turn timing skips stale and malformed persisted entries", () => {
  const timing = currentTurnTiming([
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 100, modelDurationMs: 200 } } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 300, modelDurationMs: 900 } } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: NaN } } },
    { type: "message", message: { role: "assistant", timing: {} } },
  ], 42);
  // waitMs 가 없던 예전 엔트리는 가장 최근 ttft 로 떨어진다.
  assert.deepEqual(timing, { waitMs: 300, calls: 1 });
  assert.equal(currentTurnTiming([
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 41, ttftMs: 500 } } },
  ], 42), null);
  assert.equal(currentTurnTiming([], 42), null);
});

test("turn timing still uses wait and duration when ttft is missing", () => {
  const timing = currentTurnTiming([
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 20 },
        timing: { processStartedAt: 42, waitMs: 1_200, thinkMs: 4_000, modelDurationMs: 2_000 },
      },
    },
  ], 42);
  assert.equal(timing.waitMs, 1_200);
  assert.equal(timing.thinkMs, 4_000);
  assert.equal(timing.tokensPerSecond, 10);
  assert.equal(formatLatency(timing), "delay 1s · think 4s");
});

test("a previous process's persisted turn never renders as the current one", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 41, ttftMs: 900, waitMs: 900, thinkMs: 5_000 } } },
  ];
  assert.equal(currentTurnTiming(entries, 42), null);
  assert.equal(formatLatency(currentTurnTiming(entries, 42)), "");
});

test("the turn average is the mean of its calls, not the last call", () => {
  const timing = currentTurnTiming([
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 1_000, waitMs: 1_000, thinkMs: 6_000 } } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 2_000, waitMs: 2_000, thinkMs: 2_000 } } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 600, waitMs: 600 } } },
  ], 42);
  assert.equal(timing.calls, 3);
  assert.equal(timing.waitMs, 1_200);
  // 사고 없는 세 번째 호출은 think 평균을 끌어내리지 않는다.
  assert.equal(timing.thinkMs, 4_000);
  assert.equal(formatLatency(timing), "delay 1s · think 4s");
});

test("a new user message resets the turn average", () => {
  const previous = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 8_000, waitMs: 8_000, thinkMs: 9_000 } } },
  ];
  assert.equal(formatLatency(currentTurnTiming(previous, 42)), "delay 8s · think 9s");
  const next = [
    ...previous,
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 400, waitMs: 400 } } },
  ];
  const timing = currentTurnTiming(next, 42);
  assert.equal(timing.calls, 1);
  assert.equal(timing.waitMs, 400);
  assert.equal(timing.thinkMs, undefined);
  assert.equal(formatLatency(timing), "delay 400ms");
});

test("latency milliseconds render as ms under a second, seconds above it", () => {
  assert.equal(formatLatencyMs(340), "340ms");
  assert.equal(formatLatencyMs(999), "999ms");
  assert.equal(formatLatencyMs(1000), "1.0s");
  assert.equal(formatLatencyMs(3420), "3.4s");
  assert.equal(formatLatencyMs(undefined), "");
  assert.equal(formatLatencyMs(null), "");
  assert.equal(formatLatencyMs(-1), "");
  assert.equal(formatLatencyMs(NaN), "");
  assert.equal(formatLatencyMs(Number.MAX_VALUE), "");
});

test("footer latency rounds seconds and keeps integer milliseconds under a second", () => {
  assert.equal(formatFooterLatencyMs(340), "340ms");
  assert.equal(formatFooterLatencyMs(999), "999ms");
  assert.equal(formatFooterLatencyMs(1000), "1s");
  assert.equal(formatFooterLatencyMs(1499), "1s");
  assert.equal(formatFooterLatencyMs(1500), "2s");
  assert.equal(formatFooterLatencyMs(4600), "5s");
  assert.equal(formatFooterLatencyMs(undefined), "");
});

test("the latency footer segment shows wait and thinking but never raw turn duration", () => {
  assert.equal(formatLatency({ waitMs: 1_200, thinkMs: 4_000 }), "delay 1s · think 4s");
  assert.equal(formatLatency({ waitMs: 4_600, thinkMs: 10_400 }), "delay 5s · think 10s");
  assert.equal(formatLatency({ waitMs: 420, modelDurationMs: 3400 }), "delay 420ms");
  // 사고가 없으면 think 자체를 그리지 않는다. `think 0ms` 는 쓰지 않는다.
  assert.equal(formatLatency({ waitMs: 420, thinkMs: 0 }), "delay 420ms");
  assert.equal(formatLatency({ modelDurationMs: 1200 }), "");
  assert.equal(formatLatency({ ttftMs: 200 }), "delay 200ms");
  assert.equal(formatLatency({}), "");
  assert.equal(formatLatency(null), "");
});

test("statusline order is model, remaining, metrics, branch, repo", () => {
  assert.equal(repoBasename("/Users/wy/Github-repos/agent-taskforce"), "agent-taskforce");
  assert.equal(
    formatStatusline({
      model: "Opus 5 high",
      remaining: 60,
      window: 1_000_000,
      branch: "main",
      repo: "agent-taskforce",
      cache: 98,
      speed: { status: "ready", score: 17 },
    }),
    "✦ Opus 5 high · 60% (1M) · Cache 98% · main · agent-taskforce · Speed 17",
  );
  assert.deepEqual(
    statuslineSegments({
      model: "Sol 5.6 high",
      remaining: 100,
      window: 372_000,
      branch: "main",
      repo: "agent-taskforce",
    }),
    ["✦ Sol 5.6 high", "100% (372K)", "main", "agent-taskforce", "Speed —"],
  );
});

test("installStatusline paints effort and the model context window", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 20, cacheRead: 80, cacheWrite: 0 },
          },
        },
      ],
    },
    ui: {
      setFooter(next) {
        factory = next;
      },
    },
  };
  const pi = {
    on(event, handler) {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    },
  };

  installStatusline(pi);
  assert.equal(typeof factory, "function");

  const colors = [];
  const footer = factory(
    { requestRender() {} },
    {
      fg(color, text) {
        colors.push(color);
        return text;
      },
    },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  // Cache stays with identity. Speed 만 좁으면 둘째 줄로 내린다.
  const identity = "✦ Opus 5 high · 60% (1M) · Cache 80% · main · agent-taskforce";
  const left = `${identity} · Speed —`;
  assert.deepEqual(footer.render(120), [appendBrandMark(left, 120)]);
  assert.match(footer.render(120)[0], new RegExp(`${BRAND_NAME}$`));
  assert.equal(visibleColumns(footer.render(120)[0]), 120);
  const tight = footer.render(70);
  assert.equal(tight[0], identity);
  assert.match(tight[1], /^Speed —$/);
  assert.ok(!tight[0].includes(BRAND_NAME));
  assert.doesNotMatch(tight.join("\n"), /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
  assert.ok(colors.includes("accent"));
  assert.ok(colors.includes("text"));
  assert.ok(colors.includes("dim"));
});

test("a restored Cursor Grok session reads Fast from the catalog, not the picker object", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "cursor-grok-4.6", provider: "cursor", name: "Cursor Grok 4.6", contextWindow: 200_000 },
    thinkingLevel: "high",
    modelRegistry: {
      getAll: () => [
        { id: "cursor-grok-4.6", provider: "cursor", name: "Cursor Grok 4.6" },
        { id: "cursor-grok-4.6-high-fast", provider: "cursor", name: "cursor-grok-4.6-high-fast" },
      ],
    },
    getContextUsage: () => ({ tokens: 40_000, contextWindow: 200_000, percent: 20 }),
    sessionManager: { getBranch: () => [] },
    ui: { setFooter(next) { factory = next; } },
  };
  const pi = {
    on(event, handler) {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    },
  };
  installStatusline(pi);
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  const line = footer.render(120)[0];
  assert.match(line, /Grok 4\.6 high \[fast\]/);
  assert.doesNotMatch(line, /Cache /);
});

test("the footer merges cache percent and remaining lifetime into one segment", () => {
  let factory;
  const sentAt = Date.now() - 1_000;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", provider: "anthropic", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 20, cacheRead: 80, cacheWrite: 0 },
            timing: { sentAt, processStartedAt: 42, ttftMs: 400 },
          },
        },
      ],
    },
    ui: { setFooter(next) { factory = next; } },
  };
  const pi = {
    on(event, handler) {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    },
  };
  installStatusline(pi, { processStartedAt: 42 });
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  const rendered = footer.render(160)[0];
  assert.match(rendered, /Cache 80% \(60m\)/);
  assert.equal(rendered.includes("Cache 80% · Cache"), false, rendered);
});

test("the footer averages wait and thinking across the current turn's model calls", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: {
      getBranch: () => [
        // 이전 턴 — 평균에 섞이면 안 된다.
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 9_000, waitMs: 9_000, thinkMs: 9_000 } } },
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", timing: { processStartedAt: 42, ttftMs: 1_000, waitMs: 1_000, thinkMs: 6_000 } } },
        { type: "message", message: { role: "tool" } },
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 20, cacheRead: 80, cacheWrite: 0 },
            timing: { processStartedAt: 42, ttftMs: 1_400, waitMs: 1_400, thinkMs: 2_000 },
          },
        },
      ],
    },
    ui: { setFooter(next) { factory = next; } },
  };
  const pi = {
    on(event, handler) {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    },
  };
  installStatusline(pi, { processStartedAt: 42 });
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  const rendered = footer.render(160)[0];
  assert.match(rendered, /Cache 80%/);
  assert.match(rendered, /Speed —/);
  assert.doesNotMatch(rendered, /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
});

test("the footer shows current-process ttft without rendering raw turn duration", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 20, cacheRead: 80, cacheWrite: 0 },
            timing: { sentAt: 1_700_000_000_000, processStartedAt: 42, ttftMs: 420, modelDurationMs: 3400 },
          },
        },
      ],
    },
    ui: {
      setFooter(next) {
        factory = next;
      },
    },
  };
  const pi = {
    on(event, handler) {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    },
  };

  installStatusline(pi, { processStartedAt: 42 });
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  const rendered = footer.render(140)[0];
  assert.match(rendered, /^✦ Opus 5 high · 60% \(1M\) · Cache 80% · main · agent-taskforce/);
  assert.match(rendered, /Speed —/);
  assert.doesNotMatch(rendered, /delay 420ms|tok\/s|\bTPS\b|\bthink\b/);
  assert.equal(rendered.includes("turn"), false);
});

test("footer metrics use integer rounding and omit unavailable pieces", () => {
  assert.equal(formatTokensPerSecond(17.5), "18 tok/s");
  assert.equal(formatTokensPerSecond(17.4), "17 tok/s");
  assert.equal(formatTokensPerSecond(0), "0 tok/s");
  assert.equal(formatTokensPerSecond(undefined), "");
  assert.equal(formatTokensPerSecond(NaN), "");
  assert.equal(formatFooterMetrics({ speed: { status: "ready", score: 18 } }), "Speed 18");
  // `~N` is retired: a score is a score, whatever the sample count.
  assert.equal(formatFooterMetrics({ speed: { status: "ready", score: 100 } }), "Speed 100");
  assert.equal(formatFooterMetrics({ speed: { status: "unavailable", reason: "no_baseline" } }), "Speed —");
  assert.equal(formatFooterMetrics({}), "Speed —");
  assert.equal(formatCacheSegment(92, { text: "Cache Expired" }), "Cache 92% (Expired)");
  assert.equal(formatCacheSegment(98, null), "Cache 98%");
  assert.equal(formatLatency({ waitMs: 400 }), "delay 400ms");
  assert.equal(formatLatency({ waitMs: 400, thinkMs: 0 }), "delay 400ms");
});

test("TPS is the current turn's summed output over positive modelDurationMs", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 10 },
        timing: { processStartedAt: 42, ttftMs: 100, waitMs: 100, modelDurationMs: 1_000 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 25 },
        timing: { processStartedAt: 42, ttftMs: 100, waitMs: 100, modelDurationMs: 1_000 },
      },
    },
  ];
  const timing = currentTurnTiming(entries, 42);
  // 합: 35 tok / 2s = 17.5. 마지막 호출만이면 25, 비가중 평균이면 (10+25)/2 = 17.5 와 같지만
  // 지속시간이 다른 호출을 넣으면 갈라진다.
  assert.equal(timing.tokensPerSecond, 17.5);
  const unequal = [
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 10 },
        timing: { processStartedAt: 42, ttftMs: 100, waitMs: 100, modelDurationMs: 500 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 25 },
        timing: { processStartedAt: 42, ttftMs: 100, waitMs: 100, modelDurationMs: 1_500 },
      },
    },
  ];
  const unequalTiming = currentTurnTiming(unequal, 42);
  assert.equal(unequalTiming.tokensPerSecond, 17.5);
  const lastOnly = 25 / 1.5;
  const unweighted = (10 / 0.5 + 25 / 1.5) / 2;
  assert.notEqual(unequalTiming.tokensPerSecond, lastOnly);
  assert.notEqual(unequalTiming.tokensPerSecond, unweighted);
  const missingDuration = [
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 40 },
        timing: { processStartedAt: 42, ttftMs: 200, waitMs: 200 },
      },
    },
  ];
  const omitted = currentTurnTiming(missingDuration, 42);
  assert.equal(omitted.tokensPerSecond, undefined);
  assert.equal(formatLatency(omitted), "delay 200ms");
  assert.equal(formatFooterMetrics({}), "Speed —");
});

test("a previous process's timing does not count toward live TPS", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 200 },
        timing: { processStartedAt: 41, ttftMs: 100, waitMs: 100, modelDurationMs: 1_000 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 17 },
        timing: { processStartedAt: 42, ttftMs: 100, waitMs: 100, modelDurationMs: 1_000 },
      },
    },
  ];
  const timing = currentTurnTiming(entries, 42);
  // 일부 호출만 현재 프로세스 timing을 가지면 부분 표본 TPS를 만들지 않는다.
  assert.equal(timing.tokensPerSecond, undefined);
  assert.equal(formatTokensPerSecond(timing.tokensPerSecond), "");
});

test("a mixed timed and untimed turn omits partial footer TPS", () => {
  const timing = currentTurnTiming([
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 100 },
        timing: { processStartedAt: 42, ttftMs: 100, waitMs: 100, modelDurationMs: 2_000 },
      },
    },
    { type: "message", message: { role: "assistant", usage: { output: 5_000 } } },
  ], 42);
  assert.equal(timing.tokensPerSecond, undefined);
  assert.equal(formatLatency(timing), "delay 100ms");
});

test("negative output is ignored and missing usage still leaves latency visible", () => {
  const timing = currentTurnTiming([
    { type: "message", message: { role: "user" } },
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { output: -500 },
        timing: { processStartedAt: 42, ttftMs: 200, waitMs: 200, modelDurationMs: 1_000 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timing: { processStartedAt: 42, ttftMs: 400, waitMs: 400, thinkMs: 2_000, modelDurationMs: 1_000 },
      },
    },
  ], 42);
  assert.equal(timing.tokensPerSecond, undefined);
  assert.equal(formatLatency(timing), "delay 300ms · think 2s");
});

test("truncation keeps ANSI so a tight width does not bleach the line", () => {
  const painted = `\x1b[38;2;122;162;247m✦ Opus 5\x1b[0m · 60% (1M) · main`;
  const clipped = truncateToWidth(painted, 12);
  assert.match(clipped, /\x1b\[38;2;122;162;247m/);
  assert.equal(visibleColumns(clipped), 12);
  assert.ok(clipped.endsWith("\x1b[0m"));
  assert.notEqual(stripAnsi(clipped), clipped);
});

test("a tight width moves Speed onto a second line", () => {
  const identity = "✦ Opus 5 high · 60% (1M) · Cache 80% · main · agent-taskforce";
  const metrics = "Speed 17";
  const wide = layoutStatusLines(identity, metrics, 160);
  assert.equal(wide.length, 1);
  assert.match(wide[0], /Speed 17/);
  const tight = layoutStatusLines(identity, metrics, 70);
  assert.equal(tight.length, 2);
  assert.equal(stripAnsi(tight[0]).includes("Speed 17"), false, tight[0]);
  assert.match(tight[1], /Speed 17/);
  assert.doesNotMatch(tight.join("\n"), /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
});

test("metrics stay visible when a tight width clips branch and repo", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "user",
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 20, cacheRead: 80, cacheWrite: 0, output: 17 },
            timing: {
              processStartedAt: 42,
              ttftMs: 4_000,
              waitMs: 4_000,
              thinkMs: 10_000,
              modelDurationMs: 1_000,
            },
          },
        },
      ],
    },
    ui: { setFooter(next) { factory = next; } },
  };
  const pi = {
    on(event, handler) {
      if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
    },
  };
  installStatusline(pi, { processStartedAt: 42 });
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  const wide = footer.render(160);
  assert.equal(wide.length, 1);
  assert.match(wide[0], /Cache 80%/);
  assert.match(wide[0], /Speed —/);
  assert.match(wide[0], /main · agent-taskforce/);
  assert.doesNotMatch(wide[0], /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
  const tight = footer.render(70);
  assert.equal(tight.length, 2, tight.join("\n"));
  assert.match(tight[0], /Cache 80%/);
  assert.match(tight[0], /agent-taskforce/);
  assert.equal(tight[0].includes("Speed"), false, tight[0]);
  assert.match(tight[1], /Speed —/);
  assert.doesNotMatch(tight.join("\n"), /tok\/s|\bTPS\b|\bdelay\b|\bthink\b/);
});

test("the brand mark sits on the right only when the terminal is wide", () => {
  const left = "✦ Opus 5 high · 60% (1M)";
  assert.equal(appendBrandMark(left, 40), left);
  const wide = appendBrandMark(left, 80);
  assert.match(wide, new RegExp(`${BRAND_NAME}$`));
  assert.equal(visibleColumns(wide), 80);
  assert.ok(wide.startsWith(left));
  assert.ok(wide.includes(" "));
});

test("elapsed time is a clock, not a relative age", () => {
  const start = 1_000_000;
  assert.equal(formatElapsedClock(start, start), "00:00");
  assert.equal(formatElapsedClock(start, start + 44_000), "00:44");
  assert.equal(formatElapsedClock(start, start + 344_000), "05:44");
  assert.equal(formatElapsedClock(start, start + 3_944_000), "1:05:44");
  // A clock that ran backwards must not print a negative time.
  assert.equal(formatElapsedClock(start, start - 5_000), "00:00");
  assert.equal(formatElapsedClock(undefined, start), "");
});

test("each background source is unpacked from its own payload field", () => {
  assert.deepEqual(
    backgroundEntriesFromEvent({
      source: "terminal-background-sessions",
      items: [{ id: "bash_1", description: "build", startedAtMs: 7 }],
    }),
    { source: "terminal-background-sessions", entries: [{ id: "bash_1", description: "build", startedAtMs: 7 }] },
  );
  assert.deepEqual(
    backgroundEntriesFromEvent({
      source: "terminal-monitors",
      monitors: [{ id: "mon_1", description: "watch", startedAtMs: 9 }],
    }),
    { source: "terminal-monitors", entries: [{ id: "mon_1", description: "watch", startedAtMs: 9 }] },
  );
  // Subagents belong to the widget, not the footer.
  assert.equal(backgroundEntriesFromEvent({
    source: "senpi-task",
    channels: [{ id: "st_1", description: "reviewer", startedAtMs: 5 }],
  }), null);
  // A source we do not render must not be mistaken for an empty snapshot of one we do.
  assert.equal(backgroundEntriesFromEvent({ source: "something-else", items: [] }), null);
});

test("a background entry shows its model only when one is known", () => {
  const now = 344_000;
  assert.equal(
    formatBackgroundEntry({ description: "reviewer", startedAtMs: 0, model: "anthropic/claude-opus-5" }, now),
    "reviewer Opus 5 05:44",
  );
  assert.equal(formatBackgroundEntry({ description: "build", startedAtMs: 0 }, now), "build 05:44");
});

test("the background line groups sources and folds overflow into a count", () => {
  const groups = new Map([
    ["senpi-task", [
      { id: "a", description: "reviewer", startedAtMs: 0, model: "anthropic/claude-opus-5" },
      { id: "b", description: "builder", startedAtMs: 152_000, model: "xai/grok-4.6" },
    ]],
    ["terminal-background-sessions", [{ id: "bash_1", description: "build", startedAtMs: 254_000 }]],
    ["terminal-monitors", [{ id: "mon_1", description: "watch", startedAtMs: 164_000 }]],
  ]);
  assert.equal(
    formatBackgroundLine(groups, 344_000, 200),
    "⌘ build 01:30   ◉ watch 03:00",
  );
  // Too narrow to name everyone: the count survives even when the names do not.
  assert.equal(formatBackgroundLine(groups, 344_000, 12), "⌘ +1   ◉ +1");
  assert.equal(formatBackgroundLine(new Map(), 344_000, 200), "");
});

test("the tracker redraws on change and stays quiet on a repeat", () => {
  const tracker = createBackgroundTracker();
  const event = { source: "terminal-background-sessions", items: [{ id: "bash_1", description: "build", startedAtMs: 5 }] };
  assert.equal(tracker.accept(event), true);
  assert.equal(tracker.accept({ ...event }), false, "an identical snapshot must not force a render");
  assert.equal(tracker.active(), true);
  assert.equal(tracker.accept({ source: "terminal-background-sessions", items: [] }), true);
  assert.equal(tracker.active(), false, "an empty snapshot must let the ticker stop");
  assert.equal(tracker.accept({ source: "senpi-task", channels: [{ id: "st_1", description: "reviewer", startedAtMs: 5 }] }), false);
  assert.equal(tracker.accept({ source: "unrelated", items: [] }), false);
});

test("the memory backlog line is dropped from the footer", () => {
  const statuses = new Map([
    ["memory", "mem:agent-taskforce-a686370c 1h ago (+26)"],
    ["monitors", "◉ watching 2: build, tests (3m)"],
    ["  rubato-native", "rubato-native"],
  ]);
  const line = extensionStatusLine(statuses);
  assert.ok(!line.includes("mem:"), "the reflection backlog is noise, not status");
  assert.ok(line.includes("watching 2"));
  assert.equal(line, "rubato-native · ◉ watching 2: build, tests (3m)");
  assert.equal(extensionStatusLine(new Map()), "");
  assert.equal(extensionStatusLine(undefined), "");
});


test("the footer Speed segment follows store status, including a dash before any matched call", () => {
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: { getBranch: () => [] },
    ui: {},
  };
  const cases = [
    [{ status: "unavailable", reason: "no_baseline", score: undefined }, /Speed —/],
    [{ status: "unavailable", reason: "samples", score: undefined }, /Speed —/],
    [{ status: "ready", score: 87, matched: 1 }, /Speed 87/],
    [{ status: "ready", score: 112 }, /Speed 112/],
  ];
  for (const [result, pattern] of cases) {
    let factory;
    ctx.ui = { setFooter(next) { factory = next; } };
    const store = mockSpeedStore({ result, identity: { provider: "anthropic", model: "claude-opus-5", effort: "high" } });
    const pi = { on(event, handler) { if (event === "session_start") handler({}, ctx); } };
    installStatusline(pi, { speedStore: store });
    const footer = factory(
      { requestRender() {} },
      { fg: (_color, text) => text },
      { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
    );
    const rendered = footer.render(160);
    assert.match(paintedFooter(rendered), pattern);
    assertNoLegacySpeedMetrics(rendered);
  }
});

test("session lifecycle clears identity and only refresh/score hit the store from the footer", () => {
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "low",
    getContextUsage: () => ({ tokens: 400_000, contextWindow: 1_000_000, percent: 40 }),
    sessionManager: { getBranch: () => [] },
    ui: {},
  };
  const store = mockSpeedStore({
    identity: { provider: "anthropic", model: "claude-opus-5", effort: "high" },
    result: (identity) => identity
      ? { status: "ready", score: 42 }
      : { status: "unavailable", reason: "identity", score: undefined },
  });
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  let factory;
  ctx.ui = { setFooter(next) { factory = next; } };
  installStatusline(pi, { speedStore: store });
  assert.deepEqual([...handlers.keys()], ["session_before_switch", "model_select", "agent_end", "session_start", "before_agent_start"]);
  for (const handler of handlers.get("session_start")) handler({ type: "session_start" }, ctx);
  assert.equal(store.activeIdentity(), undefined);
  assert.ok(store.log.filter((e) => e === "clear").length >= 1);
  assert.ok(store.log.includes("refresh"));
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  store.log.length = 0;
  const dash = footer.render(160);
  assert.match(paintedFooter(dash), /Speed —/);
  assert.deepEqual(store.log, ["score"]);
  store.setActiveIdentity({ provider: "anthropic", model: "claude-opus-5", effort: "high" });
  store.log.length = 0;
  for (const handler of handlers.get("model_select")) handler({ type: "model_select" }, ctx);
  assert.equal(store.activeIdentity(), undefined);
  assert.deepEqual(store.log, ["clear"]);
  store.setActiveIdentity({ provider: "anthropic", model: "claude-opus-5", effort: "high" });
  store.log.length = 0;
  for (const handler of handlers.get("session_before_switch")) handler({}, ctx);
  assert.equal(store.activeIdentity(), undefined);
  assert.deepEqual(store.log, ["clear"]);
  store.log.length = 0;
  for (const handler of handlers.get("agent_end")) handler({}, ctx);
  assert.deepEqual(store.log, ["refresh"]);
  assertNoLegacySpeedMetrics(dash);
});

test("the footer does not derive Speed identity from UI effort", () => {
  let captured;
  const store = mockSpeedStore({
    identity: { provider: "anthropic", model: "claude-opus-5", effort: "high" },
    result(identity) {
      captured = identity;
      if (!identity) return { status: "unavailable", reason: "identity", score: undefined };
      return { status: "ready", score: 55 };
    },
  });
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "low",
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_000_000, percent: 1 }),
    sessionManager: { getBranch: () => [] },
    ui: {},
  };
  let factory;
  ctx.ui = { setFooter(next) { factory = next; } };
  const pi = { on(event, handler) { if (event === "session_start") handler({}, ctx); } };
  installStatusline(pi, { speedStore: store });
  const footer = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  );
  // session_start cleared identity; render must not invent one from thinkingLevel.
  const rendered = footer.render(120);
  assert.equal(captured, undefined);
  assert.match(paintedFooter(rendered), /Speed —/);
  store.setActiveIdentity({ provider: "anthropic", model: "claude-opus-5", effort: "high" });
  const ready = footer.render(120);
  assert.deepEqual(captured, { provider: "anthropic", model: "claude-opus-5", effort: "high" });
  assert.notEqual(captured.effort, ctx.thinkingLevel);
  assert.match(paintedFooter(ready), /Speed 55/);
  assertNoLegacySpeedMetrics(ready);
});

test("canSetFooter rejects a no-op host and accepts a live setFooter", () => {
  assert.equal(canSetFooter({}), false);
  assert.equal(canSetFooter({ ui: {} }), false);
  assert.equal(canSetFooter({ ui: { setFooter() {} }, hasUI: false }), false);
  assert.equal(canSetFooter({ ui: { setFooter() {} } }), true);
  assert.equal(canSetFooter({ ui: { setFooter() {} }, hasUI: true }), true);
});

test("before_agent_start paints the custom footer if session_start ran without UI", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 1, contextWindow: 1_000_000, percent: 0 }),
    sessionManager: { getBranch: () => [] },
    ui: {},
  };
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  installStatusline(pi, { speedStore: mockSpeedStore() });
  handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(factory, undefined);
  ctx.ui = { setFooter(next) { factory = next; } };
  handlers.get("before_agent_start")({}, ctx);
  assert.equal(typeof factory, "function");
  const line = factory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
  ).render(160)[0];
  assert.match(line, /^✦ Opus 5 high/);
  assert.doesNotMatch(line, /\$0\.000|\(sub\)|\(auto\)/);
});

test("reload keeps live Speed samples; new sessions still reset", () => {
  const events = [];
  const store = {
    resetSession() { events.push("reset"); },
    clearActiveIdentity() { events.push("clear"); },
    refresh() { events.push("refresh"); },
    startProbes() { events.push("probes"); },
    getCachedScore: () => ({ status: "ready", score: 120 }),
  };
  const handlers = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    events: { on() {}, off() {} },
  };
  installStatusline(pi, { speedStore: store });
  assert.deepEqual(events, ["probes"]);
  events.length = 0;
  handlers.get("session_start")({ type: "session_start", reason: "reload" }, { ui: { setFooter() {} } });
  assert.deepEqual(events, ["refresh"]);
  events.length = 0;
  handlers.get("session_start")({ type: "session_start", reason: "new" }, { ui: { setFooter() {} } });
  assert.deepEqual(events, ["reset", "refresh"]);
});

test("hookExtensionRunnerFooter applies as soon as the host binds a live UI", () => {
  let factory;
  const ctx = {
    cwd: "/Users/wy/Github-repos/agent-taskforce",
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 1, contextWindow: 1_000_000, percent: 0 }),
    sessionManager: { getBranch: () => [] },
    ui: { setFooter(next) { factory = next; } },
    hasUI: true,
  };
  const installed = installStatusline({
    on() {},
  }, { speedStore: mockSpeedStore() });
  class FakeRunner {
    setUIContext(uiContext, mode) {
      this.uiContext = uiContext;
      this.mode = mode;
    }
    hasUI() { return true; }
    createContext() { return ctx; }
  }
  assert.equal(hookExtensionRunnerFooter(FakeRunner, installed.applyFooter), true);
  const runner = new FakeRunner();
  runner.setUIContext(ctx.ui, "tui");
  assert.equal(typeof factory, "function");
  assert.match(
    factory(
      { requestRender() {} },
      { fg: (_color, text) => text },
      { getGitBranch: () => "", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
    ).render(120)[0],
    /^✦ Opus 5 high/,
  );
});

test("ctxFromHostSession follows live session fields instead of a snapshot", () => {
  const session = {
    model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
    thinkingLevel: "low",
    sessionManager: { getCwd: () => "/tmp/repo", getBranch: () => [] },
    getContextUsage: () => ({ tokens: 1, contextWindow: 1_000_000, percent: 0 }),
  };
  const ctx = ctxFromHostSession(session, { setFooter() {} });
  assert.equal(ctx.model.id, "anthropic/claude-opus-5");
  session.thinkingLevel = "high";
  session.model = { id: "xai/grok-4.6", contextWindow: 200_000 };
  assert.equal(ctx.thinkingLevel, "high");
  assert.equal(ctx.model.id, "xai/grok-4.6");
});

test("paintStatusLines stamps xAI /fast as [priority]", () => {
  const lines = paintStatusLines({
    ctx: {
      cwd: "/tmp/repo",
      model: { id: "grok-4.6", provider: "xai", contextWindow: 500_000 },
      thinkingLevel: "xhigh",
      isFastModeActive: () => true,
      getContextUsage: () => ({ tokens: 2_000, contextWindow: 500_000, percent: 0.4 }),
      sessionManager: { getBranch: () => [] },
    },
    footerData: { getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
    width: 160,
    speedText: "Speed —",
  });
  assert.match(lines.join("\n"), /Grok 4\.6 xhigh \[priority\]/);
});

test("paintStatusLines is the Rubato line, not senpi's cwd/cost/auto footer", () => {
  const lines = paintStatusLines({
    ctx: {
      cwd: "/Users/wy/Github-repos/rubato-lab",
      model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
      thinkingLevel: "high",
      getContextUsage: () => ({ tokens: 2_000, contextWindow: 1_000_000, percent: 0.2 }),
      sessionManager: { getBranch: () => [] },
    },
    footerData: { getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
    width: 160,
    speedText: "Speed —",
  });
  const text = lines.join("\n");
  assert.match(text, /^✦ Opus 5 high/);
  assert.match(text, /rubato-lab/);
  assert.match(text, /Speed —/);
  assert.doesNotMatch(text, /\$0\.000|\(sub\)|\(auto\)|500K \(0\.0%\)/);
});

test("installStatusline registers a host painter so the built-in footer never needs setFooter", () => {
  const prev = footerHost();
  try {
    const session = {
      model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
      thinkingLevel: "high",
      sessionManager: { getCwd: () => "/Users/wy/Github-repos/rubato-lab", getBranch: () => [] },
      getContextUsage: () => ({ tokens: 1, contextWindow: 1_000_000, percent: 0 }),
    };
    installStatusline({ on() {} }, { speedStore: mockSpeedStore() });
    const host = globalThis[RUBATO_FOOTER_HOST];
    assert.equal(typeof host.paint, "function");
    const painted = host.paint({
      session,
      footerData: { getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
    }, 160);
    assert.match(painted.join("\n"), /^✦ Opus 5 high/);
    assert.doesNotMatch(painted.join("\n"), /\$0\.000|\(sub\)/);
    let factory;
    assert.equal(host.attach({
      session,
      setExtensionFooter(next) { factory = next; },
    }), true);
    assert.equal(typeof factory, "function");
  } finally {
    registerFooterHost(prev);
  }
});

test("importing statusline registers a fallback host that never paints the senpi cost line", () => {
  const host = footerHost();
  assert.equal(typeof host?.paint, "function");
  const painted = host.paint({
    session: {
      model: { id: "anthropic/claude-opus-5", contextWindow: 1_000_000 },
      sessionManager: { getCwd: () => "/Users/wy/Github-repos/rubato-lab", getBranch: () => [] },
      getContextUsage: () => ({ tokens: 1, contextWindow: 1_000_000, percent: 0 }),
    },
    footerData: { getGitBranch: () => "main", getExtensionStatuses: () => new Map() },
  }, 160);
  const text = painted.join("\n");
  assert.match(text, /✦/);
  assert.doesNotMatch(text, /\$0\.000|\(sub\)|\(auto\)/);
});

test("fallbackStatusLines stays on a Rubato line when session inspection throws", () => {
  const painted = fallbackStatusLines({
    session: {
      get model() {
        throw new Error("model boom");
      },
    },
  }, 80);
  const text = painted.join("\n");
  assert.match(text, /✦/);
  assert.doesNotMatch(text, /\$0\.000|\(sub\)/);
});

test("statusline hooks ExtensionRunner from the runner module, not the senpi barrel", () => {
  assert.match(senpiExtensionRunner, /dist\/core\/extensions\/runner\.js$/);
  const source = readFileSync(new URL("../../src/extensions/statusline.mjs", import.meta.url), "utf8");
  assert.match(source, /senpiExtensionRunner/);
  assert.doesNotMatch(source, /import\("@code-yeongyu\/senpi"\)/);
  assert.match(readFileSync(senpiExtensionRunner, "utf8"), /export class ExtensionRunner/);
});

test("after first paint a new statusline factory installs a live host, like /resume", async () => {
  const { activateDeferredExtensions, resetDeferredExtensionsForTests } = await import("../../src/deferred-extensions.mjs");
  const { default: statuslineExtension } = await import("../../src/extensions/statusline.mjs");
  resetDeferredExtensionsForTests();
  await activateDeferredExtensions();
  await statuslineExtension({ on() {} });
  const host = footerHost();
  assert.equal(typeof host?.paint, "function");
  assert.notEqual(host.paint, fallbackStatusLines);
});
