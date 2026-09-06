#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { priceUsage } from "./lib/context-cost-model.mjs";

function parseUsage(u) {
  if (!u || !["input", "output", "cacheRead", "cacheWrite"].every(k => typeof u[k] === "number" && Number.isFinite(u[k]) && u[k] >= 0)) return null;
  if (u.iterations) throw new Error("원시 iterations 형식은 이 도구가 직접 합산하지 않아요. 정규화한 사용량 기록을 사용해 주세요.");
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
    cacheWrite1h: u.cacheWrite1h ?? 0 };
}
function selectedBranch(entries, leafId) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (typeof entry.id !== "string" || !entry.id || byId.has(entry.id)) throw new Error("비어 있거나 중복된 세션 항목 식별자가 있어요.");
    byId.set(entry.id, entry);
  }
  let current = leafId ?? [...byId.keys()].at(-1);
  const seen = new Set(), branch = [];
  while (current) {
    if (seen.has(current)) throw new Error("기록의 상위 연결이 순환해요.");
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) throw new Error("현재 가지의 상위 기록이 누락됐어요.");
    branch.push(entry); current = entry.parentId;
  }
  return branch.reverse();
}
function estimatedTokens(message, flags) {
  let chars = "";
  if (typeof message.content === "string") chars = message.content;
  else if (Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === "text") chars += part.text ?? "";
    else if (part.type === "toolCall") chars += JSON.stringify({ name: part.name, arguments: part.arguments });
    else if (part.type === "thinking") { chars += part.thinking ?? ""; flags.add("thinking_replay_is_provider_dependent"); }
    else if (part.type === "image") flags.add("image_tokens_not_estimated");
    else if (part.type !== "providerNative") flags.add("unknown_content_block_not_estimated");
  }
  return Math.ceil((Buffer.byteLength(chars) + 32) / 3);
}

export function auditSession(text, modelKey, prices, leafId) {
  const all = text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`${i + 1}번째 기록 줄을 읽지 못했어요. 실행 중인 파일 대신 일관된 복사본을 사용해 주세요.`); }
  });
  const branch = selectedBranch(all, leafId);
  const models = [...new Set(branch.filter(e => e.type === "message" && e.message?.role === "assistant" && e.message.provider && e.message.model)
    .map(e => `${e.message.provider}/${e.message.model}`))];
  if (!models.length || models.some(k => k !== modelKey)) throw new Error(`단일 모델 가지가 필요해요. 기록에 있는 모델: ${models.join(", ") || "없음"}`);
  const flags = new Set(["newTokens_is_UTF8_divided_by_3_estimate_not_provider_token_count", "timestamps_are_session_timestamps_not_verified_request_start_times"]);
  const calls = [], charges = [], summaries = [];
  let pending = 0, previousTime, unknownUsage = 0;
  const notesMode = branch.some(e => e.details?.source === "rubato-history-notes-v1" || e.customType === "rubato.context-window.init.v1");
  const addCharge = (entryId, kind, rawUsage) => {
    const usage = parseUsage(rawUsage);
    if (!usage) { unknownUsage++; return; }
    charges.push({ entryId, kind, usage, cost: priceUsage(usage, prices) });
  };
  for (const entry of branch) {
    if (entry.type === "compaction") {
      summaries.push({ entryId: entry.id, source: entry.details?.source ?? "engine",
        tokensBefore: entry.tokensBefore ?? null, summaryUtf8Bytes: typeof entry.summary === "string" ? Buffer.byteLength(entry.summary) : null,
        firstKeptEntryId: entry.firstKeptEntryId ?? null });
      // The Anthropic projection mirrors a generation already on assistant.usage.compaction.
      if (!["rubato-history-notes-v1", "anthropic-server-compaction"].includes(entry.details?.source)) addCharge(entry.id, "stored_compaction", entry.usage);
      continue;
    }
    if (entry.type === "custom_message") { pending += estimatedTokens({ content: entry.content }, flags); continue; }
    if (entry.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role !== "assistant") { pending += estimatedTokens(m, flags); continue; }
    addCharge(entry.id, "assistant", m.usage);
    if (m.usage?.compaction) addCharge(entry.id, "anthropic_compaction_iteration", m.usage.compaction);
    // usage.cost already includes the above compaction iteration in this pinned
    // Rubato adapter. Never add usage.cost.total again or count reasoning twice.
    const recordedTime = typeof m.timestamp === "number" ? m.timestamp : Date.parse(entry.timestamp);
    const gapMs = previousTime === undefined || !Number.isFinite(recordedTime) ? 0 : Math.max(0, recordedTime - previousTime);
    if (Number.isFinite(recordedTime)) previousTime = recordedTime;
    const usage = parseUsage(m.usage);
    calls.push({ id: entry.id, newTokens: pending, outputTokens: usage?.output ?? estimatedTokens(m, flags), gapMs,
      outputSource: usage ? "reported_usage" : "text_estimate" });
    pending = estimatedTokens(m, flags);
    if (["error", "aborted"].includes(m.stopReason)) flags.add("trace_contains_failed_or_aborted_requests");
  }
  if (notesMode) flags.add("notes_mode_trace_not_used_as_productive_baseline_use_a_summary_mode_session");
  if (unknownUsage) flags.add("missing_usage_is_unknown_not_free");
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUSD: 0 };
  for (const c of charges) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"]) totals[key] += c.usage[key];
    totals.costUSD += c.cost.total;
  }
  const warnings = [...flags];
  return {
    audit: { formatVersion: 1, modelKey, leafId: branch.at(-1)?.id ?? null, totals, charges, summaries, unknownUsageRecords: unknownUsage,
      completeness: "이 세션에 기록된 식별 가능한 사용량만 합산했어요. 전송 실패·재시도·외부 작업자·기록되지 않은 내부 요청은 별도 확인이 필요해요.",
      warnings },
    trace: { formatVersion: 1, modelKey, warnings, calls: notesMode ? [] : calls,
      source: "세션 본문은 내보내지 않아요. 작업 증가량은 임시 추정값이므로 실제 토큰 계수로 보정한 뒤 판단해야 해요." },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (![4, 5].includes(args.length)) throw new Error("사용법: node context-cost-audit.mjs SESSION.jsonl PROVIDER/MODEL PRICES.json OUTPUT_PREFIX [LEAF_ID]");
    const snapshot = JSON.parse(readFileSync(args[2], "utf8"));
    const prices = snapshot.models?.[args[1]];
    if (!prices) throw new Error("이 모델의 가격이 설정 파일에 없어요. 실제 연결의 가격을 먼저 지정해 주세요.");
    const output = auditSession(readFileSync(args[0], "utf8"), args[1], prices, args[4]);
    const auditFile = `${args[3]}.audit.json`, traceFile = `${args[3]}.trace.json`;
    if ([auditFile, traceFile].some(existsSync)) throw new Error("출력 파일이 이미 있어요. 다른 이름을 사용해 주세요.");
    writeFileSync(auditFile, JSON.stringify(output.audit, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    writeFileSync(traceFile, JSON.stringify(output.trace, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`기록된 사용량 ${output.audit.charges.length}건과 작업 요청 ${output.trace.calls.length}건을 내보냈어요.`);
    console.log("금액은 API 환산값이에요. 누락된 청구와 추정값 경고는 audit 파일에서 확인해 주세요.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
