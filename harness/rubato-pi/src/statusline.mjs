import { BRAND_NAME } from "./brand.mjs";
import { presentCursorGrokFastModel } from "./cursor-grok-fast.mjs";
import { formatSpeedIndex } from "./speed-index.mjs";

const FAMILIES = [
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
  ["mythos", "Mythos"],
  ["grok", "Grok"],
  ["gemini", "Gemini"],
  ["kimi", "Kimi"],
  ["gpt", "GPT"],
];

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

/** 모바일급 폭에선 워터마크를 빼고, 이 너비부터 오른쪽에 붙인다. */
export const BRAND_MARK_MIN_WIDTH = 80;

export function visibleColumns(text) {
  return [...stripAnsi(text)].length;
}

/**
 * 폭이 충분하면 워터마크를 오른쪽 끝에 붙인다.
 * 좁으면 빼고, 넓으면 왼쪽을 접어서라도 마크는 남긴다.
 */
export function appendBrandMark(left, width, mark = BRAND_NAME) {
  if (width < BRAND_MARK_MIN_WIDTH) return truncateToWidth(left, width);
  const markCols = visibleColumns(mark);
  const budget = width - markCols;
  if (budget <= 1) return truncateToWidth(left, width);
  const clipped = truncateToWidth(left, budget - 1);
  const pad = Math.max(1, width - visibleColumns(clipped) - markCols);
  return `${clipped}${" ".repeat(pad)}${mark}`;
}

const VARIANTS = [
  ["sol", "Sol"],
  ["luna", "Luna"],
  ["terra", "Terra"],
];

export function shortModelLabel(modelId) {
  if (!modelId) return "unknown";
  const bare = String(modelId).split("/").pop();
  const modelName = bare.split(":", 1)[0];
  const lc = modelName.toLowerCase();
  if (lc === "gpt-daybreak-blue-latest" || lc === "gpt-daybreak-blue-latest-fast") return "Daybreak Blue";
  const variant = variantLabel(lc);
  if (variant) return variant;
  for (const [key, label] of FAMILIES) {
    const idx = lc.indexOf(key);
    if (idx < 0) continue;
    const tail = lc.slice(idx + key.length).replace(/^[-.]/, "");
    const version = parseVersion(tail);
    return version ? `${label} ${version}` : label;
  }
  const colon = bare.indexOf(":");
  return colon >= 0 ? bare.slice(0, colon) : bare;
}

// A catalog may report the same model as `gpt-5.6-sol` (id spelling) or `GPT-5.6 Sol` (friendly
// display name), so every non-alphanumeric run counts as a separator here. Anchoring on hyphen/dot
// alone made the label depend on which spelling the catalog happened to carry, which let this
// statusline and the Task widget disagree about the same resolved model.
// Kept byte-for-byte in step with variantLabel() in
// packages/rubato-runtime/src/components/task/status-row-format.ts.
function isVariantSeparator(ch) {
  return ch === undefined || !/[a-z0-9]/.test(ch);
}

function variantLabel(lc) {
  for (const [key, label] of VARIANTS) {
    const idx = lc.lastIndexOf(key);
    if (idx < 0) continue;
    // Both edges must be separators: without the trailing check `solar` would render as `Sol`.
    if (!isVariantSeparator(lc[idx - 1]) || !isVariantSeparator(lc[idx + key.length])) continue;
    const before = lc.slice(0, idx).replace(/[^a-z0-9]$/, "").replace(/^gpt[^a-z0-9]/, "");
    const version = parseVersion(before.replace(/^[a-z]+[^a-z0-9]/, "")) || parseVersion(before);
    return version ? `${version} ${label}` : label;
  }
  return "";
}

export function formatEffort(level) {
  if (!level || level === "off") return "";
  return String(level).toLowerCase();
}

