import { stripChangelog } from "./no-changelog.mjs";
import {
  injectEditorMouse,
  injectEditorMouseRouting,
  isEditorMouseModuleUrl,
  isEditorMouseTuiUrl,
} from "./editor-mouse.mjs";
import { injectPasteExpand } from "./paste-expand.mjs";
import { injectTitleGuard, isTerminalModuleUrl, titleGuardHref } from "./title-guard.mjs";
import { busyEnterHref, injectBusyEnter, isBusyEnterModuleUrl } from "./busy-enter.mjs";
import {
  injectCollapsibleAssistant,
  injectCollapsibleMouseRouting,
  injectCollapsibleToolExecution,
  injectCollapsibleToolGroup,
  isCollapsibleAssistantUrl,
  isCollapsibleToolExecutionUrl,
  isCollapsibleToolGroupUrl,
} from "./collapsible-mouse.mjs";

// 주입 앵커는 설치된 senpi/pi-tui 의 **정확한** 소스 문자열에 걸려 있다.
// 설치본이 레포 핀과 다르면(전역 설치, 오래된 클론, 부분 업데이트) 앵커가
// 어긋나고 inject* 는 throw 한다. 이 로더는 NODE_OPTIONS 로 심겨 있어서,
// 여기서 던지면 그 node 프로세스가 통째로 죽는다 — `senpi --help` 조차.
// 꾸밈 하나가 안 맞는 것과 CLI 전체가 벽돌이 되는 것은 값이 다르다.
// 그래서 각 주입을 따로 감싸고, 실패한 것만 버리고 나머지는 그대로 태운다.
function applyTransform(source, transform) {
  try {
    const next = transform(source);
    return typeof next === "string" ? next : source;
  } catch (error) {
    // 한 번만 알린다. 매 로드마다 짖으면 TUI 가 시작 전에 더러워진다.
    warnOnce(error);
    return source;
  }
}

const warned = new Set();
function warnOnce(error) {
  const message = error?.message ?? String(error);
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(
    `${message} - skipping this rubato transform; the installed engine differs from the pinned one`,
    "RubatoTransformDrift",
  );
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.source == null) return result;

  if (isEditorMouseModuleUrl(url) || isEditorMouseTuiUrl(url)) {
    const source = String(result.source);
    let next = source;
    if (isEditorMouseModuleUrl(url)) {
      next = applyTransform(next, injectEditorMouse);
      next = applyTransform(next, injectPasteExpand);
    }
    if (isEditorMouseTuiUrl(url)) {
      next = applyTransform(next, injectEditorMouseRouting);
      next = applyTransform(next, injectCollapsibleMouseRouting);
    }
    if (next === source) return result;
    return { format: result.format, source: next, shortCircuit: true };
  }

  if (isTerminalModuleUrl(url)) {
    const source = String(result.source);
    const next = applyTransform(source, (text) => injectTitleGuard(text, titleGuardHref()));
    if (next === source) return result;
    return { format: result.format, source: next, shortCircuit: true };
  }

  if (!url.includes("@code-yeongyu/senpi/dist/")) return result;
  const source = String(result.source);
  let next = source;
  if (isBusyEnterModuleUrl(url)) next = applyTransform(next, (text) => injectBusyEnter(text, busyEnterHref()));
  if (isCollapsibleAssistantUrl(url)) next = applyTransform(next, injectCollapsibleAssistant);
  if (isCollapsibleToolExecutionUrl(url)) next = applyTransform(next, injectCollapsibleToolExecution);
  if (isCollapsibleToolGroupUrl(url)) next = applyTransform(next, injectCollapsibleToolGroup);
  next = applyTransform(next, (text) => stripChangelog(text, url));
  if (next === source) return result;
  return { format: result.format, source: next, shortCircuit: true };
}
