// Senpi-origin loop detection/escalation behavior; MIT attribution and license:
// ./THIRD_PARTY_NOTICES.md

export const TRACK_WINDOW = 64;
export const IDENTICAL_RUN_THRESHOLD = 3;
export const IDENTICAL_BLOCK_NOTICE_THRESHOLD = 2;
export const IDENTICAL_HARD_STOP_BLOCK_THRESHOLD = 3;
export const SIMILAR_RUN_THRESHOLD = 5;
export const SIMILARITY_THRESHOLD = 0.85;
export const CYCLE_MIN_PERIOD = 2;
export const CYCLE_MAX_PERIOD = 6;
export const CYCLE_REPETITION_THRESHOLD = 3;
export const ESCALATION_FACTOR = 2;

export const LOOP_GUARD_NOTICE_CUSTOM_TYPE = "loop-guard:notice";
export const LOOP_GUARD_ESCALATION_CUSTOM_TYPE = "loop-guard:escalation";
export const LOOP_GUARD_RECOVERY_CUSTOM_TYPE = "loop-guard:recovery";
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";
export const CONTINUATION_HOLD_STATE_EVENT = "continuation_hold_state";
const HARD_STOP_WAKE_SOURCE = "loop-guard-hard-stop";

export function loopGuardExtension(pi) {
  const tracker = new ToolCallTracker();
  const gate = new NoticeGate();
  const escalation = new IdenticalLoopEscalation();
  const executionStarts = new Set();
  let pendingRecoveryToolName;
  let recoveryWakeSourceActive = false;
  let continuationHoldActive = false;

  const setRecoveryWakeSourceActive = (active) => {
    if (recoveryWakeSourceActive === active) return;
    recoveryWakeSourceActive = active;
    pi.events?.emit(WAKE_SOURCE_STATE_EVENT, {
      source: HARD_STOP_WAKE_SOURCE,
      activeCount: active ? 1 : 0,
    });
  };
  const setContinuationHoldActive = (active) => {
    if (continuationHoldActive === active) return;
    continuationHoldActive = active;
    pi.events?.emit(CONTINUATION_HOLD_STATE_EVENT, { source: HARD_STOP_WAKE_SOURCE, active });
  };
  const reset = () => {
    tracker.reset();
    gate.reset();
    escalation.reset();
    executionStarts.clear();
    pendingRecoveryToolName = undefined;
    setRecoveryWakeSourceActive(false);
    setContinuationHoldActive(false);
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source !== "extension") reset();
  });
  const observeAttempt = (event, args) => {
    const record = tracker.record(event.toolName, args);
    if (escalation.observeAttempt(event.toolCallId, record)) {
      pendingRecoveryToolName = undefined;
      setRecoveryWakeSourceActive(false);
      setContinuationHoldActive(false);
    }
    const detection = detectLoop(tracker.records, gate);
    if (detection === undefined) return;
    escalation.observeNotice(detection);
    pi.sendMessage({
      customType: LOOP_GUARD_NOTICE_CUSTOM_TYPE,
      content: buildLoopGuardReminder(detection),
      display: true,
      details: detection,
    }, { triggerTurn: false, deliverAs: "steer" });
  };
  pi.on("tool_execution_start", (event) => {
    executionStarts.add(event.toolCallId);
    observeAttempt(event, event.args);
  });
  pi.on("turn_end", () => {
    executionStarts.clear();
    escalation.finishTurn();
  });
  pi.on("tool_call", (event, ctx) => {
    // Stock's model loop emits tool_execution_start first. Programmatic callers
    // using the generic executeTool seam do not, so record exactly once here.
    if (!executionStarts.delete(event.toolCallId)) observeAttempt(event, event.input);
    const decision = escalation.consumeToolCall(event.toolCallId);
    if (decision.kind === "allow") return undefined;
    const reason = buildLoopGuardBlockReason(decision.toolName, decision.blockedCallCount);
    if (decision.kind === "block") return { block: true, reason, terminate: false };

    const warning = buildLoopGuardHardStopWarning(decision.toolName, decision.blockedCallCount);
    setRecoveryWakeSourceActive(true);
    if (!decision.announce) setContinuationHoldActive(true);
    if (decision.announce) {
      pi.sendMessage({
        customType: LOOP_GUARD_ESCALATION_CUSTOM_TYPE,
        content: warning,
        display: true,
        details: { toolName: decision.toolName, blockedCallCount: decision.blockedCallCount },
      }, { triggerTurn: false, deliverAs: "steer" });
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      pendingRecoveryToolName = decision.toolName;
    }
    ctx.abort("system");
    return { block: true, reason, terminate: false };
  });
  pi.on("agent_start", () => {
    setRecoveryWakeSourceActive(false);
    setContinuationHoldActive(false);
  });
  pi.on("agent_settled", () => {
    if (pendingRecoveryToolName === undefined) return;
    const toolName = pendingRecoveryToolName;
    pendingRecoveryToolName = undefined;
    pi.sendMessage({
      customType: LOOP_GUARD_RECOVERY_CUSTOM_TYPE,
      content: buildLoopGuardHardStopSteer(toolName),
      display: false,
    }, { triggerTurn: true });
  });
}

