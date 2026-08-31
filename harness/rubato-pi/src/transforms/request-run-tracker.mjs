// In-repo request-run tracker. Vendor importers are rewritten to this href
// (turn-work-summary pattern). Input records live on real user-message objects
// via WeakMap — never a separate pending-input-ledger module.
import { classifyAssistantMessage } from "./assistant-phase.mjs";

export function requestRunTrackerHref() {
  return import.meta.url;
}

const PREVIEW_CHARS = 500;
const TERMINAL = new Set(["completed", "interrupted", "failed"]);

export function textPreview(text, max = PREVIEW_CHARS) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return [...normalized].slice(0, max).join("");
}

export function countImages(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part?.type === "image").length;
}

export function userMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

export function createInputRecord({
  id,
  delivery,
  source = "unknown",
  text = "",
  imageCount = 0,
  enqueuedAt = Date.now(),
  processedAt,
  targetRequestRunId,
} = {}) {
  return {
    id: String(id ?? ""),
    delivery,
    source: source === "external" ? "remote" : (source === "editor" ? "tui" : source),
    text: String(text ?? ""),
    imageCount: Number(imageCount) || 0,
    enqueuedAt: Number(enqueuedAt) || Date.now(),
    processedAt,
    targetRequestRunId,
  };
}

export function pendingInputSummary(record, targetRequestRunId) {
  return {
    id: record.id,
    delivery: record.delivery === "steer" ? "steer" : "followUp",
    textPreview: textPreview(record.text),
    textLength: [...String(record.text ?? "")].length,
    imageCount: record.imageCount ?? 0,
    enqueuedAt: new Date(record.enqueuedAt).toISOString(),
    source: record.source ?? "unknown",
    ...(targetRequestRunId || record.targetRequestRunId
      ? { targetRequestRunId: targetRequestRunId ?? record.targetRequestRunId }
      : {}),
  };
}

function iso(now, value) {
  if (typeof value === "string") return value;
  const ms = Number.isFinite(value) ? value : now();
  return new Date(ms).toISOString();
}

function legacyId(entryId) {
  return `legacy:${entryId}`;
}