export function formatModelWithEffort(modelId, level, model, catalog) {
  const presented = presentCursorGrokFastModel(model, catalog, modelId);
  const label = shortModelLabel(modelId);
  const effort = formatEffort(level) || effortFromModelId(modelId);
  const fast = isFastModel(modelId, presented) ? " [fast]" : "";
  return `${effort ? `${label} ${effort}` : label}${fast}`;
}

function isFastModel(modelId, model) {
  if (!modelId) return false;
  const bare = String(modelId).split("/").pop().split(":", 1)[0];
  if (/(?:^|[-.])fast$/i.test(bare)) return true;
  // 피커 id 는 `cursor-grok-4.6` 그대로다. Fast 인지는 표시명·discovered map 으로만 본다.
  // id 만으로 Fast 를 단정하면 catalog 에 Fast variant 가 없을 때도 [fast] 가 붙는다.
  if (bare !== "cursor-grok-4.6") return false;
  if (model?.compat?.cursorGrokFastByLevel && Object.keys(model.compat.cursorGrokFastByLevel).length > 0) {
    return true;
  }
  return typeof model?.name === "string" && /\bfast\b/i.test(model.name);
}

function effortFromModelId(modelId) {
  if (!modelId) return "";
  const bare = String(modelId).split("/").pop();
  const colon = bare.lastIndexOf(":");
  if (colon < 0) return "";
  return formatEffort(bare.slice(colon + 1).toLowerCase());
}

function parseVersion(tail) {
  const parts = [];
  let part = "";
  for (const ch of tail) {
    if (ch >= "0" && ch <= "9") {
      part += ch;
    } else if ((ch === "-" || ch === ".") && part) {
      parts.push(part);
      part = "";
    } else {
      break;
    }
  }
  if (part) parts.push(part);
  while (parts.length > 0 && parts[parts.length - 1].length >= 6) parts.pop();
  if (parts.length === 0) return "";
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return parts[0];
}

export function remainingPercent(usedPercent) {
  if (usedPercent == null || Number.isNaN(Number(usedPercent))) return null;
  const remaining = Math.round(100 - Number(usedPercent));
  if (remaining < 0) return 0;
  if (remaining > 100) return 100;
  return remaining;
}

export function formatWindow(count) {
  const n = Math.round(Number(count) || 0);
  if (n <= 0) return "";
  if (n < 1_000) return String(n);
  if (n < 10_000) return trim1(n / 1_000) + "K";
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return trim1(n / 1_000_000) + "M";
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  return trim1(n / 1_000_000_000) + "B";
}

function trim1(n) {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatContext(remaining, window) {
  const size = formatWindow(window);
  if (remaining == null) return size ? `? (${size})` : "?";
  return size ? `${remaining}% (${size})` : `${remaining}%`;
}

export function cacheHitPercent(usage) {
  if (!usage) return null;
  const input = nonNegativeNumber(usage.input);
  const cacheRead = nonNegativeNumber(usage.cacheRead);
  const cacheWrite = nonNegativeNumber(usage.cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  if (prompt <= 0) return null;
  return Math.round((cacheRead / prompt) * 100);
}

/** 활성 브랜치 전체 assistant usage 를 한 번에 합친다. 호출별 % 평균이 아니다. */
export function sessionCacheUsage(entries) {
  if (!Array.isArray(entries)) return null;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let found = false;
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const usage = entry.message?.role === "assistant" ? entry.message.usage : undefined;
    if (!usage) continue;
    found = true;
    input += nonNegativeNumber(usage.input);
    cacheRead += nonNegativeNumber(usage.cacheRead);
    cacheWrite += nonNegativeNumber(usage.cacheWrite);
  }
  return found ? { input, cacheRead, cacheWrite } : null;
}

export function sessionCacheHitPercent(entries) {
  const usage = sessionCacheUsage(entries);
  if (!usage) return null;
  // Cursor Fast 처럼 제공자가 cache 필드를 안 주면 둘 다 0 이다. 0% miss 로 그리면 거짓이다.
  if (usage.cacheRead === 0 && usage.cacheWrite === 0) return null;
  return cacheHitPercent(usage);
}

/** 제공자별 보존 규약을 만료시각, 최소 보장 창, 불투명 캐시로 나눈다. */
export function resolveCachePolicy(model) {
  const provider = String(model?.provider ?? "").toLowerCase();
  const api = String(model?.api ?? "").toLowerCase();
  const id = String(model?.id ?? "").toLowerCase();
  if (api === "claude-sdk-oauth") return { kind: "sliding", ttlSeconds: 3600 };
  if (provider === "openai" && api === "openai-responses" && /(?:^|\/)gpt-5\.6(?:-|$)/.test(id)) {
    return { kind: "minimum", ttlSeconds: 1800 };
  }
  // Rubato는 PI_CACHE_RETENTION=long 으로 anthropic 1h 캐시를 요청한다(brand.mjs).
  // 표시 TTL을 foreground wait budget에서 역산하면 사용자 safety buffer가 섞여 거짓말한다.
  if (provider === "anthropic") return { kind: "sliding", ttlSeconds: 3600 };
  if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
    return { kind: "sliding", ttlSeconds: model?.cacheRetention === "long" ? 3600 : 300 };
  }
  if (
    provider === "xai" || id.includes("grok") ||
    provider === "openai-codex" || api === "openai-codex-responses" ||
    provider === "google" || provider === "google-vertex" || provider === "google-antigravity"
  ) return { kind: "opaque" };
  return undefined;
}

