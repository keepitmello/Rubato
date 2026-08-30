#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function sumAvailable(rows, field) {
  const values = rows.map((row) => row?.[field]);
  return values.every((value) => typeof value === "number") ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function duration(start, end) {
  return typeof start?.monotonicMs === "number" && typeof end?.monotonicMs === "number" ? end.monotonicMs - start.monotonicMs : undefined;
}

function pricingFor(model, prices) {
  const price = prices?.models?.[model];
  if (!price) return { status: "unavailable", reason: `no price for ${model}` };
  const required = ["input", "output", "cacheRead", "cacheWrite"];
  if (!required.every((key) => typeof price[key] === "number" && Number.isFinite(price[key]))) {
    return { status: "unavailable", reason: `incomplete price for ${model}` };
  }
  return { status: "estimated", source: prices.source ?? "unspecified", asOf: prices.asOf, unit: "usd_per_million_tokens", price };
}

function costFor(usage, model, prices) {
  const pricing = pricingFor(model, prices);
  if (pricing.status !== "estimated") return pricing;
  const required = ["newInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "fullInputTokens"];
  if (!required.every((key) => typeof usage?.[key] === "number")) return { ...pricing, status: "unavailable", reason: "incomplete provider token usage" };
  const p = pricing.price;
  const actual = (usage.newInputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead + usage.cacheWriteTokens * p.cacheWrite) / 1_000_000;
  const cold = (usage.fullInputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
  const saved = usage.cacheReadTokens * (p.input - p.cacheRead) / 1_000_000;
  const miss = usage.newInputTokens * Math.max(0, p.input - p.cacheRead) / 1_000_000;
  return { status: "estimated", source: pricing.source, asOf: pricing.asOf, totalUsd: actual, coldUsd: cold, savedUsd: saved, missPremiumUsd: miss };
}

function cacheDiagnosis(call, previous) {
  const usage = call.usage;
  if (!usage || usage.cacheReadTokens === undefined) return [{ kind: "unavailable", confidence: "none", reason: "provider cache usage unavailable" }];
  if (!previous) return [{ kind: "cold_start", confidence: "high", reason: "first observed call" }];
  if (usage.cacheReadTokens > 0) return [{ kind: "cache_hit", confidence: "high", reason: "provider reported cache-read tokens" }];
  const context = call.context;
  if (context?.firstChangedSegment !== undefined) {
    const segment = context.segments?.[context.firstChangedSegment];
    return [{
      kind: "context_prefix_change_candidate",
      confidence: segment?.provenance === "unknown" ? "low" : "medium",
      category: segment?.category ?? "unknown",
      segment: context.firstChangedSegment,
      byte: context.firstChangedByte,
      reason: "provider reported no cache read and measured serialized context changed; this is a candidate, not proof of provider cache behavior",
    }];
  }
  return [{
    kind: "provider_or_unobserved_candidate",
    confidence: "low",
    reason: "provider reported no cache read while measured serialized context was unchanged; routing, eviction, TTL, or unobserved wire differences remain possible and cannot be distinguished here",
  }];
}

export function parseMeasurementJsonl(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`invalid JSONL line ${index + 1}: ${error.message}`); }
  });
}