export class RequestRunTracker {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.inputRecords = new WeakMap();
    this.pendingRecords = [];
    this.runs = [];
    this.entries = [];
    this.activeRequestRunId = undefined;
    this.finalCandidateId = undefined;
    this._awaitingInput = false;
  }

  attachRecord(message, record) {
    if (!message || !record?.id) return record;
    this.inputRecords.set(message, record);
    return record;
  }

  getRecord(message) {
    if (!message) return undefined;
    return this.inputRecords.get(message);
  }

  enqueuePending(record) {
    if (!record?.id) return record;
    if (!this.pendingRecords.some((item) => item.id === record.id)) {
      this.pendingRecords.push(record);
    }
    return record;
  }

  dequeuePending(id) {
    const index = this.pendingRecords.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const [record] = this.pendingRecords.splice(index, 1);
    return record;
  }

  updatePendingDelivery(message, delivery, targetRequestRunId) {
    const record = this.getRecord(message);
    if (!record) return undefined;
    record.delivery = delivery;
    if (delivery === "steer") {
      record.targetRequestRunId = targetRequestRunId ?? this.activeRequestRunId;
    } else {
      delete record.targetRequestRunId;
    }
    return record;
  }

  clearPendingInputs() {
    const clearedIds = this.pendingRecords.map((record) => record.id);
    this.pendingRecords = [];
    return { clearedIds };
  }

  activeRun() {
    return this.runs.find((run) => run.id === this.activeRequestRunId);
  }

  onUserMessageStart(message, record) {
    const resolved = record ?? this.getRecord(message) ?? this.#legacyUserRecord(message);
    if (resolved && !record) this.attachRecord(message, resolved);
    if (resolved) {
      this.dequeuePending(resolved.id);
      resolved.processedAt = this.now();
    }
    const delivery = resolved?.delivery ?? "submit";
    const text = resolved?.text ?? userMessageText(message);
    const startedAt = iso(this.now, message?.timestamp ?? this.now());
    const inputId = resolved?.id ?? legacyId(message?.id ?? startedAt);
    const entryId = typeof message?.id === "string" && message.id ? message.id : inputId;

    if (delivery === "steer" && this.activeRequestRunId) {
      const run = this.activeRun();
      if (run && !TERMINAL.has(run.status)) {
        run.steeringCount += 1;
        this.entries.push({
          id: entryId,
          kind: "message",
          role: "user",
          text,
          at: startedAt,
          requestRunId: run.id,
          inputId,
          delivery: "steer",
        });
        this.#demoteFinalCandidate();
        return run;
      }
    }

    if (this.activeRequestRunId) this.completeActive("completed");

    const run = {
      id: inputId,
      status: "running",
      rootUserMessageId: entryId,
      startedAt,
      progressMessageCount: 0,
      toolCount: 0,
      failedToolCount: 0,
      steeringCount: 0,
      _tools: new Map(),
      _progressIds: new Set(),
    };
    this.runs.push(run);
    this.activeRequestRunId = run.id;
    this.finalCandidateId = undefined;
    this._awaitingInput = false;
    this.entries.push({
      id: entryId,
      kind: "message",
      role: "user",
      text,
      at: startedAt,
      requestRunId: run.id,
      inputId,
      delivery: delivery === "followUp" || delivery === "steer" ? delivery : "submit",
    });
    return run;
  }

  onAssistantMessage(message) {
    const run = this.activeRun();
    if (!run || TERMINAL.has(run.status)) return;
    const classified = classifyAssistantMessage(message, run.id);
    const at = iso(this.now, message?.timestamp ?? this.now());
    for (const segment of classified.segments) {
      const existing = this.entries.find((entry) => entry.id === segment.id);
      if (existing) {
        existing.text = segment.text;
        existing.phase = segment.phase;
        existing.streaming = message?.stopReason === "pending" || message?.stopReason === "toolUse";
      } else {
        this.entries.push({
          id: segment.id,
          kind: "message",
          role: "assistant",
          text: segment.text,
          streaming: message?.stopReason === "pending" || message?.stopReason === "toolUse",
          at,
          requestRunId: run.id,
          phase: segment.phase,
        });
      }
      if (segment.phase === "progress") {
        run._progressIds.add(segment.id);
        if (this.finalCandidateId === segment.id) this.finalCandidateId = undefined;
      } else if (segment.phase === "final") {
        this.#setFinalCandidate(segment.id, segment.explicit);
      }
    }
    run.progressMessageCount = run._progressIds.size;
    const preview = [...run._progressIds].at(-1);
    if (preview) {
      const entry = this.entries.find((item) => item.id === preview);
      if (entry) run.lastProgressPreview = textPreview(entry.text);
    }
    if (classified.hasToolCalls) this.#demoteFinalCandidate({ onlyInferred: true });
    if (message?.stopReason === "error") {
      run.failureMessage = message.errorMessage || "Error";
    } else if (message?.stopReason === "aborted") {
      // Abort is terminalized by onInterrupted; keep any existing candidate out.
      this.finalCandidateId = undefined;
    } else if (message?.stopReason) {
      delete run.failureMessage;
    }
    return classified;
  }

  onTool({ id, name, summary, status, output, at, completedAt } = {}) {
    const run = this.activeRun();
    if (!run || TERMINAL.has(run.status) || !id) return;
    const existing = run._tools.get(id) ?? { id, name, status: "running" };
    if (name) existing.name = name;
    if (summary !== undefined) existing.summary = summary;
    if (status) existing.status = status;
    if (output !== undefined) existing.output = output;
    if (at) existing.at = at;
    if (completedAt) existing.completedAt = completedAt;
    run._tools.set(id, existing);
    run.toolCount = run._tools.size;
    run.failedToolCount = [...run._tools.values()].filter((tool) => tool.status === "failed").length;
    this.#demoteFinalCandidate();
    const entryId = id;
    const entry = this.entries.find((item) => item.id === entryId && item.kind === "tool");
    const next = {
      id: entryId,
      kind: "tool",
      name: existing.name ?? "tool",
      summary: existing.summary ?? existing.name ?? "tool",
      status: existing.status,
      output: existing.output,
      at: existing.at ?? iso(this.now, this.now()),
      completedAt: existing.completedAt,
      requestRunId: run.id,
    };
    if (entry) Object.assign(entry, next);
    else this.entries.push(next);
    return existing;
  }

  observe(event) {
    if (!event) return;
    if (event.type === "message_start" && event.message?.role === "user") {
      this.onUserMessageStart(event.message, this.getRecord(event.message));
      return;
    }
    if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message?.role === "assistant") {
      this.onAssistantMessage(event.message);
      return;
    }
    if (event.type === "tool_execution_start") {
      this.onTool({ id: event.toolCallId, name: event.toolName, status: "running" });
      return;
    }
    if (event.type === "tool_execution_end") {
      this.onTool({
        id: event.toolCallId,
        name: event.toolName,
        status: event.isError ? "failed" : "done",
      });
    }
    // compaction / retry / agent_end keep the same run until settled or abort.
  }

  setAwaitingInput(awaiting) {
    const run = this.activeRun();
    if (!run || TERMINAL.has(run.status)) return;
    this._awaitingInput = Boolean(awaiting);
    run.status = this._awaitingInput ? "awaiting_input" : "running";
  }

  onAgentSettled() {
    const run = this.activeRun();
    if (run?.failureMessage && !this.finalCandidateId && !run.finalMessageId) {
      this.completeActive("failed");
      return;
    }
    this.#confirmFinalCandidate();
    this.completeActive("completed");
  }

  onInterrupted(failureMessage) {
    const run = this.activeRun();
    if (run && !TERMINAL.has(run.status)) {
      if (failureMessage) run.failureMessage = failureMessage;
      this.finalCandidateId = undefined;
      delete run.finalMessageId;
    }
    this.completeActive("interrupted");
  }

  onFailed(failureMessage) {
    const run = this.activeRun();
    if (run && !TERMINAL.has(run.status)) {
      run.failureMessage = failureMessage || run.failureMessage || "Error";
      this.finalCandidateId = undefined;
      delete run.finalMessageId;
    }
    this.completeActive("failed");
  }

  completeActive(status = "completed") {
    const run = this.activeRun();
    if (!run || TERMINAL.has(run.status)) {
      if (run && TERMINAL.has(run.status)) this.activeRequestRunId = undefined;
      return run;
    }
    if (status === "completed") this.#confirmFinalCandidate();
    run.status = status;
    run.completedAt = iso(this.now, this.now());
    if (status !== "completed") {
      delete run.finalMessageId;
    }
    this.activeRequestRunId = undefined;
    this._awaitingInput = false;
    return run;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      runs: this.runs.map((run) => this.#runSummary(run)),
      ...(this.activeRequestRunId ? { activeRequestRunId: this.activeRequestRunId } : {}),
      pendingInputs: this.pendingRecords.map((record) => {
        const target = record.delivery === "steer" ? (record.targetRequestRunId ?? this.activeRequestRunId) : undefined;
        return pendingInputSummary(record, target);
      }),
      hasOlder: false,
    };
  }

  readConversationPage({ before, limit = 50 } = {}) {
    const capped = Math.min(100, Math.max(1, Number(limit) || 50));
    let end = this.entries.length;
    if (before) {
      const index = this.entries.findIndex((entry) => entry.id === before);
      if (index === -1) {
        const error = new Error("invalid_cursor");
        error.code = "invalid_action";
        throw error;
      }
      end = index;
    }
    const start = Math.max(0, end - capped);
    const entries = this.entries.slice(start, end);
    return {
      entries,
      requestRuns: this.runs.map((run) => this.#runSummary(run)),
      ...(start > 0 ? { nextBefore: entries[0]?.id } : {}),
    };
  }

  rebuildFromMessages(messages = []) {
    this.runs = [];
    this.entries = [];
    this.activeRequestRunId = undefined;
    this.finalCandidateId = undefined;
    let open = false;
    for (const message of messages) {
      if (message?.role === "user") {
        const classified = this.#legacyUserDelivery(message, open);
        const record = this.#legacyUserRecord(message, classified);
        this.onUserMessageStart(message, record);
        open = true;
        continue;
      }
      if (message?.role === "assistant") {
        this.onAssistantMessage(message);
        for (const block of message.content ?? []) {
          if (block?.type === "toolCall") {
            this.onTool({
              id: block.id ?? `${this.activeRequestRunId}:${block.name}`,
              name: block.name,
              summary: block.name,
              status: "done",
            });
          }
        }
      }
    }
    const lastAssistant = [...messages].reverse().find((item) => item?.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") this.onInterrupted(lastAssistant.errorMessage);
    else if (lastAssistant?.stopReason === "error") this.onFailed(lastAssistant.errorMessage);
    return this.snapshot();
  }

  #runSummary(run) {
    const summary = {
      id: run.id,
      status: run.status,
      rootUserMessageId: run.rootUserMessageId,
      startedAt: run.startedAt,
      progressMessageCount: run.progressMessageCount,
      toolCount: run.toolCount,
      failedToolCount: run.failedToolCount,
      steeringCount: run.steeringCount,
    };
    if (run.completedAt) summary.completedAt = run.completedAt;
    if (run.finalMessageId) summary.finalMessageId = run.finalMessageId;
    if (run.lastProgressPreview) summary.lastProgressPreview = run.lastProgressPreview;
    if (run.failureMessage) summary.failureMessage = run.failureMessage;
    return summary;
  }

  #setFinalCandidate(segmentId, explicit = false) {
    if (this.finalCandidateId && this.finalCandidateId !== segmentId) {
      this.#demoteEntry(this.finalCandidateId);
    }
    this.finalCandidateId = segmentId;
    this._finalCandidateExplicit = Boolean(explicit);
  }

  #demoteFinalCandidate({ onlyInferred = false } = {}) {
    if (!this.finalCandidateId) return;
    if (onlyInferred && this._finalCandidateExplicit) return;
    this.#demoteEntry(this.finalCandidateId);
    this.finalCandidateId = undefined;
    this._finalCandidateExplicit = false;
  }

  #demoteEntry(id) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry || entry.kind !== "message" || entry.role !== "assistant") return;
    entry.phase = "progress";
    const run = this.runs.find((item) => item.id === entry.requestRunId);
    if (run) {
      run._progressIds.add(id);
      run.progressMessageCount = run._progressIds.size;
      if (run.finalMessageId === id) delete run.finalMessageId;
    }
  }

  #confirmFinalCandidate() {
    const run = this.activeRun();
    if (!run || !this.finalCandidateId) return;
    const entry = this.entries.find((item) => item.id === this.finalCandidateId);
    if (!entry || entry.phase !== "final") return;
    run.finalMessageId = entry.id;
    run._progressIds.delete(entry.id);
    run.progressMessageCount = run._progressIds.size;
  }

  #legacyUserRecord(message, delivery = "submit") {
    const entryId = message?.id ?? `ts:${message?.timestamp ?? this.now()}`;
    return createInputRecord({
      id: legacyId(entryId),
      delivery,
      source: "unknown",
      text: userMessageText(message),
      imageCount: countImages(message?.content),
      enqueuedAt: message?.timestamp ?? this.now(),
    });
  }

  #legacyUserDelivery(message, open) {
    if (!open) return "submit";
    const run = this.activeRun();
    if (!run || TERMINAL.has(run.status)) return "submit";
    if (run.finalMessageId) return "followUp";
    if (this.finalCandidateId) return "followUp";
    return "steer";
  }
}

export function attachInputRecord(tracker, message, record) {
  return tracker.attachRecord(message, record);
}

export function getInputRecord(tracker, message) {
  return tracker.getRecord(message);
}