function latestCacheObservation(entries) {
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage;
    if (!usage) continue;
    const cacheRead = nonNegativeNumber(usage.cacheRead);
    const cacheWrite = nonNegativeNumber(usage.cacheWrite);
    const timestamp = Number(entry.message.timing?.sentAt ?? entry.message.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < 0) continue;
    return { timestamp, hit: cacheRead > 0, wrote: cacheWrite > 0 };
  }
  return undefined;
}

export function cacheStatus(entries, policy, nowMs = Date.now()) {
  if (!policy || !Number.isFinite(nowMs)) return null;
  // xAI/Cursor Grok/Codex/Gemini 는 공개 TTL 이 없다. Miss 라벨도 지어내지 않는다.
  // Cursor Fast 는 cache 필드를 0 으로만 주는데, 그걸 Miss 로 그리면 상태줄이 거짓말한다.
  if (policy.kind === "opaque") return null;
  const observation = latestCacheObservation(entries);
  if (!observation) return null;
  if (!observation.hit && !observation.wrote) {
    return { text: "Cache Miss", ticking: false, expired: false };
  }
  const ageSeconds = Math.max(0, nowMs - observation.timestamp) / 1000;
  const remainingSeconds = Math.ceil(policy.ttlSeconds - ageSeconds);
  if (remainingSeconds <= 0) {
    return policy.kind === "minimum"
      ? { text: "Cache Unknown", ticking: false, expired: false }
      : { text: "Cache Expired", ticking: false, expired: true };
  }
  const time = remainingSeconds < 60 ? `${remainingSeconds}s` : `${Math.ceil(remainingSeconds / 60)}m`;
  const prefix = policy.kind === "minimum" ? "Cache ≥ " : "Cache ";
  return { text: `${prefix}${time}`, ticking: true, expired: false };
}

export function repoBasename(cwd) {
  if (!cwd) return "";
  const normalized = String(cwd).replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function latestAssistantUsage(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant" || !message.usage) continue;
    return message.usage;
  }
  return null;
}

