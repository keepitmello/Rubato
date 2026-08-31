// Aside 면 위에서 같은 53KB fixture 로 T1–T6 cache 를 잰다.
// vendor 를 직접 부르지 않고 localhost OpenAI 호환을 친다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheHitRate, toOpenAiUsage } from "../src/aside-cursor.mjs";
import { startAsideCursorServer } from "../src/aside-cursor-server.mjs";

const FIXTURE_DIR = process.env.RUBATO_ASIDE_CURSOR_FIXTURE
  ?? "/Users/wy/harness-bench/fixtures-v2";
const PREFIX = readFileSync(join(FIXTURE_DIR, "prefix-small.txt"), "utf8");
const SESSION = `aside-cursor-probe-${Date.now().toString(16)}`;

function usageFromBody(text) {
  const chunks = text.split("\n\n").filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"));
  let last;
  for (const block of chunks) {
    try {
      const parsed = JSON.parse(block.slice(6));
      if (parsed.usage) last = parsed.usage;
    } catch {
      // skip a partial SSE frame
    }
  }
  if (!last) return undefined;
  const cacheRead = Number(last.prompt_tokens_details?.cached_tokens ?? 0);
  const prompt = Number(last.prompt_tokens ?? 0);
  const input = prompt > cacheRead ? prompt - cacheRead : prompt;
  return { input, output: Number(last.completion_tokens ?? 0), cacheRead, cacheWrite: 0 };
}

async function turn(url, n, user) {
  const response = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer rubato-cursor",
      "x-aside-session-id": SESSION,
    },
    body: JSON.stringify({
      model: "cursor/grok-4.6",
      stream: true,
      messages: [
        { role: "system", content: PREFIX },
        { role: "user", content: user },
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`T${n} HTTP ${response.status}: ${text.slice(0, 400)}`);
  const usage = usageFromBody(text);
  const rate = cacheHitRate(usage);
  return { n, usage, rate, openai: usage ? toOpenAiUsage(usage) : undefined };
}

const { server, url } = await startAsideCursorServer({ port: 0 });
const rows = [];
try {
  for (let n = 1; n <= 6; n += 1) {
    const user = readFileSync(join(FIXTURE_DIR, `turn-${n}.txt`), "utf8").trim();
    const row = await turn(url, n, user);
    rows.push(row);
    const pct = row.rate == null ? "n/a" : `${(row.rate * 100).toFixed(1)}%`;
    console.log(JSON.stringify({
      turn: n,
      input: row.usage?.input,
      cacheRead: row.usage?.cacheRead,
      output: row.usage?.output,
      hit: pct,
    }));
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const t2 = rows[1];
if (!t2?.usage) {
  console.error("probe failed: no T2 usage");
  process.exit(2);
}
if ((t2.rate ?? 0) < 0.9) {
  console.error(`probe failed: T2 hit ${(t2.rate * 100).toFixed(1)}% (want >= 90%)`);
  process.exit(3);
}
console.log("aside-cursor probe pass");
