import { readAuthoritativeBranch } from "./history-source.mjs";
import { assertCheckpointFresh } from "./checkpoint.mjs";
import { historyNotesEnabled, historyNotesEnabledForSession, historyNotesEnabledForSettings } from "./config.mjs";
import { BOOTSTRAP_PREFIX, bootstrapMessage, validateTransition } from "./protocol.mjs";

const KEY = Symbol.for("rubato.history-notes.sessions.v1");
const DRIFT_KEY = Symbol.for("rubato.history-notes.drift.v1");
const sessions = globalThis[KEY] ??= new Map();
export const REQUIRED_MARKERS = ["lane", "messages", "session", "settings", "pipeline", "anthropic", "turn"];

export function markEnginePart(name) {
  globalThis[Symbol.for(`rubato.history-notes.${name}.v1`)] = true;
}

export function recordEnginePartDrift(name, error) {
  const drift = globalThis[DRIFT_KEY] ??= Object.create(null);
  drift[name] = error?.message ?? String(error);
}

export function assertEngineParts() {
  const missing = REQUIRED_MARKERS.filter((part) => !globalThis[Symbol.for(`rubato.history-notes.${part}.v1`)]);
  if (!missing.length) return;
  const drift = globalThis[DRIFT_KEY] ?? Object.create(null);
  const details = missing.map((part) => drift[part] ? `${part} (${drift[part]})` : part).join(", ");
  throw new Error(`새 문맥 모드의 엔진 연결이 빠졌어요: ${details}. check-history-notes-engine.mjs를 실행해 주세요.`);
}

export function registerSessionGate(id, gate) {
  if (!id || typeof gate !== "function") throw new Error("문맥 관리 세션을 등록하지 못했어요.");
  if (sessions.has(id)) throw new Error("같은 세션의 문맥 관리자가 이미 실행 중이에요.");
  sessions.set(id, gate);
  return () => { if (sessions.get(id) === gate) sessions.delete(id); };
}

export function assertSessionReady(manager, messages, context) {
  if (!historyNotesEnabledForSession(manager?.getSessionId?.())) return;
  const id = manager?.getSessionId?.();
  const gate = sessions.get(id);
  if (!gate) {
    context?.abort?.("system");
    throw new Error("새 문맥 관리 확장이 준비되지 않았어요. 요약 방식으로 전환하지 않고 요청을 중단했어요.");
  }
  gate(messages);
}

export function assertCompactionRequest(request) {
  if (historyNotesEnabled()) validateTransition(request?.precomputed);
}

export function assertTransitionCommit(request, manager) {
  if (!historyNotesEnabledForSession(manager?.getSessionId?.())) return;
  validateTransition(request?.precomputed);
  request.controller?.signal?.throwIfAborted();
  const details = request.precomputed.details;
  if (typeof details.preparedLeafId !== "string" || manager.getLeafId() !== details.preparedLeafId) {
    throw new Error("문맥을 바꾸기 직전에 새 기록이 도착했어요. 전환하지 않았으니 노트를 갱신해 주세요.");
  }
  const branch = readAuthoritativeBranch(manager);
  const prepare = branch.at(-1);
  if (prepare?.customType !== "rubato.context-window.prepare.v1" ||
      prepare.data?.window?.windowId !== details.window.windowId ||
      request.precomputed.firstKeptEntryId !== prepare.id) {
    throw new Error("문맥 전환 준비 기록과 적용할 경계가 다르게 지정됐어요.");
  }
  assertCheckpointFresh(branch, { id: details.checkpointEntryId }, { allowStale: details.reason === "hard" });
}

function notesWindowText(message) {
  const texts = [];
  if (typeof message?.content === "string") texts.push(message.content);
  else if (Array.isArray(message?.content)) {
    for (const part of message.content) if (typeof part?.text === "string") texts.push(part.text);
  }
  return texts.find((text) => text.startsWith(BOOTSTRAP_PREFIX));
}

// The newest window carrier in a message list identifies the active window.
function latestNotesWindow(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const text = notesWindowText(list[i]);
    if (text) return text;
  }
  return undefined;
}

// After an extension applyCompaction at turn_end, senpi's next-turn prepare still
// feeds turn.context.messages unless its own threshold compaction also ran. Compare
// the newest carrier on each side: the loop copy may still hold an older window.
export function notesTurnMessages(turn, agentMessages, sessionId) {
  if (!historyNotesEnabledForSession(sessionId)) return undefined;
  const agent = Array.isArray(agentMessages) ? agentMessages : [];
  const current = latestNotesWindow(agent);
  if (!current) return undefined;
  if (latestNotesWindow(turn?.context?.messages) === current) return undefined;
  return agent.slice();
}

export function notesAwareSummaryMessage(summary, timestamp) {
  const message = bootstrapMessage(summary, timestamp);
  if (message && !historyNotesEnabled()) {
    throw new Error("이 세션은 작업 노트 방식으로 이어져 있어요. history-notes 모드로 다시 열어 주세요. summary 비교 실험은 새 세션에서 시작해 주세요.");
  }
  return message;
}

export function installSettingsGate(SettingsManager) {
  const original = SettingsManager?.prototype?.getCompactionSettings;
  if (typeof original !== "function") throw new Error("설치된 엔진의 압축 설정 인터페이스가 달라졌어요.");
  const key = Symbol.for("rubato.history-notes.settingsWrapped.v1");
  if (!SettingsManager.prototype[key]) {
    SettingsManager.prototype.getCompactionSettings = function (...args) {
      const settings = original.apply(this, args);
      return historyNotesEnabledForSettings(this) ? { ...settings, enabled: false, speculativeEnabled: false,
        restorationEnabled: false, idleCompactionEnabled: false } : settings;
    };
    SettingsManager.prototype[key] = true;
  }
  markEnginePart("settings");
}