/**
 * `output.timing` 은 rubato-stream 이 성공한 모델 호출이 끝날 때 붙인다 (measurement
 * 기록기와 무관하게 항상 계산 — RUBATO_MEASUREMENT_LOG 가 꺼져 있어도 값이 있다).
 * 세션 파일에도 저장되므로 현재 프로세스 표식이 맞고 표시할 숫자가 유효한 값만 고른다.
 *
 * 한 사용자 턴은 도구 루프 때문에 모델 호출 여러 번으로 갈라진다. 마지막 호출만 보여주면
 * 숫자가 호출마다 튀므로 현재 턴에 속한 호출들의 평균을 낸다. 턴 경계는 브랜치 엔트리에서
 * 직접 뽑는다 — 마지막 user 메시지 뒤의 assistant 들이 곧 현재 턴이다. 이러면 measurement
 * 기록기(RUBATO_MEASUREMENT_LOG)가 꺼져 있어도 동작하고, 새 user 메시지가 들어오는 순간
 * 평균이 저절로 리셋된다.
 *
 * think 는 사고한 호출들만 모아 평균낸다. 사고 없는 호출을 0 으로 섞으면 실제로 4초 생각한
 * 턴이 `think 1s` 로 찍혀 거짓말이 된다.
 */
export function currentTurnTiming(entries, processStartedAt) {
  if (!Array.isArray(entries)) return null;
  const messages = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "user") break;
    messages.push(message);
  }
  return turnTiming(messages, processStartedAt);
}

/**
 * 위와 같은 계산을 이미 턴 단위로 잘린 메시지 배열에 대해 한다. TPS 알림처럼
 * `agent_end` 가 그 턴의 assistant 메시지를 통째로 넘겨주는 자리에서 쓴다.
 * 순서는 상관없다 — 평균이고, ttft 폴백만 첫 유효값을 잡는다.
 */
export function turnTiming(messages, processStartedAt) {
  if (!Array.isArray(messages) || !Number.isFinite(processStartedAt)) return null;
  const waits = [];
  const thinks = [];
  let ttftMs;
  let outputTokens = 0;
  let durationMs = 0;
  let throughputComplete = true;
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const timing = message?.timing;
    const output = nonNegativeNumber(message.usage?.output);
    if (timing?.processStartedAt !== processStartedAt) {
      if (output > 0) throughputComplete = false;
      continue;
    }
    // 실패/중단 호출은 애초에 timing 이 없어 여기서 걸러진다.
    // ttft 가 없어도 wait/duration 이 있으면 상태줄에 그린다. Fast 는 내용
    // 델타 전에 스트림이 닫혀 ttft 가 빠지는 경우가 있다.
    const hasTtft = validLatencyMs(timing?.ttftMs);
    const hasWait = validLatencyMs(timing?.waitMs);
    const hasThink = validLatencyMs(timing?.thinkMs);
    const hasDuration = validLatencyMs(timing?.modelDurationMs) && timing.modelDurationMs > 0;
    if (!hasTtft && !hasWait && !hasThink && !hasDuration) {
      if (output > 0) throughputComplete = false;
      continue;
    }
    if (hasTtft && ttftMs === undefined) ttftMs = timing.ttftMs;
    if (hasWait) waits.push(timing.waitMs);
    if (hasThink) thinks.push(timing.thinkMs);
    // 분모는 양수 modelDurationMs 만. 성공 호출의 persisted usage.output 합 / 그 합.
    if (hasDuration) {
      outputTokens += output;
      durationMs += timing.modelDurationMs;
    } else if (output > 0) {
      throughputComplete = false;
    }
  }
  const waitMs = mean(waits) ?? ttftMs;
  if (waitMs === undefined && thinks.length === 0 && durationMs === 0) return null;
  return {
    ...(waitMs === undefined ? {} : { waitMs }),
    ...(thinks.length === 0 ? {} : { thinkMs: mean(thinks) }),
    ...(throughputComplete && durationMs > 0 && outputTokens > 0
      ? { tokensPerSecond: outputTokens / (durationMs / 1000) }
      : {}),
    calls: waits.length || 1,
  };
}

function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function validLatencyMs(ms) {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_VALUE / 1000;
}