export function analyzeMeasurements(events, { prices } = {}) {
  const orderedEvents = [...events].sort((a, b) => {
    if (a.processId === b.processId && typeof a.sequence === "number" && typeof b.sequence === "number") return a.sequence - b.sequence;
    const wall = String(a.at ?? "").localeCompare(String(b.at ?? ""));
    return wall || String(a.processId ?? "").localeCompare(String(b.processId ?? "")) || (a.sequence ?? 0) - (b.sequence ?? 0);
  });
  const byCall = new Map();
  const byTask = new Map();
  const tools = new Map();
  for (const event of orderedEvents) {
    if (event.callId) (byCall.get(event.callId) ?? byCall.set(event.callId, []).get(event.callId)).push(event);
    if (event.taskId) (byTask.get(event.taskId) ?? byTask.set(event.taskId, []).get(event.taskId)).push(event);
    if (event.toolCallId) {
      const toolKey = `${event.sessionId ?? "unscoped"}\u0000${event.toolCallId}`;
      (tools.get(toolKey) ?? tools.set(toolKey, []).get(toolKey)).push(event);
    }
  }
  const calls = [...byCall].map(([callId, rows]) => {
    const send = rows.find((row) => row.type === "model.send");
    const first = rows.find((row) => row.type === "model.first_output");
    const end = rows.find((row) => row.type === "model.end");
    const usage = end?.usage;
    return {
      callId,
      taskId: send?.taskId,
      model: send?.model,
      provider: send?.provider,
      attemptId: send?.attemptId,
      previousCallId: send?.previousCallId,
      modelDurationMs: end?.durationMs ?? duration(send, end),
      ttftMs: first?.ttftMs ?? duration(send, first),
      interCallWaitMs: send?.interCallWaitMs,
      usage,
      tokensPerSecond: typeof usage?.outputTokens === "number" && typeof end?.durationMs === "number" && end.durationMs > 0 ? usage.outputTokens / (end.durationMs / 1000) : undefined,
      context: send?.context,
      cost: costFor(usage, send?.model, prices),
    };
  }).sort((a, b) => (byCall.get(a.callId)?.[0]?.sequence ?? 0) - (byCall.get(b.callId)?.[0]?.sequence ?? 0));
  const callsById = new Map(calls.map((call) => [call.callId, call]));
  for (const call of calls) {
    const previous = call.previousCallId ? callsById.get(call.previousCallId) : undefined;
    const sameLineage = previous?.model === call.model && previous?.provider === call.provider;
    call.cacheDropCandidates = cacheDiagnosis(call, sameLineage ? previous : undefined);
  }

  const toolRows = [...tools].map(([toolKey, rows]) => {
    const toolCallId = rows.find((row) => row.toolCallId)?.toolCallId ?? toolKey;
    const request = rows.find((row) => row.type === "tool.request");
    const start = rows.find((row) => row.type === "tool.start");
    const end = rows.find((row) => row.type === "tool.end");
    const reinsertion = rows.find((row) => row.type === "tool.result_reinserted");
    return {
      toolCallId,
      taskId: request?.taskId ?? start?.taskId,
      toolName: request?.toolName ?? start?.toolName,
      executionMs: duration(start, end),
      requestToStartMs: duration(request, start),
      postToolToReinsertionMs: duration(end, reinsertion),
      reinsertionCallId: reinsertion?.callId,
      reinsertionStatus: reinsertion ? "observed" : "unavailable",
      phaseSemantics: "tool.request and tool.start share the engine execution-start boundary; tool.request_validated is a later hook and is not used for latency",
    };
  });

  const tasks = [...byTask].flatMap(([taskId, rows]) => {
    const start = rows.find((row) => row.type === "task.input");
    if (!start) return [];
    const end = rows.find((row) => row.type === "task.end");
    const taskCalls = calls.filter((call) => call.taskId === taskId);
    const taskTools = toolRows.filter((tool) => tool.taskId === taskId);
    const usageRows = taskCalls.map((call) => call.usage);
    const reportedUsage = Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "newInputTokens", "fullInputTokens"].map((field) => [field, sumAvailable(usageRows, field)]).filter(([, value]) => value !== undefined));
    const usage = taskCalls.length === 0
      ? { status: "unavailable", reason: "no model calls correlated to task" }
      : Object.keys(reportedUsage).length === 0
        ? { status: "unavailable", reason: "provider usage unavailable for correlated calls" }
        : { status: "reported", ...reportedUsage };
    if (usage.fullInputTokens > 0 && usage.cacheReadTokens !== undefined) usage.cacheHitRate = usage.cacheReadTokens / usage.fullInputTokens;
    const totalCost = taskCalls.length > 0 && taskCalls.every((call) => call.cost.status === "estimated") ? {
      status: "estimated",
      source: taskCalls[0]?.cost.source,
      totalUsd: taskCalls.reduce((sum, call) => sum + call.cost.totalUsd, 0),
      savedUsd: taskCalls.reduce((sum, call) => sum + call.cost.savedUsd, 0),
      missPremiumUsd: taskCalls.reduce((sum, call) => sum + call.cost.missPremiumUsd, 0),
    } : { status: "unavailable", reason: taskCalls.length === 0 ? "no model calls correlated to task" : taskCalls.find((call) => call.cost.status !== "estimated")?.cost.reason ?? "incomplete call cost" };
    const firstSend = rows.find((row) => row.type === "model.send");
    return [{
      taskId,
      totalDurationMs: end?.durationMs ?? duration(start, end),
      harnessPreModelMs: duration(start, firstSend),
      modelDurationMs: sumAvailable(taskCalls, "modelDurationMs"),
      interCallWaitMs: sumAvailable(taskCalls.slice(1), "interCallWaitMs"),
      toolExecutionMs: sumAvailable(taskTools, "executionMs"),
      harnessPostToolMs: sumAvailable(taskTools, "postToolToReinsertionMs"),
      usage,
      cost: totalCost,
      callIds: taskCalls.map((call) => call.callId),
      toolCallIds: taskTools.map((tool) => tool.toolCallId),
    }];
  });
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), calls, tasks, tools: toolRows };
}

function parseArgs(argv) {
  const args = { format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--prices") args.prices = argv[++index];
    else if (value === "--format") args.format = argv[++index];
    else if (!args.input) args.input = value;
    else throw new Error(`unexpected argument: ${value}`);
  }
  if (!args.input) throw new Error("usage: analyze-measurements.mjs EVENTS.jsonl [--prices prices.json] [--format json]");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const events = parseMeasurementJsonl(readFileSync(args.input, "utf8"));
  const prices = args.prices ? JSON.parse(readFileSync(args.prices, "utf8")) : undefined;
  process.stdout.write(`${JSON.stringify(analyzeMeasurements(events, { prices }), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
