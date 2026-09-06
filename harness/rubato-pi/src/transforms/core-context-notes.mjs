// Critical context ownership transforms run OUTSIDE the cosmetic drift catcher.
// Keep this after the existing core-session/control clusters in the loader.
import { historyNotesEnabled } from "../context-notes/config.mjs";

export function contextNotesHrefs() {
  return { gate: new URL("../context-notes/engine-gate.mjs", import.meta.url).href,
    config: new URL("../context-notes/config.mjs", import.meta.url).href };
}

function once(source, pattern, insertion, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  if (matches.length !== 1) throw new Error(`문맥 관리 연결 위치가 달라졌어요 (${label}, ${matches.length}곳). 설치된 senpi 버전을 확인해 주세요.`);
  return source.replace(pattern, (match) => match + insertion);
}

function onceReplace(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, "g"))];
  if (matches.length !== 1) throw new Error(`문맥 관리 연결 위치가 달라졌어요 (${label}, ${matches.length}곳). 설치된 senpi 버전을 확인해 주세요.`);
  return source.replace(pattern, replacement);
}

function header(hrefs, names = []) {
  return `import { historyNotesEnabled as __rubatoNotesEnabled } from ${JSON.stringify(hrefs.config)};\n` +
    (names.length ? `import { ${names.join(", ")} } from ${JSON.stringify(hrefs.gate)};\n` : "");
}

export function contextNotesTarget(url) {
  if (url.includes("@code-yeongyu/senpi/dist/core/")) {
    if (url.endsWith("/settings-manager.js")) return "settings";
    if (url.endsWith("/messages.js")) return "messages";
    if (url.endsWith("/agent-session.js")) return "session";
    if (url.endsWith("/extensions/builtin/compaction/lane-policy.js")) return "lane";
    if (url.endsWith("/extensions/builtin/compaction/context-pipeline.js")) return "pipeline";
  }
  if (url.endsWith("/harness/rubato-pi/src/anthropic-server-compaction.mjs")) return "anthropic";
  return undefined;
}

export function applyContextNotesTransforms(url, source, options = {}) {
  const target = contextNotesTarget(url);
  if (!target) return source;
  const marker = `// rubato-history-notes-transform-v2:${target}`;
  if (source.includes(`// rubato-history-notes-transform-v1:${target}`)) {
    throw new Error("이전 문맥 변환이 적용된 엔진이에요. 원본 엔진에서 새 변환을 적용해 주세요.");
  }
  if (source.includes(marker)) return source;
  const enabled = options.enabled ?? historyNotesEnabled();
  // Gates stay present in both modes and read the live env at call time.
  const hrefs = { ...contextNotesHrefs(), ...options.hrefs };
  let next = source;
  try {
    switch (target) {
      case "settings":
        if (!/export class SettingsManager\b/.test(next) || !/\bgetCompactionSettings\s*\(/.test(next)) {
          throw new Error("문맥 관리에 필요한 SettingsManager를 찾지 못했어요.");
        }
        next = header(hrefs, ["installSettingsGate"]) + next + "\ninstallSettingsGate(SettingsManager);\n";
        break;
      case "messages":
        next = once(next, /export function createCompactionSummaryMessage\(summary, tokensBefore, timestamp(?:, details)?\)\s*\{/,
          "\n    const __rubatoWindow = notesAwareSummaryMessage(summary, timestamp);\n    if (__rubatoWindow) return __rubatoWindow;", "window carrier");
        next = header(hrefs, ["notesAwareSummaryMessage", "markEnginePart"]) + next + '\nmarkEnginePart("messages");\n';
        break;
      case "session":
        next = once(next, /async _executeCompaction\(request\)\s*\{/,
          "\n        assertCompactionRequest(request);", "compaction ownership");
        next = once(next, /async _enforceFinalProviderAdmission\([^)]*\)\s*\{/,
          "\n        assertSessionReady(this.sessionManager);", "provider admission");
        const commitPattern = /const compactionEntryId = this\.sessionManager\.appendCompaction\(/g;
        if ([...next.matchAll(commitPattern)].length !== 1) throw new Error("문맥 전환 직전 검사 위치가 달라졌어요.");
        next = next.replace(commitPattern, "assertTransitionCommit(request, this.sessionManager);\n            const compactionEntryId = this.sessionManager.appendCompaction(");
        next = onceReplace(next,
          /const messages = compactedBeforeCallback \? this\.agent\.state\.messages\.slice\(\) : turn\.context\.messages;/,
          "const messages = notesTurnMessages(turn, this.agent.state.messages) ?? (compactedBeforeCallback ? this.agent.state.messages.slice() : turn.context.messages);",
          "next-turn window");
        next = header(hrefs, ["assertCompactionRequest", "assertSessionReady", "assertTransitionCommit", "notesTurnMessages", "markEnginePart"]) + next + '\nmarkEnginePart("session");\nmarkEnginePart("turn");\n';
        break;
      case "lane":
        next = once(next, /disablesSenpiCompaction\(context\)\s*\{/,
          "\n            if (__rubatoNotesEnabled()) return true;", "lane ownership");
        next = once(next, /export function laneRejectionReason\(model\)\s*\{/,
          '\n    if (__rubatoNotesEnabled()) return "작업 노트 모드가 문맥 관리를 맡고 있어요. /new-context를 사용해 주세요.";', "lane reason");
        next = once(next, /export function laneAllowsManualCompaction\(model, reason\)\s*\{/,
          "\n    if (__rubatoNotesEnabled()) return false;", "manual ownership");
        next = header(hrefs, ["markEnginePart"]) + next + '\nmarkEnginePart("lane");\n';
        break;
      case "pipeline":
        next = once(next, /export function buildCompactionContext\(input\)\s*\{/,
          '\n    if (__rubatoNotesEnabled()) {\n        assertSessionReady(input.ctx?.sessionManager, input.event.messages, input.ctx);\n        const messages = input.ctx?.model?.provider === "cursor" ? stripCursorThinking(input.event.messages) : input.event.messages;\n        return repairOrphanedToolResults(convertToLlm(messages));\n    }', "no-prune pipeline");
        if (!/function stripCursorThinking\(/.test(next)) throw new Error("기존 Cursor 문맥 변환이 적용되지 않았어요.");
        next = header(hrefs, ["assertSessionReady", "markEnginePart"]) + next + '\nmarkEnginePart("pipeline");\n';
        break;
      case "anthropic":
        next = once(next, /export function supportsAnthropicServerCompaction\(model\)\s*\{/,
          "\n  if (__rubatoNotesEnabled()) return false;", "server summary disabled");
        next = header(hrefs, ["markEnginePart"]) + next + '\nmarkEnginePart("anthropic");\n';
        break;
    }
  } catch (error) {
    if (enabled) throw error;
    // Loader hooks run on another thread, so recording drift on this globalThis
    // never reaches assertEngineParts(). Put the call in the module source.
    const message = error?.message ?? String(error);
    return `${source}
import { recordEnginePartDrift as __rubatoRecordDrift } from ${JSON.stringify(hrefs.gate)};
__rubatoRecordDrift(${JSON.stringify(target)}, ${JSON.stringify(message)});
`;
  }
  return next + `\n${marker}\n`;
}