/** `340ms` 이하 1초, 그 위는 `1.2s`. 소음을 줄이려 소수점 하나만 남긴다. 알림줄이 같이 쓴다. */
export function formatLatencyMs(ms) {
  if (!validLatencyMs(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 상태줄용. 1초 미만은 ms, 이상은 반올림한 정수 초. */
export function formatFooterLatencyMs(ms) {
  if (!validLatencyMs(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * 상태줄에는 답변 길이에 독립적인 대기/사고 시간만 속도로 표시한다.
 * `delay 4s · think 10s`. 사고가 없던 턴은 `delay` 만 그린다 — `think 0ms` 는 거짓말이다.
 */
export function formatLatency(timing) {
  const delay = formatFooterLatencyMs(timing?.waitMs ?? timing?.ttftMs);
  if (!delay) return "";
  // 0 은 사고를 안 한 것과 구분되지 않으므로 그리지 않는다.
  const think = timing?.thinkMs ? formatFooterLatencyMs(timing.thinkMs) : "";
  return think ? `delay ${delay} · think ${think}` : `delay ${delay}`;
}

export function formatTokensPerSecond(tps) {
  if (typeof tps !== "number" || !Number.isFinite(tps) || tps < 0) return "";
  return `${Math.round(tps)} tok/s`;
}

/** `Cache 4m` / `Cache Expired` 에서 접두만 떼 퍼센트 옆에 붙인다. */
export function cacheLifetimeLabel(lifetime) {
  const text = lifetime?.text;
  if (!text) return "";
  return text.startsWith("Cache ") ? text.slice("Cache ".length) : text;
}

/** `Cache 92% (40m)`, `Cache 92% (Expired)`. 있는 쪽만 그린다. */
export function formatCacheSegment(percent, lifetime) {
  const suffix = cacheLifetimeLabel(lifetime);
  if (percent == null) return suffix ? (lifetime?.text ?? `Cache ${suffix}`) : "";
  if (!suffix) return `Cache ${percent}%`;
  return `Cache ${percent}% (${suffix})`;
}

/** Persistent `Speed —` / `Speed N`. Cache stays on the identity line. */
export function formatFooterMetrics({ speed } = {}) {
  return formatSpeedIndex(speed).text;
}

export function statuslineSegments({ model, remaining, window, branch, repo, cache, cacheLifetime, speed }) {
  const parts = [`✦ ${model}`, formatContext(remaining, window)];
  const cacheText = formatCacheSegment(cache, cacheLifetime);
  if (cacheText) parts.push(cacheText);
  if (branch) parts.push(branch);
  if (repo) parts.push(repo);
  parts.push(formatFooterMetrics({ speed }));
  return parts;
}

export function formatStatusline(input) {
  const left = statuslineSegments(input).join(" · ");
  return input.width == null ? left : appendBrandMark(left, input.width);
}

/** 워터마크를 붙인 뒤 본문이 쓸 수 있는 칸. */
export function statuslineContentBudget(width, mark = BRAND_NAME) {
  if (width < BRAND_MARK_MIN_WIDTH) return width;
  const markCols = visibleColumns(mark);
  if (width - markCols <= 1) return width;
  return width - markCols - 1;
}

/**
 * 한 줄에 안 들어가면 Speed 를 둘째 줄로 내린다. Cache 는 identity 에 남긴다.
 * 잘린 줄은 ANSI를 유지한다 — 접는 순간 색이 빠지면 흑백처럼 보인다.
 */
export function layoutStatusLines(identity, metrics, width, mark = BRAND_NAME) {
  const full = metrics ? `${identity} · ${metrics}` : identity;
  if (!metrics || visibleColumns(full) <= statuslineContentBudget(width, mark)) {
    return [appendBrandMark(full, width, mark)];
  }
  return [appendBrandMark(identity, width, mark), truncateToWidth(metrics, width)];
}

// ── 배경 작업 요약 ─────────────────────────────────────────────────
//
// 셸과 모니터는 엔진의 `wake_source_state` 이벤트로 온다.
// 둘 다 `{ id, description, startedAtMs }` 로 모양이 같아서 한 줄에 합칠 수 있다.
// 서브에이전트는 에디터 위 위젯이 그린다.

/** 이벤트의 source 값과 화면에 쓸 글리프. 순서가 곧 표시 순서다. 서브에이전트는 위젯이 그린다. */
export const BACKGROUND_SOURCES = Object.freeze([
  { source: "terminal-background-sessions", glyph: "⌘", field: "items" },
  { source: "terminal-monitors", glyph: "◉", field: "monitors" },
]);

/** `05:44`, 한 시간을 넘기면 `1:05:44`. 시계지 상대시간 표기가 아니다. */
export function formatElapsedClock(startedAtMs, nowMs) {
  const started = Number(startedAtMs);
  if (!Number.isFinite(started)) return "";
  const total = Math.max(0, Math.floor((Number(nowMs) - started) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 이벤트 페이로드를 표시용 항목으로 정규화한다.
 * source 마다 배열이 담긴 필드 이름이 달라서 BACKGROUND_SOURCES 로 맞춘다.
 */
export function backgroundEntriesFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const spec = BACKGROUND_SOURCES.find((candidate) => candidate.source === event.source);
  if (!spec) return null;
  const raw = event[spec.field];
  if (!Array.isArray(raw)) return { source: spec.source, entries: [] };
  const entries = raw
    .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      description: String(entry.description ?? entry.id),
      startedAtMs: Number(entry.startedAtMs),
    }));
  return { source: spec.source, entries };
}

/** `reviewer Opus 5 05:44` — 모델은 있을 때만 낀다. */
export function formatBackgroundEntry(entry, nowMs) {
  const clock = formatElapsedClock(entry.startedAtMs, nowMs);
  const model = entry.model ? shortModelLabel(entry.model) : "";
  return [entry.description, model, clock].filter(Boolean).join(" ");
}

/**
 * 소스별 묶음을 한 줄로 조립한다. 폭을 넘기면 뒤에서부터 접어 `+N` 으로 세되,
 * 개수만은 절대 잘리지 않게 남긴다 — 몇 개가 도는지가 가장 중요한 정보다.
 */
export function formatBackgroundLine(groups, nowMs, width = 80) {
  const chunks = [];
  for (const spec of BACKGROUND_SOURCES) {
    const entries = groups?.get?.(spec.source) ?? [];
    if (entries.length === 0) continue;
    const labels = entries.map((entry) => formatBackgroundEntry(entry, nowMs));
    chunks.push({ glyph: spec.glyph, labels });
  }
  if (chunks.length === 0) return "";

  for (let keep = maxLabels(chunks); keep >= 0; keep -= 1) {
    const line = renderChunks(chunks, keep);
    if (line.length <= width) return line;
  }
  return renderChunks(chunks, 0);
}

function maxLabels(chunks) {
  return chunks.reduce((max, chunk) => Math.max(max, chunk.labels.length), 0);
}

/** keep 개까지만 이름을 쓰고 나머지는 `+N`. keep 이 0이면 개수만 남는다. */
function renderChunks(chunks, keep) {
  return chunks
    .map(({ glyph, labels }) => {
      const shown = keep > 0 ? labels.slice(0, keep) : [];
      const hidden = labels.length - shown.length;
      const parts = [...shown];
      if (hidden > 0) parts.push(`+${hidden}`);
      return `${glyph} ${parts.join(" · ")}`;
    })
    .join("   ");
}

export function truncateToWidth(text, width) {
  if (width <= 0) return "";
  if (visibleColumns(text) <= width) return text;
  if (width === 1) return "…";
  const budget = width - 1;
  const source = String(text);
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < source.length && visible < budget) {
    if (source[i] === "\x1b") {
      const ansi = /^\x1b\[[0-9;]*m/.exec(source.slice(i));
      if (ansi) {
        out += ansi[0];
        i += ansi[0].length;
        continue;
      }
    }
    const cp = [...source.slice(i)][0];
    out += cp;
    i += cp.length;
    visible += 1;
  }
  return `${out}…\x1b[0m`;
}