export class ToolCallTracker {
  #calls = [];

  record(toolName, args) {
    const argsJson = canonicalizeArgs(args);
    const record = { toolName, argsJson, signature: `${toolName}\0${argsJson}` };
    this.#calls.push(record);
    if (this.#calls.length > TRACK_WINDOW) this.#calls = this.#calls.slice(-TRACK_WINDOW);
    return record;
  }

  get records() {
    return this.#calls;
  }

  reset() {
    this.#calls = [];
  }
}

export class NoticeGate {
  #entries = new Map();

  admit(detection) {
    const maximumCount = detection.kind === "cycle" ? Math.floor(TRACK_WINDOW / detection.period) : TRACK_WINDOW;
    const existing = this.#entries.get(detection.kind);
    if (existing === undefined || existing.fingerprint !== detection.fingerprint) {
      this.#entries.set(detection.kind, {
        fingerprint: detection.fingerprint,
        lastNotifiedCount: detection.count,
        saturationNotified: detection.count >= maximumCount,
      });
      return true;
    }
    const doubled = detection.count >= existing.lastNotifiedCount * ESCALATION_FACTOR;
    const saturated = !existing.saturationNotified && detection.count >= maximumCount;
    if (!doubled && !saturated) return false;
    existing.lastNotifiedCount = detection.count;
    if (saturated) existing.saturationNotified = true;
    return true;
  }

  prune(active) {
    for (const [kind, entry] of this.#entries) {
      if (active.get(kind) !== entry.fingerprint) this.#entries.delete(kind);
    }
  }

  reset() {
    this.#entries.clear();
  }
}

export class IdenticalLoopEscalation {
  #attempts = new Map();
  #episode;

  observeAttempt(toolCallId, record) {
    const changed = this.#episode !== undefined && this.#episode.fingerprint !== record.signature;
    if (changed) this.reset();
    this.#attempts.set(toolCallId, record);
    return changed;
  }

  observeNotice(detection) {
    if (detection.kind !== "identical") return;
    if (this.#episode === undefined || this.#episode.fingerprint !== detection.fingerprint) {
      this.#episode = {
        fingerprint: detection.fingerprint,
        toolName: detection.toolName,
        admittedNoticeCount: 0,
        activateBlockAfterAttempt: false,
        blockActive: false,
        blockedCallCount: 0,
        hardStopAnnounced: false,
      };
    }
    this.#episode.admittedNoticeCount += 1;
    if (this.#episode.admittedNoticeCount >= IDENTICAL_BLOCK_NOTICE_THRESHOLD) {
      this.#episode.activateBlockAfterAttempt = true;
    }
  }

  finishTurn() {
    this.#attempts.clear();
  }

  consumeToolCall(toolCallId) {
    const attempt = this.#attempts.get(toolCallId);
    this.#attempts.delete(toolCallId);
    if (attempt === undefined || this.#episode === undefined || this.#episode.fingerprint !== attempt.signature) {
      return { kind: "allow" };
    }
    if (!this.#episode.blockActive) {
      if (this.#episode.activateBlockAfterAttempt) {
        this.#episode.activateBlockAfterAttempt = false;
        this.#episode.blockActive = true;
      }
      return { kind: "allow" };
    }
    this.#episode.blockedCallCount += 1;
    if (this.#episode.blockedCallCount >= IDENTICAL_HARD_STOP_BLOCK_THRESHOLD) {
      const announce = !this.#episode.hardStopAnnounced;
      this.#episode.hardStopAnnounced = true;
      return {
        kind: "hardStop",
        toolName: this.#episode.toolName,
        blockedCallCount: this.#episode.blockedCallCount,
        announce,
      };
    }
    return { kind: "block", toolName: this.#episode.toolName, blockedCallCount: this.#episode.blockedCallCount };
  }

  reset() {
    this.#episode = undefined;
    this.#attempts.clear();
  }
}

