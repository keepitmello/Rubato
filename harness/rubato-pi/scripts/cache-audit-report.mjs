#!/usr/bin/env node
// `RUBATO_CACHE_AUDIT_DIR/audit.jsonl` 을 호출 단위 표로 요약한다.
//
//   node scripts/cache-audit-report.mjs .rubato-cache-audit/audit.jsonl [--session <id>]
//
// 열: seq, model, input / cache read / cache write (5m/1h), 캐시 읽기 비율, 직전 요청과
// 처음 갈라진 구간, Anthropic diagnostics.cache_miss_reason, thinking_dropped 개수.
import { readFileSync } from "node:fs";

const [, , path, ...rest] = process.argv;
if (!path) {
  console.error("usage: cache-audit-report.mjs <audit.jsonl> [--session <id>] [--json]");
  process.exit(2);
}
const sessionFilter = rest.includes("--session") ? rest[rest.indexOf("--session") + 1] : undefined;
const asJson = rest.includes("--json");

const events = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const requests = new Map();
const responses = new Map();
for (const event of events) {
  if (sessionFilter && event.sessionId !== sessionFilter) continue;
  if (event.type === "anthropic.request") requests.set(event.seq, event);
  if (event.type === "anthropic.response") responses.set(event.seq, event);
}

function pct(read, input, write) {
  const total = (read ?? 0) + (input ?? 0) + (write ?? 0);
  return total > 0 ? `${((read ?? 0) / total * 100).toFixed(1)}%` : "-";
}

const rows = [...requests.keys()].sort((a, b) => a - b).map((seq) => {
  const request = requests.get(seq);
  const response = responses.get(seq) ?? {};
  const usage = response.usage ?? {};
  const dropped = Array.isArray(response.inputTransformations)
    ? response.inputTransformations.filter((item) => item?.type === "thinking_dropped").length
    : 0;
  const changed = request.firstChanged
    ? `${request.firstChanged.section}[${request.firstChanged.index}] ${request.firstChanged.kind}`
    : request.identicalToPrevious ? "identical" : "first";
  return {
    seq,
    session: (request.sessionId ?? "-").slice(0, 8),
    model: request.model,
    status: response.status ?? "-",
    input: usage.input_tokens ?? "-",
    cacheRead: usage.cache_read_input_tokens ?? "-",
    cacheWrite: usage.cache_creation_input_tokens ?? "-",
    write5m: usage.ephemeral_5m_input_tokens ?? "-",
    write1h: usage.ephemeral_1h_input_tokens ?? "-",
    readRatio: pct(usage.cache_read_input_tokens, usage.input_tokens, usage.cache_creation_input_tokens),
    ttl: request.cacheControl?.ttl ?? "-",
    sysBp: request.cacheControl?.systemBreakpoint ? "y" : "n",
    tools: request.counts?.tools ?? "-",
    msgs: request.counts?.messages ?? "-",
    firstChanged: changed,
    missReason: response.diagnostics?.cache_miss_reason?.type ?? (request.injected?.includes("diagnostics") ? "(none)" : "-"),
    thinkingDropped: dropped,
    contextMgmt: request.contextManagement ? "y" : "n",
    iterations: usage.iterations ? JSON.stringify(usage.iterations) : "-",
    id: response.id ?? "-",
  };
});

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const columns = ["seq", "session", "status", "input", "cacheRead", "cacheWrite", "write5m", "write1h", "readRatio", "ttl", "sysBp", "tools", "msgs", "firstChanged", "missReason", "thinkingDropped", "contextMgmt"];
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => String(row[column]).length)));
  const line = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join("  ");
  console.log(line(columns));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(line(columns.map((column) => row[column])));
  const withUsage = rows.filter((row) => typeof row.input === "number");
  if (withUsage.length > 0) {
    const sum = (key) => withUsage.reduce((total, row) => total + (typeof row[key] === "number" ? row[key] : 0), 0);
    console.log(`\ncalls=${withUsage.length} input=${sum("input")} cacheRead=${sum("cacheRead")} cacheWrite=${sum("cacheWrite")} readRatio=${pct(sum("cacheRead"), sum("input"), sum("cacheWrite"))}`);
  }
}
