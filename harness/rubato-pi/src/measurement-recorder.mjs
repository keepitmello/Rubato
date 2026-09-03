import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

export const MEASUREMENT_SCHEMA_VERSION = 2;

function enabled(env) {
  return typeof env.RUBATO_MEASUREMENT_LOG === "string" && env.RUBATO_MEASUREMENT_LOG.length > 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function digestSerialized(serialized) {
  return createHash("sha256").update(serialized).digest("hex");
}

function textOfSystem(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
}

function classifySystemSection(text) {
  if (/senpi-memory:|<memory_update>|rubato-memory:/i.test(text)) return { category: "memory", provenance: "marker" };
  if (/(^|\n)(AGENTS\.md|CLAUDE\.md)|<project_context>|project instructions/i.test(text)) return { category: "project_fixed_context", provenance: "marker" };
  if (/RUBATO_ROLE|<role>|you are .*?(lead|member|teammate)/i.test(text)) return { category: "role", provenance: "heuristic" };
  if (/user config|user instructions|global instructions/i.test(text)) return { category: "user_config", provenance: "heuristic" };
  if (/dynamic instructions|turn context|<fx-turn-context>|rubato-memory:notice/i.test(text)) return { category: "dynamic_instructions", provenance: "marker" };
  return { category: "harness_base", provenance: "position" };
}

function segment(item, category, provenance, source) {
  const serialized = JSON.stringify(item);
  return {
    category,
    provenance,
    source,
    digest: digestSerialized(serialized),
    bytes: Buffer.byteLength(serialized),
    serialized,
  };
}

function sessionIdFrom(ctx) {
  const manager = ctx?.sessionManager;
  const getSessionId = manager?.getSessionId;
  if (typeof getSessionId !== "function") return undefined;
  const id = getSessionId.call(manager);
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function normalizeProviderUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const nestedInput = usage.inputTokens && typeof usage.inputTokens === "object" ? usage.inputTokens : undefined;
  const nestedOutput = usage.outputTokens && typeof usage.outputTokens === "object" ? usage.outputTokens : undefined;
  const inputTokens = finite(nestedInput?.total ?? usage.input_tokens ?? usage.input);
  const cacheReadTokens = finite(nestedInput?.cacheRead ?? usage.cached_input_tokens ?? usage.cacheRead);
  const cacheWriteTokens = finite(nestedInput?.cacheWrite ?? usage.cache_write_tokens ?? usage.cacheWrite);
  const newInputTokens = finite(nestedInput?.noCache ?? usage.uncached_input_tokens);
  const outputTokens = finite(nestedOutput?.total ?? usage.output_tokens ?? usage.output);
  const reasoningTokens = finite(nestedOutput?.reasoning ?? usage.reasoning_tokens ?? usage.reasoning);
  /** @type {Record<string, number>} */
  const normalized = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(newInputTokens === undefined ? {} : { newInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
  if (normalized.newInputTokens === undefined && normalized.inputTokens !== undefined && normalized.cacheReadTokens !== undefined) {
    normalized.newInputTokens = Math.max(0, normalized.inputTokens - normalized.cacheReadTokens - (normalized.cacheWriteTokens ?? 0));
  }
  const fullInputTokens = normalized.inputTokens ?? (
    normalized.newInputTokens !== undefined && normalized.cacheReadTokens !== undefined && normalized.cacheWriteTokens !== undefined
      ? normalized.newInputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens
      : undefined
  );
  if (fullInputTokens !== undefined) normalized.fullInputTokens = fullInputTokens;
  if (fullInputTokens > 0 && normalized.cacheReadTokens !== undefined) {
    normalized.cacheHitRate = normalized.cacheReadTokens / fullInputTokens;
  }
  // Anthropic 서버 컴팩션 iteration (어댑터 패치가 `usage.compaction` 으로 옮김) — 최상위
  // 숫자는 압축 *이후* 컨텍스트라서 이 iteration 을 따로 남겨야 청구가 맞는다.
  const compaction = usage.compaction && typeof usage.compaction === "object" ? usage.compaction : undefined;
  if (compaction) {
    const compactionInputTokens = finite(compaction.input);
    const compactionOutputTokens = finite(compaction.output);
    const compactionCacheReadTokens = finite(compaction.cacheRead);
    const compactionCacheWriteTokens = finite(compaction.cacheWrite);
    Object.assign(normalized, {
      ...(compactionInputTokens === undefined ? {} : { compactionInputTokens }),
      ...(compactionOutputTokens === undefined ? {} : { compactionOutputTokens }),
      ...(compactionCacheReadTokens === undefined ? {} : { compactionCacheReadTokens }),
      ...(compactionCacheWriteTokens === undefined ? {} : { compactionCacheWriteTokens }),
    });
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function contextSegments(body) {
  const segments = [];
  for (const item of Array.isArray(body?.prompt) ? body.prompt : []) {
    if (item?.role === "system") {
      const classified = classifySystemSection(textOfSystem(item));
      segments.push(segment(item, classified.category, classified.provenance, "system_prompt"));
    } else if (item?.role === "tool") {
      segments.push(segment(item, "tool_results", "role", "conversation_message"));
    } else if (item?.role === "user" || item?.role === "assistant") {
      segments.push(segment(item, "conversation", "role", "conversation_message"));
    } else {
      segments.push(segment(item, "unknown", "unknown", "prompt_item"));
    }
  }
  if (Array.isArray(body?.tools)) segments.push(segment(body.tools, "harness_base", "wire_field", "tool_definitions"));
  return segments.map(({ serialized, ...value }, index) => ({ index, ...value, _serialized: serialized }));
}

function firstChangedByte(previous = "", current = "") {
  const before = Buffer.from(previous);
  const after = Buffer.from(current);
  const length = Math.min(before.length, after.length);
  let index = 0;
  while (index < length && before[index] === after[index]) index += 1;
  return index === before.length && index === after.length ? undefined : index;
}

export function contextChange(previous = [], current = []) {
  const length = Math.max(previous.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const before = previous[index];
    const after = current[index];
    if (before?.category !== after?.category || before?.digest !== after?.digest) {
      return { segment: index, byte: firstChangedByte(before?._serialized ?? "", after?._serialized ?? "") ?? 0 };
    }
  }
  return undefined;
}

export function firstChangedSegment(previous = [], current = []) {
  return contextChange(previous, current)?.segment;
}

export function createMeasurementRecorder({ env = process.env, now = () => new Date(), monotonic = () => performance.now(), append = appendFileSync } = {}) {
  if (!enabled(env)) return undefined;
  const logPath = env.RUBATO_MEASUREMENT_LOG;
  mkdirSync(dirname(logPath), { recursive: true });
  let sequence = 0;
  const processId = env.RUBATO_MEASUREMENT_PROCESS_ID ?? `${process.pid}-${randomUUID()}`;
  const taskStarts = new Map();
  const activeTasks = new Map();
  const callStarts = new Map();
  const contexts = new Map();
  const sessionCalls = new Map();
  const reinsertedTools = new Map();
  const record = (type, fields = {}) => {
    const event = { schemaVersion: MEASUREMENT_SCHEMA_VERSION, processId, sequence: ++sequence, type, at: now().toISOString(), monotonicMs: monotonic(), ...fields };
    append(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  };
  const captureContext = (sessionId, callId, body) => {
    const segments = contextSegments(body);
    const scoped = typeof sessionId === "string" && sessionId.length > 0;
    const previous = scoped ? contexts.get(sessionId) ?? [] : [];
    if (scoped) contexts.set(sessionId, segments);
    const changed = contextChange(previous, segments);
    let rawContextPath;
    if (env.RUBATO_MEASUREMENT_CAPTURE_RAW === "1" && env.RUBATO_MEASUREMENT_RAW_DIR) {
      mkdirSync(env.RUBATO_MEASUREMENT_RAW_DIR, { recursive: true, mode: 0o700 });
      rawContextPath = join(env.RUBATO_MEASUREMENT_RAW_DIR, `${callId}.json`);
      writeFileSync(rawContextPath, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const publicSegments = segments.map(({ _serialized, ...segment }) => segment);
    return {
      segments: publicSegments,
      ...(changed === undefined ? {} : { firstChangedSegment: changed.segment, firstChangedByte: changed.byte }),
      ...(rawContextPath ? { rawContextPath } : {}),
    };
  };
  return {
    record,
    startTask(taskId, fields = {}) {
      const at = monotonic();
      taskStarts.set(taskId, at);
      if (fields.sessionId) activeTasks.set(fields.sessionId, taskId);
      return record("task.input", { taskId, ...fields, monotonicMs: at });
    },
    endTask(taskId, fields = {}) {
      const at = monotonic();
      const start = taskStarts.get(taskId);
      taskStarts.delete(taskId);
      if (fields.sessionId && activeTasks.get(fields.sessionId) === taskId) activeTasks.delete(fields.sessionId);
      return record("task.end", { taskId, ...fields, ...(start === undefined ? {} : { durationMs: at - start }), monotonicMs: at });
    },
    activeTaskId(sessionId) {
      return activeTasks.get(sessionId);
    },
    pendingCallIds(taskId) {
      return [...callStarts].filter(([, call]) => call.taskId === taskId).map(([callId]) => callId);
    },
    startCall({ taskId, sessionId, provider, model, body }) {
      const callId = randomUUID();
      const attemptId = randomUUID();
      const resolvedTaskId = taskId ?? activeTasks.get(sessionId);
      const at = monotonic();
      const scoped = typeof sessionId === "string" && sessionId.length > 0;
      const lineageKey = scoped ? `${sessionId}\u0000${provider}\u0000${model}` : undefined;
      const previousCall = lineageKey ? sessionCalls.get(lineageKey) : undefined;
      if (lineageKey) sessionCalls.set(lineageKey, { callId, endAt: undefined });
      callStarts.set(callId, { at, firstOutputAt: undefined, sessionId, lineageKey, taskId: resolvedTaskId });
      return {
        callId,
        attemptId,
        event: record("model.send", {
          taskId: resolvedTaskId,
          sessionId,
          callId,
          attemptId,
          ...(previousCall ? { previousCallId: previousCall.callId } : {}),
          ...(previousCall?.endAt === undefined ? {} : { interCallWaitMs: at - previousCall.endAt }),
          provider,
          model,
          context: captureContext(sessionId, callId, body),
          monotonicMs: at,
        }),
      };
    },
    firstOutput(callId, fields = {}) {
      const call = callStarts.get(callId);
      if (!call || call.firstOutputAt !== undefined) return undefined;
      call.firstOutputAt = monotonic();
      return record("model.first_output", { callId, ...fields, ttftMs: call.firstOutputAt - call.at, monotonicMs: call.firstOutputAt });
    },
    endCall(callId, fields = {}) {
      const at = monotonic();
      const call = callStarts.get(callId);
      callStarts.delete(callId);
      if (call) {
        const current = call.lineageKey ? sessionCalls.get(call.lineageKey) : undefined;
        if (current?.callId === callId) current.endAt = at;
      }
      return record("model.end", { callId, ...fields, ...(call ? { durationMs: at - call.at } : {}), monotonicMs: at });
    },
    observeToolReinsertion({ sessionId, toolCallId, ...fields }) {
      if (!toolCallId) return undefined;
      const toolKey = `${sessionId ?? "unscoped"}\u0000${toolCallId}`;
      const repeated = reinsertedTools.has(toolKey);
      reinsertedTools.set(toolKey, true);
      return record(repeated ? "tool.result_present" : "tool.result_reinserted", {
        sessionId,
        toolCallId,
        presence: repeated ? "repeated" : "first_reinsertion",
        ...fields,
      });
    },
  };
}

let shared;
export function measurementRecorder(env = process.env) {
  if (!enabled(env)) return undefined;
  if (!shared || shared.path !== env.RUBATO_MEASUREMENT_LOG) shared = { path: env.RUBATO_MEASUREMENT_LOG, value: createMeasurementRecorder({ env }) };
  return shared.value;
}

export function installMeasurementHooks(pi, { env = process.env, recorder = measurementRecorder(env) } = {}) {
  if (!recorder) return;
  const taskIds = new Map();
  const id = (ctx) => sessionIdFrom(ctx) ?? "anonymous";
  pi.on("input", (event, ctx) => {
    if (event?.source === "extension") return { action: "continue" };
    const sessionId = id(ctx);
    const taskId = event?.inputId ?? randomUUID();
    taskIds.set(sessionId, taskId);
    recorder.startTask(taskId, { sessionId, source: event?.source, inputBytes: Buffer.byteLength(event?.text ?? "") });
    return { action: "continue" };
  });
  pi.on("tool_call", (event, ctx) => recorder.record("tool.request_validated", { taskId: taskIds.get(id(ctx)), sessionId: id(ctx), toolCallId: event?.toolCallId, toolName: event?.toolName }));
  pi.on("tool_execution_start", (event, ctx) => {
    const fields = { taskId: taskIds.get(id(ctx)), sessionId: id(ctx), toolCallId: event?.toolCallId, toolName: event?.toolName };
    recorder.record("tool.request", fields);
    recorder.record("tool.start", fields);
  });
  pi.on("tool_execution_end", (event, ctx) => recorder.record("tool.end", { taskId: taskIds.get(id(ctx)), sessionId: id(ctx), toolCallId: event?.toolCallId, toolName: event?.toolName, isError: event?.isError === true }));
  pi.on("tool_result", (event, ctx) => recorder.record("tool.result_ready", { taskId: taskIds.get(id(ctx)), sessionId: id(ctx), toolCallId: event?.toolCallId, toolName: event?.toolName, isError: event?.isError === true }));
  pi.on("agent_end", (event, ctx) => {
    if (event?.willRetry) return;
    const sessionId = id(ctx);
    const taskId = taskIds.get(sessionId);
    if (!taskId) return;
    taskIds.delete(sessionId);
    try {
      const pendingCallIds = recorder.pendingCallIds(taskId);
      if (pendingCallIds.length > 0) {
        recorder.record("instrumentation.error", { taskId, sessionId, invariant: "pending_model_calls", pendingCallIds });
        recorder.endTask(taskId, { sessionId, aborted: event?.aborted === true, status: "incomplete", incompleteReason: "pending_model_calls" });
        return;
      }
      recorder.endTask(taskId, { sessionId, aborted: event?.aborted === true, status: "complete" });
    } catch (error) {
      try {
        recorder.record("instrumentation.error", { taskId, sessionId, invariant: "agent_end_recording", error: error instanceof Error ? error.message : String(error) });
        recorder.endTask(taskId, { sessionId, aborted: event?.aborted === true, status: "incomplete", incompleteReason: "instrumentation_error" });
      } catch {}
    }
  });
}
