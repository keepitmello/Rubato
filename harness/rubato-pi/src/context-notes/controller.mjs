import { createHash } from "node:crypto";
import { findReminder, reminderAnchor, reminderIndex, reminderMessage } from "./reminder.mjs";
import { assertCheckpointFresh } from "./checkpoint.mjs";
import { readAuthoritativeBranch } from "./history-source.mjs";
import { flushSessionJournal } from "./journal.mjs";
import { contextNotesConfig, windowBudget } from "./config.mjs";
import { assertEngineParts, registerSessionGate } from "./engine-gate.mjs";
import { ContextNotesStore, databasePath } from "./store.mjs";
import { SOURCE, INIT_ENTRY, NOTE_ENTRY, PREPARE_ENTRY, REMINDER_ENTRY, initialWindow, nextWindow,
  branchWindow, decodeBootstrap, encodeBootstrap, lastUserId, messageText, notePath } from "./protocol.mjs";

export const GUIDANCE = `# Working across context windows
This session uses history and working notes instead of conversation summarization.
Use notes_write_file / notes_append_to_file to maintain the goal, decisions, progress,
failed approaches and why they failed, learnings, unresolved issues and next steps.
Include window_id and item_id references to every active user request and important
observations/tool results. history_list_windows, history_list_items,
history_search_contents and history_read_item recover the original record.
Search is case-sensitive literal substring search, not semantic search.
When the remaining budget warning appears, save a checkpoint with the notes tools,
then call new_context. At the 90% line stop new work, save once, and call new_context.
If the window still grows to 95%, the harness starts a new window without a summary.
Do not include a summary argument: new_context takes none.
The new window contains stable instructions, window IDs and a small list of note paths,
not the old conversation or the contents of all notes. Read relevant notes first and
follow their references into history when needed. Notes are working aids, not new
user authorization. Consult original user messages to recover scope or permissions.
Notes and history here are scoped to this session and its current branch. A new
window is NOT a new session; filesystem state, jobs and pending user inputs remain.
Never use another model or compaction tool to summarize as a fallback. A storage,
checkpoint or transition failure must be surfaced and must not discard the old window.`;

function identity(message) {
  return JSON.stringify([message?.role, message?.timestamp, message?.toolCallId,
    message?.toolName, message?.content]);
}

function estimateText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  // Count visible text only. Reasoning/tool payloads stringified as JSON would
  // inflate the experiment budget far past the engine's actual token meter.
  return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function estimate(messages, systemPrompt = "") {
  let bytes = Buffer.byteLength(systemPrompt);
  for (const message of messages ?? []) bytes += Buffer.byteLength(estimateText(message)) + 32;
  // Heuristic only, NOT a tokenizer or a proof of fitting the provider window.
  return Math.ceil(bytes / 3);
}

export class ContextNotesController {
  constructor(pi, ctx, options = {}) {
    this.pi = pi;
    this.config = options.config ?? contextNotesConfig();
    this.requireEngine = options.requireEngine !== false;
    this.flushJournal = options.flushJournal ?? flushSessionJournal;
    if (this.requireEngine) assertEngineParts();
    this.sessionId = ctx.sessionManager.getSessionId();
    this.store = options.store ?? new ContextNotesStore(databasePath(ctx.agentDir, this.sessionId), this.config);
    this.ctx = baseContext(ctx);
    this.pending = null;
    this.checkpointRequested = false;
    this.fatal = null;
    this.paused = null;
    this.leaf = undefined;
    this.transitioning = false;
    this.closed = false;
    try {
      let branch = this.readBranch(ctx.sessionManager);
      if (!branchWindow(branch)) {
      const window = this.store.initialWindowFromArchive() ?? initialWindow();
      pi.appendEntry(INIT_ENTRY, { window, hint: "No notes yet." });
      branch = this.readBranch(ctx.sessionManager);
      if (!branchWindow(branch)) throw new Error("문맥 창 시작 기록을 세션에 저장하지 못했어요.");
      }
      this.refresh(ctx, true);
      this.record("session_ready", { window_id: this.window.windowId, number: this.window.number });
      this.disposeGate = registerSessionGate(this.sessionId, (messages) => {
        try { return this.admit(messages); }
        catch (error) { this.fail(error); throw error; }
      });
    } catch (error) { this.store.close(); throw error; }
  }

