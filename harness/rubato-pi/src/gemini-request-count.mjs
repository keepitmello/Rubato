// Gemini API 무료 등급의 하루 요청 수를 Rubato 가 직접 센다.
//
// Gemini API 는 남은 한도를 응답에 싣지 않고(헤더 없음), 읽어 오는 API 도 없다 — AI Studio
// 사용량 페이지만 보여 준다. 그래서 요청을 보내기 직전에 그날 수를 하나 올리고, 사용량 화면은
// 이 파일을 하루 한도에 대어 그린다. 그 키를 Rubato 만 쓸 때 정확하다.
//
// 하루는 Google 기준대로 태평양 시간 자정에 바뀐다(aistudio.google.com/docs/rate-limits,
// "Requests per day (RPD) quotas reset at midnight Pacific time").
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const GEMINI_REQUESTS_FILE = "gemini-requests.json";

const PACIFIC = "America/Los_Angeles";
const DAY_MINS = 24 * 60;

/**
 * 무료 등급 하루 요청 한도. AI Studio 사용량 페이지(gen-lang-client-0503159558, 무료 등급,
 * 2026-11-15)에서 읽은 값이다. 여기 없는 모델은 세기만 하고 막대를 그리지 않는다.
 */
export const FREE_TIER_DAILY_REQUESTS = Object.freeze({
  "gemini-4-hydrogen": 20,
});

const MODEL_LABELS = Object.freeze({
  "gemini-4-hydrogen": "Hydrogen",
});

export function geminiRequestsPath(authPath) {
  return join(dirname(authPath), GEMINI_REQUESTS_FILE);
}

function pacificParts(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(at));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

/** 태평양 시간 기준 날짜 `YYYY-MM-DD`. */
export function pacificDay(at) {
  const { year, month, day } = pacificParts(at);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `at` 다음 태평양 시간 자정. 서머타임에 따라 UTC-7 이나 UTC-8 이다. */
export function nextPacificMidnight(at) {
  const { year, month, day } = pacificParts(at);
  const nextDayUtc = Date.UTC(year, month - 1, day + 1);
  for (const offsetHours of [7, 8]) {
    const candidate = nextDayUtc + offsetHours * 3_600_000;
    const parts = pacificParts(candidate);
    if (parts.hour === 0 && parts.minute === 0) return new Date(candidate).toISOString();
  }
  return new Date(nextDayUtc + 8 * 3_600_000).toISOString();
}

/** 오늘(태평양 시간)의 모델별 요청 수. 날이 바뀌었거나 파일이 없으면 비어 있다. */
export function readGeminiRequests(path, at = Date.now()) {
  const day = pacificDay(at);
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.day === day && value.models && typeof value.models === "object") return { day, models: value.models };
  } catch {
    // 없거나 깨진 파일은 오늘 0 이다.
  }
  return { day, models: {} };
}

/** 요청 하나를 센다. 세기는 요청을 막지 않는다 — 실패해도 조용히 넘어간다. */
export function recordGeminiRequest(path, modelId, at = Date.now()) {
  if (!path || typeof modelId !== "string" || !modelId) return;
  try {
    const current = readGeminiRequests(path, at);
    current.models[modelId] = (Number(current.models[modelId]) || 0) + 1;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${at}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // 세기는 최선 노력이다.
  }
}

/** 사용량 화면이 그리는 하루 막대. 한도를 아는 모델만 낸다. */
export function geminiDailyWindows(counts, at = Date.now()) {
  const resetsAt = nextPacificMidnight(at);
  return Object.entries(FREE_TIER_DAILY_REQUESTS).map(([modelId, limit]) => {
    const used = Number(counts?.models?.[modelId]) || 0;
    return {
      id: `daily_${modelId}`,
      kind: "other",
      label: `${MODEL_LABELS[modelId] ?? modelId} · Daily ${Math.min(used, limit)}/${limit}`,
      usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
      resetsAt,
      windowDurationMins: DAY_MINS,
    };
  });
}

/**
 * provider 의 요청마다 그 모델의 오늘 수를 올린다. 실제 HTTP 요청 직전에 불리는
 * `onPayload` 에 얹는다 — 키를 못 찾아 요청이 안 나가면 세지 않는다. 호출자가 준 `onPayload`
 * 는 그대로 이어 부른다.
 */
export function withGeminiRequestCount(provider, { path, now = Date.now } = {}) {
  if (!path) return provider;
  const counted = (options) => ({
    ...options,
    onPayload: async (params, model) => {
      recordGeminiRequest(path, model?.id, now());
      return options?.onPayload?.(params, model);
    },
  });
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, counted(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, counted(options)),
  };
}