export function detectLoop(records, gate = new NoticeGate()) {
  const detections = [detectIdenticalRun(records), detectCycle(records), detectSimilarRun(records)];
  const active = new Map();
  for (const detection of detections) if (detection !== undefined) active.set(detection.kind, detection.fingerprint);
  gate.prune(active);
  return detections.find((detection) => detection !== undefined && gate.admit(detection));
}

export function detectIdenticalRun(records) {
  const last = records.at(-1);
  if (last === undefined) return undefined;
  let run = 1;
  for (let index = records.length - 2; index >= 0 && records[index]?.signature === last.signature; index -= 1) run += 1;
  return run < IDENTICAL_RUN_THRESHOLD
    ? undefined
    : { kind: "identical", toolName: last.toolName, count: run, fingerprint: last.signature };
}

export function detectSimilarRun(records) {
  const last = records.at(-1);
  if (last === undefined) return undefined;
  let run = 1;
  for (let index = records.length - 2; index >= 0 && records[index]?.toolName === last.toolName; index -= 1) run += 1;
  if (run < SIMILAR_RUN_THRESHOLD) return undefined;
  const candidates = records.slice(-run);
  const args = candidates.map((record) => record.argsJson);
  if (new Set(args).size === 1 || hasAllDistinctTargets(candidates)) return undefined;
  const similarity = meanAdjacentSimilarity(args);
  return similarity < SIMILARITY_THRESHOLD
    ? undefined
    : { kind: "similar", toolName: last.toolName, count: run, similarity, fingerprint: last.toolName };
}

export function detectCycle(records) {
  const total = records.length;
  for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period += 1) {
    if (total < period * CYCLE_REPETITION_THRESHOLD) continue;
    const cycle = records.slice(total - period);
    if (new Set(cycle.map(({ signature }) => signature)).size < 2) continue;
    let repetitions = 1;
    while ((repetitions + 1) * period <= total) {
      const start = total - (repetitions + 1) * period;
      if (!cycle.every((record, offset) => records[start + offset]?.signature === record.signature)) break;
      repetitions += 1;
    }
    if (repetitions >= CYCLE_REPETITION_THRESHOLD) {
      return {
        kind: "cycle",
        period,
        count: repetitions,
        cycleTools: cycle.map(({ toolName }) => toolName),
        fingerprint: cycle.map(({ signature }) => signature).join("\u0001"),
      };
    }
  }
  return undefined;
}

export function canonicalizeArgs(args) {
  return stableStringify(args ?? {});
}

export function meanAdjacentSimilarity(values) {
  if (values.length < 2) return 1;
  const grams = values.map(bigramCounts);
  let total = 0;
  for (let index = 0; index < grams.length - 1; index += 1) total += diceSimilarity(grams[index], grams[index + 1]);
  return total / (grams.length - 1);
}

function bigramCounts(text) {
  const counts = new Map();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function diceSimilarity(left, right) {
  const leftTotal = [...left.values()].reduce((sum, count) => sum + count, 0);
  const rightTotal = [...right.values()].reduce((sum, count) => sum + count, 0);
  if (leftTotal === 0 || rightTotal === 0) return leftTotal === rightTotal ? 1 : 0;
  let intersection = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const [gram, count] of small) intersection += Math.min(count, large.get(gram) ?? 0);
  return (2 * intersection) / (leftTotal + rightTotal);
}

const TARGET_FIELDS = new Map([
  ["read", ["path"]],
  ["bash_output", ["bash_id"]],
  ["task_output", ["task_id", "name"]],
  ["task_update", ["task_id"]],
  ["task_send", ["to"]],
  ["lsp_diagnostics", ["filePath"]],
]);