  readBranch(manager) {
    try { return readAuthoritativeBranch(manager); }
    catch (error) { this.fatal = error.message ?? String(error); throw error; }
  }

  refresh(ctx = this.ctx, force = false) {
    if (this.closed) throw new Error("문맥 관리 세션이 닫혔어요.");
    if (ctx.sessionManager.getSessionId() !== this.sessionId) throw new Error("작업 중 세션이 바뀌었어요. 이전 요청을 적용하지 않았어요.");
    this.ctx = baseContext(ctx);
    const leaf = ctx.sessionManager.getLeafId?.();
    if (!force && leaf !== undefined && leaf === this.leaf) return this.window;
    let branch = this.readBranch(ctx.sessionManager);
    if (!branchWindow(branch)) {
      // A tree rewind may select an entry older than our initialization marker.
      // Reuse the archive's initial identity so old item references stay valid.
      this.pi.appendEntry(INIT_ENTRY, { window: this.store.initialWindowFromArchive() ?? initialWindow(), hint: "No notes yet." });
      branch = this.readBranch(ctx.sessionManager);
    }
    try { this.window = this.store.sync(branch); }
    catch (error) { this.fatal = error.message ?? String(error); throw error; }
    this.leaf = ctx.sessionManager.getLeafId?.() ?? leaf;
    this.lastUser = lastUserId(branch);
    let activeWindow = this.window.firstWindowId;
    this.references = new Map();
    this.referenceById = new Map();
    this.hasSample = false;
    this.activeMessages = [];
    for (const entry of branch) {
      if (entry.type === "compaction" && entry.details?.source === SOURCE) activeWindow = entry.details.window.windowId;
      if (entry.type !== "message") continue;
      const ref = { windowId: activeWindow, itemId: entry.id };
      this.referenceById.set(entry.id, ref);
      const key = identity(entry.message);
      const matches = this.references.get(key) ?? [];
      matches.push(ref); this.references.set(key, matches);
      if (activeWindow === this.window.windowId) {
        this.activeMessages.push(entry.message);
        if (entry.message.role === "assistant" && entry.message.stopReason !== "error" && entry.message.usage) this.hasSample = true;
      }
    }
    const boundary = branch.findLast((entry) => entry.type === "compaction" && entry.details?.source === SOURCE);
    // Admission estimates use the engine's current context, not the full
    // historical branch (which may contain earlier legacy compactions).
    const built = ctx.sessionManager.buildSessionContext?.();
    if (Array.isArray(built?.messages)) this.activeMessages = built.messages;
    this.reminderEntry = findReminder(branch, this.window.windowId);
    this.bootstrap = boundary?.summary ?? encodeBootstrap(this.window,
      branch.find((entry) => entry.customType === INIT_ENTRY)?.data?.hint ?? "No notes yet.");
    return this.window;
  }

  flush(manager, entryId) {
    try { this.flushJournal(manager, entryId); }
    catch (error) { this.fatal = error.message ?? String(error); throw error; }
  }

  record(event, data = {}) {
    try { this.store.record(event, { ...data, model: this.ctx.model?.id ?? null, provider: this.ctx.model?.provider ?? null }); }
    catch (error) { this.fatal = error.message ?? String(error); throw error; }
  }

