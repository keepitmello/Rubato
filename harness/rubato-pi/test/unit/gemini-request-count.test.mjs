import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FREE_TIER_DAILY_REQUESTS,
  geminiDailyWindows,
  geminiRequestsPath,
  nextPacificMidnight,
  pacificDay,
  readGeminiRequests,
  recordGeminiRequest,
  withGeminiRequestCount,
} from "../../src/gemini-request-count.mjs";

const HYDROGEN = "gemini-4-hydrogen";
const LIMIT = FREE_TIER_DAILY_REQUESTS[HYDROGEN];

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "rubato-gemini-count-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return geminiRequestsPath(join(dir, "auth.json"));
}

test("하루는 태평양 시간으로 바뀌고 리셋은 서머타임에 따라 UTC 7시나 8시다", () => {
  // 2026-11-15 12:00 UTC = 태평양 04:00 (PST). 다음 자정은 11-16 08:00 UTC.
  const pst = Date.parse("2026-11-15T12:00:00Z");
  assert.equal(pacificDay(pst), "2026-11-15");
  assert.equal(nextPacificMidnight(pst), "2026-11-16T08:00:00.000Z");
  // 2026-07-01 06:59 UTC = 태평양 6-30 23:59 (PDT). 다음 자정은 07-01 07:00 UTC.
  const pdt = Date.parse("2026-07-01T06:59:00Z");
  assert.equal(pacificDay(pdt), "2026-06-30");
  assert.equal(nextPacificMidnight(pdt), "2026-07-01T07:00:00.000Z");
});

test("요청을 모델별로 세고, 태평양 날짜가 바뀌면 0 부터 다시 센다", (t) => {
  const path = scratch(t);
  const morning = Date.parse("2026-11-15T12:00:00Z");
  recordGeminiRequest(path, HYDROGEN, morning);
  recordGeminiRequest(path, HYDROGEN, morning + 1000);
  recordGeminiRequest(path, "gemini-3.8-flash", morning + 2000);
  assert.deepEqual(readGeminiRequests(path, morning + 3000), {
    day: "2026-11-15",
    models: { [HYDROGEN]: 2, "gemini-3.8-flash": 1 },
  });
  const nextDay = Date.parse("2026-11-16T08:00:00Z");
  assert.deepEqual(readGeminiRequests(path, nextDay), { day: "2026-11-16", models: {} });
  recordGeminiRequest(path, HYDROGEN, nextDay);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { day: "2026-11-16", models: { [HYDROGEN]: 1 } });
});

test("깨진 파일은 오늘 0 이고, 세기는 던지지 않는다", (t) => {
  const path = scratch(t);
  writeFileSync(path, "{not json");
  assert.deepEqual(readGeminiRequests(path, Date.parse("2026-11-15T12:00:00Z")).models, {});
  assert.doesNotThrow(() => recordGeminiRequest("/dev/null/not-a-dir/gemini-requests.json", HYDROGEN));
  assert.doesNotThrow(() => recordGeminiRequest(undefined, HYDROGEN));
});

test("하루 막대는 쓴 수/한도와 다음 태평양 자정을 싣고 100% 에서 멈춘다", () => {
  const at = Date.parse("2026-11-15T12:00:00Z");
  assert.deepEqual(geminiDailyWindows({ models: { [HYDROGEN]: 12 } }, at), [{
    id: `daily_${HYDROGEN}`,
    kind: "other",
    label: `Hydrogen · Daily 12/${LIMIT}`,
    usedPercent: (12 / LIMIT) * 100,
    resetsAt: "2026-11-16T08:00:00.000Z",
    windowDurationMins: 1440,
  }]);
  const over = geminiDailyWindows({ models: { [HYDROGEN]: LIMIT + 5 } }, at)[0];
  assert.equal(over.usedPercent, 100);
  assert.equal(over.label, `Hydrogen · Daily ${LIMIT}/${LIMIT}`);
  assert.equal(geminiDailyWindows(undefined, at)[0].usedPercent, 0);
});

test("요청이 실제로 나가는 onPayload 에서만 세고, 호출자의 onPayload 를 이어 부른다", async (t) => {
  const path = scratch(t);
  const at = Date.parse("2026-11-15T12:00:00Z");
  const seen = [];
  const native = {
    id: "google",
    stream: async (model, _context, options) => {
      if (options.apiKey) return options.onPayload({ model: model.id }, model);
      return "no key";
    },
    streamSimple: async (model, _context, options) => options.onPayload({ model: model.id }, model),
  };
  const provider = withGeminiRequestCount(native, { path, now: () => at });
  const model = { id: HYDROGEN };
  assert.equal(await provider.stream(model, {}, {}), "no key");
  assert.deepEqual(readGeminiRequests(path, at).models, {}, "키가 없어 안 나간 요청은 세지 않는다");

  const replaced = { replaced: true };
  const result = await provider.stream(model, {}, {
    apiKey: "k",
    onPayload: async (params) => { seen.push(params.model); return replaced; },
  });
  assert.equal(result, replaced);
  await provider.streamSimple(model, {}, {});
  assert.deepEqual(seen, [HYDROGEN]);
  assert.deepEqual(readGeminiRequests(path, at).models, { [HYDROGEN]: 2 });
  assert.equal(withGeminiRequestCount(native, {}), native, "경로가 없으면 감싸지 않는다");
});