function hasAllDistinctTargets(records) {
  const targets = records.map(targetIdentity);
  return targets.every((target) => target !== undefined) && new Set(targets).size === targets.length;
}

function targetIdentity(record) {
  const fields = TARGET_FIELDS.get(record.toolName);
  if (fields === undefined) return undefined;
  let args;
  try { args = JSON.parse(record.argsJson); } catch { return undefined; }
  if (!isRecord(args)) return undefined;
  return fields.map((field) => args[field]).find((value) => typeof value === "string" && value.length > 0);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function buildLoopGuardBlockReason(toolName, blockedCallCount) {
  const polling = toolName === "bash_output" || toolName === "task_output";
  const recovery = polling
    ? "Stop polling this target. If you need to wait for a change, arm a monitor or rely on a completion notification when this mode supports it; otherwise re-plan or choose a different tool."
    : "Reuse the existing result, stop repeating this call, and re-plan from the current goal or choose a different tool.";
  return `Loop guard blocked repeated call ${blockedCallCount} to \`${toolName}\` with arguments that already triggered two identical-call warnings. ${recovery}`;
}

export function buildLoopGuardHardStopWarning(toolName, blockedCallCount) {
  return `Loop guard interrupted the turn after blocking ${blockedCallCount} repeated calls to ${toolName}.`;
}

export function buildLoopGuardHardStopSteer(toolName) {
  return `The loop guard stopped the previous turn because you kept calling \`${toolName}\` with arguments that had already been blocked. Do not repeat that call. Re-plan from the current goal and use a different tool or deliberately changed arguments.`;
}

export function buildLoopGuardReminder(detection) {
  if (detection.kind === "identical") {
    return [
      "<system-reminder>",
      `LOOP GUARD - IDENTICAL TOOL CALLS: you called \`${detection.toolName}\` ${detection.count} times in a row with the EXACT same arguments. This is the tool-call stream, not consecutive text - another tool ran between these calls and it changed nothing about your plan. Re-issuing the same call returns the same result. Snap out of it:`,
      "- reuse the result you already received from this exact call;",
      "- if you were re-checking for new output or state, switch to the monitor/watch tool or change one parameter deliberately (filter, offset, query);",
      "- if nothing is actually changing, stop calling this tool, state what is blocking you, and try a different tool or ask the user.",
      `Do not call \`${detection.toolName}\` again with identical arguments.`,
      "</system-reminder>",
    ].join("\n");
  }
  if (detection.kind === "similar") {
    const percent = Math.round(detection.similarity * 100);
    return [
      "<system-reminder>",
      `LOOP GUARD - NEAR-IDENTICAL TOOL CALLS: your last ${detection.count} calls to \`${detection.toolName}\` had arguments about ${percent}% identical (bigram similarity over canonical args). This may be legitimate batch work - or it may be a lazy loop that only LOOKS like progress. Attention check:`,
      "- if these calls target genuinely different inputs (distinct files, queries, offsets), continue deliberately - but consider batching or widening the scope instead of one call per tiny variation;",
      "- if you are scanning output incrementally (reads, peeks, polls), widen the window once or use the monitor/watch tool rather than nudging parameters;",
      "- if the results keep saying the same thing, change strategy now - a different tool, a wider query, or asking the user beats a sixth near-copy.",
      "</system-reminder>",
    ].join("\n");
  }
  const pattern = detection.cycleTools.join(" -> ");
  return [
    "<system-reminder>",
    `LOOP GUARD - REPEATING TOOL-CALL PATTERN: your recent tool calls repeat the cycle [${pattern}] ${detection.count} times (period ${detection.period}), with other calls possibly interleaved between repetitions. A fixed rotation usually means waiting, guessing, or searching without a discriminator:`,
    "- if this is a wait/poll rotation (spawn then peek, write then check), replace the rotation with the monitor/watch tool and react to the decisive event instead;",
    "- if this is a search rotation, change ONE axis decisively: broader query, different tool, or a different source - repeating the same rotation at the same parameters will not find new information;",
    "- if the cycle is genuinely progressing (each rotation moves distinct work forward), keep going - but say what each rotation accomplished so the next rotation can end.",
    "</system-reminder>",
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