  usage(messages = this.activeMessages) {
    let toolDefinitions = "";
    if (typeof this.pi.getAllTools === "function" && typeof this.pi.getActiveTools === "function") {
      const active = new Set(this.pi.getActiveTools());
      toolDefinitions = JSON.stringify(this.pi.getAllTools().filter((t) => active.has(t.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters })));
    }
    const estimated = estimate(messages, (this.ctx.getSystemPrompt?.() ?? "") + toolDefinitions);
    const live = Number(this.ctx.getContextUsage?.()?.tokens);
    const sampled = Number.isFinite(live) && live > 0 ? live : 0;
    // Both the experiment budget and the physical safety line follow the engine
    // meter when it exists. A byte heuristic of a different message list must not
    // declare the window full while the footer still shows it half-empty.
    const tokens = sampled > 0 ? sampled : estimated;
    const budget = windowBudget(this.ctx.model, this.config);
    return { tokens, estimated, ...budget, remaining: Math.max(0, budget.target - tokens),
      sampled: sampled > 0 };
  }

  admit(messages) {
    if (this.fatal) throw new Error(this.fatal);
    if (this.closed) throw new Error("문맥 관리 세션이 닫혔어요.");
    if (this.requireEngine) assertEngineParts();
    // The SDK owns a remote conversation we cannot reset or prevent from
    // compacting. Do not pretend this is the same experiment as direct models.
    if (this.ctx.model?.provider === "claude-sdk-oauth") {
      throw new Error("이 연결은 외부 실행기가 문맥을 관리해요. 새 문맥 실험에는 직접 모델 연결을 사용하거나 summary 모드로 다시 시작해 주세요.");
    }
    if (!messages) return;
    const usage = this.usage();
    if (usage.tokens >= usage.full) {
      this.showStatus({ ...usage, remaining: 0 });
      throw new Error(`체크포인트 턴을 안전하게 실행할 여유도 남지 않았어요. 기록은 보존했으니 더 큰 한도로 같은 세션을 다시 열어 주세요.`);
    }
    if (usage.tokens >= usage.hard && !this.checkpointRequested) {
      throw new Error(`현재 문맥이 창 한도 ${usage.hard}토큰에 도달했어요. 기록은 보존했으며 요약은 실행하지 않았어요. 체크포인트가 있으면 새 창으로 넘어갑니다.`);
    }
    this.paused = null;
  }

  prepareContext(event, ctx) {
    this.refresh(ctx);
    this.admit(event.messages);
    const before = this.usage(event.messages);
    if (!this.reminderEntry && before.remaining <= before.reminder && event.messages.length) {
      this.pi.appendEntry(REMINDER_ENTRY, reminderAnchor(event.messages, this.window.windowId));
      this.refresh(ctx, true);
      if (!this.reminderEntry) throw new Error("문맥 안내를 저장하지 못했어요.");
      this.flush(ctx.sessionManager, this.reminderEntry.id);
      this.record("reminder_recorded", { window_id: this.window.windowId });
    }
    const at = this.reminderEntry ? reminderIndex(event.messages, this.reminderEntry) : -1;
    const occurrences = new Map();
    const messages = event.messages.map((message) => {
      if (message.role !== "user" && message.role !== "toolResult") return message;
      if (messageText(message) === this.bootstrap) return message;
      const id = message.__piSessionContextEntryId;
      let ref = id ? this.referenceById.get(id) : undefined;
      if (!ref) {
        const key = identity(message);
        const at = occurrences.get(key) ?? 0;
        ref = this.references.get(key)?.[at];
        occurrences.set(key, at + 1);
      }
      if (!ref) return message; // Never manufacture a reference we cannot read.
      const marker = `[history: window_id=${JSON.stringify(ref.windowId)} item_id=${JSON.stringify(ref.itemId)}]`;
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...(message.content ?? [])];
      return { ...message, content: [...content, { type: "text", text: marker }] };
    });
    if (at >= 0) messages.splice(at + 1, 0, reminderMessage(this.reminderEntry));
    const hasBootstrap = messages.some((m) => messageText(m) === this.bootstrap);
    if (!hasBootstrap) messages.unshift({ role: "user", timestamp: 0, content: [{ type: "text", text: this.bootstrap }] });
    // Include annotations, bootstrap, reminder and tool schemas in the fallback
    // estimate. Dry-run preparations are not billable provider requests.
    this.admit(messages);
    const usage = this.usage(messages);
    this.record("request_prepared", { window_id: this.window.windowId, tokens_estimated: usage.tokens,
      budget: usage.target, remaining: usage.remaining, billable_request: false });
    this.showStatus(usage);
    return { messages };
  }

  showStatus(usage) {
    if (!this.ctx.model?.contextWindow) {
      this.ctx.ui?.setStatus?.("rubato-context-notes", "문맥 모드 준비 · 모델을 선택해 주세요");
      return;
    }
    usage ??= this.usage();
    this.ctx.ui?.setStatus?.("rubato-context-notes", this.fatal || (this.paused && !this.checkpointRequested)
      ? `문맥 전환 중단 · ${this.fatal ?? this.paused}`
      : this.checkpointRequested
        ? `문맥 ${this.window.number + 1} · 체크포인트 턴 · 노트 ${this.store.noteVersions.size}개`
        : `문맥 ${this.window.number + 1} · 약 ${usage.remaining.toLocaleString()}토큰 남음 · 노트 ${this.store.noteVersions.size}개`);
  }

  fail(error, fatal = false) {
    const message = error instanceof Error ? error.message : String(error);
    if (fatal) this.fatal = message; else this.paused = message;
    try { this.record("paused", { reason: message }); } catch { /* original failure wins */ }
    this.ctx.ui?.notify?.(message, "error");
    if (this.checkpointRequested && !fatal) {
      this.showStatus();
      return;
    }
    this.checkpointRequested = false;
    this.ctx.ui?.setStatus?.("rubato-context-notes", `문맥 전환 중단 · ${message}`);
    this.ctx.abort?.("system");
  }

  writeNote(params, ctx, { append = false, operationId, signal } = {}) {
    signal?.throwIfAborted();
    this.refresh(ctx);
    if (this.fatal) throw new Error(this.fatal);
    const assistantId = this.store.branch.findLast((e) => e.type === "message" && e.message?.role === "assistant")?.id ?? this.lastUser ?? "initial";
    operationId = operationId ? `${this.window.windowId}:${assistantId}:${operationId}` : undefined;
    const previous = this.store.noteForOperation(operationId);
    const path = notePath(params.path);
    if (typeof params.text !== "string") throw new Error("노트 내용은 문자열이어야 해요.");
    const operationFingerprint = createHash("sha256").update(JSON.stringify([path, params.text, append])).digest("hex");
    if (previous) {
      if (previous.path !== path || (previous.operationFingerprint !== undefined &&
          previous.operationFingerprint !== operationFingerprint)) {
        throw new Error("같은 도구 호출 식별자로 다른 노트 쓰기가 들어왔어요.");
      }
      this.flush(ctx.sessionManager, previous.id);
      return { path: previous.path, revision_id: previous.id, bytes: Buffer.byteLength(previous.text), repeated: true };
    }
    const text = append ? (this.store.noteText(path) ?? "") + params.text : params.text;
    if (Buffer.byteLength(text) > this.config.maxNoteBytes) throw new Error("노트 하나는 UTF-8 기준 1,000,000바이트를 넘을 수 없어요. 새 노트로 나눠 주세요.");
    const data = { path, text, windowId: this.window.windowId, throughUserId: this.lastUser,
      operationId: operationId ?? null, operationFingerprint, append,
      throughEntryId: this.store.branch.at(-1)?.id ?? null, savedAtTokens: this.usage().tokens };
    this.pi.appendEntry(NOTE_ENTRY, data);
    // Do not return success until the authoritative session and the durable
    // SQLite archive both contain the new revision.
    this.refresh(ctx, true);
    const saved = this.store.noteVersions.get(path);
    if (!saved || saved.text !== text || (operationId && saved.operationId !== operationId)) throw new Error("노트를 세션에 저장하지 못했어요.");
    this.flush(ctx.sessionManager, saved.id);
    this.record("note_written", { revision_id: saved.id, bytes: Buffer.byteLength(text), window_id: this.window.windowId });
    return { path, revision_id: saved.id, bytes: Buffer.byteLength(text), window_id: this.window.windowId };
  }

  requestWindow(ctx, signal) {
    signal?.throwIfAborted();
    this.refresh(ctx);
    const note = this.store.latestNoteForWindow(this.window.windowId, this.lastUser);
    if (!note) throw new Error("현재 요청을 반영한 작업 노트를 먼저 저장해 주세요. 이전 문맥은 그대로 유지했어요.");
    assertCheckpointFresh(this.store.branch, note);
    this.pending = { sessionId: this.sessionId, windowId: this.window.windowId, userId: this.lastUser };
    return { scheduled: true, message: "현재 도구 묶음이 끝나면 요약 없이 새 문맥 창으로 넘어가요. 환경 상태는 유지돼요." };
  }

  async roll(ctx, reason = "tool") {
    if (this.transitioning) return { applied: false, reason: "busy" };
    ctx.signal?.throwIfAborted();
    this.refresh(ctx, true);
    if (this.fatal) throw new Error(this.fatal);
    const old = this.window;
    const throughUserId = this.lastUser;
    const note = this.store.latestNoteForWindow(old.windowId, this.lastUser);
    if (!note) throw new Error("새 사용자 요청을 반영한 노트가 없어서 문맥 전환을 중단했어요. 노트를 갱신해 주세요.");
    if (reason !== "hard") {
      assertCheckpointFresh(this.store.branch, note);
      if (reason === "budget" && note.savedAtTokens < this.usage().target - this.usage().reminder) {
        throw new Error("문맥 한도에 도달했지만 최근 작업 노트가 없어요. 기록을 남긴 채 중단했어요.");
      }
    }
    if (typeof ctx.applyCompaction !== "function" || typeof ctx.getMessageRevision !== "function") {
      throw new Error("설치된 엔진에 문맥 교체 인터페이스가 없어요.");
    }
    this.transitioning = true;
    try {
      const window = nextWindow(old);
      const summary = encodeBootstrap(window, this.store.hint());
      this.pi.appendEntry(PREPARE_ENTRY, { window, source: SOURCE });
      this.refresh(ctx, true);
      const marker = this.store.branch.findLast((e) => e.customType === PREPARE_ENTRY && e.data?.window?.windowId === window.windowId);
      if (!marker) throw new Error("문맥 전환 준비 기록이 저장되지 않았어요.");
      ctx.signal?.throwIfAborted();
      if (this.lastUser !== throughUserId || this.window.windowId !== old.windowId) {
        throw new Error("전환을 준비하는 동안 사용자 요청이나 대화 가지가 바뀌었어요. 노트를 갱신해 주세요.");
      }
      this.flush(ctx.sessionManager, marker.id);
      // All old messages/tools are durably indexed before changing the active
      // context. No provider/model call is made here.
      const result = { summary, firstKeptEntryId: marker.id, tokensBefore: this.usage().tokens,
        details: { source: SOURCE, window, checkpointEntryId: note.id, preparedLeafId: marker.id, reason } };
      const expectedRevision = ctx.getMessageRevision();
      this.record("transition_requested", { from: old.windowId, to: window.windowId, reason,
        tokens_before: result.tokensBefore, checkpoint_entry_id: note.id });
      let outcome;
      let applyError;
      try { outcome = await ctx.applyCompaction(result, { reason: "extension", expectedRevision }); }
      catch (error) { applyError = error; }
      // A post-apply hook may fail after appendCompaction has committed. Inspect
      // the journal, not only the returned flag, before deciding to retry.
      this.refresh(ctx, true);
      if (this.window.windowId !== window.windowId) {
        this.record("transition_rejected", { reason: outcome?.reason ?? "unknown", from: old.windowId });
        throw new Error(`새 문맥을 적용하지 못했어요 (${outcome?.reason ?? "unknown"}). 이전 문맥과 노트는 보존했어요.`);
      }
      const committed = this.store.branch.findLast((e) => e.type === "compaction" && e.details?.window?.windowId === window.windowId);
      this.flush(ctx.sessionManager, committed.id);
      this.pending = null;
      this.checkpointRequested = false;
      if (applyError || outcome?.applied !== true) {
        // The disk boundary may be committed while the engine's live state or
        // provider reset failed. Never run a second cut or claim success.
        this.fatal = "문맥 경계는 저장됐지만 엔진 후처리가 실패했어요. 중복 전환하지 말고 같은 세션을 다시 열어 복구해 주세요.";
        this.record("transition_committed_incomplete", { window_id: window.windowId,
          reported_reason: outcome?.reason ?? "exception" });
        throw new Error(this.fatal, { cause: applyError });
      }
      this.paused = null;
      this.hasSample = false;
      this.record("transition_committed", { window_id: window.windowId, number: window.number, reason,
        reported_applied: outcome?.applied === true });
      this.showStatus();
      return { applied: true, window_id: window.windowId };
    } finally { this.transitioning = false; }
  }

  async turnEnd(_event, ctx) {
    try {
      if (ctx.signal?.aborted || ["aborted", "error"].includes(_event?.message?.stopReason)) {
        this.pending = null;
        this.record("transition_cancelled");
        if (!this.fatal && ctx.model?.contextWindow && this.usage().tokens >= this.usage().target &&
            !this.checkpointRequested) this.requestCheckpoint();
        return;
      }
      this.refresh(ctx, true);
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        if (pending.sessionId !== this.sessionId || pending.windowId !== this.window.windowId || pending.userId !== this.lastUser) {
          throw new Error("노트 작성 뒤 사용자 요청이나 대화 가지가 바뀌었어요. 전환하지 않았으니 노트를 갱신해 주세요.");
        }
        await this.roll(ctx, "tool");
      } else if (this.checkpointRequested || ctx.model?.contextWindow) {
        const usage = this.usage();
        const note = this.store.latestNoteForWindow(this.window.windowId, this.lastUser);
        let fresh = false;
        if (note) {
          try { assertCheckpointFresh(this.store.branch, note); fresh = true; }
          catch { /* request a checkpoint-only turn below */ }
        }
        if (this.checkpointRequested) {
          if (fresh) await this.roll(ctx, usage.tokens >= usage.target ? "budget" : "manual");
          else {
            this.checkpointRequested = false;
            throw new Error("체크포인트 전용 턴이 작업 노트를 저장하지 않았어요. 이전 문맥은 그대로 유지했어요.");
          }
        } else if (ctx.model?.contextWindow && usage.tokens >= usage.hard) {
          if (note) await this.roll(ctx, "hard");
          else this.requestCheckpoint();
        } else if (ctx.model?.contextWindow && usage.tokens >= usage.target) {
          if (!fresh) this.requestCheckpoint();
        }
      }
    } catch (error) { this.fail(error); }
  }

  requestCheckpoint() {
    const usage = this.usage(this.activeMessages);
    if (usage.tokens >= usage.full) {
      throw new Error("체크포인트 턴을 안전하게 실행할 여유도 남지 않았어요. 기록은 보존했으니 더 큰 한도로 같은 세션을 다시 열어 주세요.");
    }
    if (this.checkpointRequested) return { requested: true, repeated: true };
    this.checkpointRequested = true;
    this.paused = null;
    this.pi.sendMessage({ customType: "rubato-context-checkpoint-request", display: true,
      content: "지금은 체크포인트 전용 턴이에요. 다른 작업을 진행하지 말고 현재 작업의 목표·결정·진행·실패 이유·다음 단계와 원문 항목 위치를 notes 도구에 저장한 뒤 new_context를 호출해 주세요. 다른 모델로 요약하지 마세요." },
    { triggerTurn: true, deliverAs: "steer" });
    this.showStatus();
    return { requested: true };
  }

  async manual(ctx) {
    this.refresh(ctx, true);
    const note = this.store.latestNoteForWindow(this.window.windowId, this.lastUser);
    if (ctx.isIdle() && note) {
      let fresh = true;
      try { assertCheckpointFresh(this.store.branch, note); } catch { fresh = false; }
      if (fresh) return this.roll(ctx, "manual");
    }
    return this.requestCheckpoint();
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.pending = null; this.checkpointRequested = false;
    this.disposeGate?.(); this.store.close();
  }
}

function baseContext(ctx) {
  const view = {};
  for (const key of ["sessionManager", "agentDir", "model", "ui", "signal", "mode", "cwd", "hasUI"]) {
    view[key] = ctx[key];
  }
  for (const key of ["isIdle", "getContextUsage", "getSystemPrompt", "getMessageRevision", "applyCompaction", "abort"]) {
    if (typeof ctx[key] === "function") view[key] = ctx[key];
  }
  return view;
}
