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
import { injectRubatoFooter, isRubatoFooterModuleUrl, rubatoFooterHref } from "./rubato-footer.mjs";
import { applyTuiChromeTransforms } from "./transforms/tui-chrome.mjs";
import { applyMiscVendorTransforms } from "./transforms/misc-vendor.mjs";
import { applyCoreSessionTransforms } from "./transforms/core-session.mjs";
import { applyCursorVendorTransforms } from "./transforms/cursor-vendor.mjs";
import { applyControlCodemodeTransforms } from "./transforms/control-codemode.mjs";
import { applyBootPerfTransforms } from "./transforms/boot-perf.mjs";

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

function isVendorTransformUrl(url) {
  return (
    url.includes("@code-yeongyu/senpi/") ||
    url.includes("@earendil-works/pi-tui/") ||
    url.includes("@earendil-works/pi-ai/") ||
    url.includes("@earendil-works/pi-agent-core/") ||
    url.includes("/harness/rubato-pi/")
  );
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.source == null) return result;
  // 변환 대상이 아니면 소스를 문자열로 펼치지 않는다. 매 모듈마다
  // String(source) 하면 compile cache 가 있는 바이트를 다시 풀어 기동이 늘어진다.
  if (!isVendorTransformUrl(url)) return result;
  const source = String(result.source);
  let next = source;

  // 클러스터 변환이 먼저다: 벤더 패치가 걸려 있으면 pristine 니들이 없어 inert 이고,
  // 패치를 걷은 뒤에는 여기서 patched 바이트를 재구성한다. 그래서 아래의 기존
  // 변환들은 두 상태 모두에서 지금과 같은 텍스트를 본다. 각 클러스터는 URL
  // 매칭을 스스로 한다.
  // [cluster:tui-chrome] harness/rubato-pi/src/transforms/tui-chrome.mjs 소유.
  next = applyTuiChromeTransforms(url, next, applyTransform);
  // [cluster:misc-vendor] harness/rubato-pi/src/transforms/misc-vendor.mjs 소유.
  next = applyMiscVendorTransforms(url, next, applyTransform);
  // [cluster:core-session] harness/rubato-pi/src/transforms/core-session.mjs 소유.
  next = applyCoreSessionTransforms(url, next, applyTransform);
  // [cluster:cursor-vendor] harness/rubato-pi/src/transforms/cursor-vendor.mjs 소유.
  next = applyCursorVendorTransforms(url, next, applyTransform);
  // [cluster:control-codemode] harness/rubato-pi/src/transforms/control-codemode.mjs 소유.
  next = applyControlCodemodeTransforms(url, next, applyTransform);
  // [cluster:boot-perf] harness/rubato-pi/src/transforms/boot-perf.mjs 소유.
  next = applyBootPerfTransforms(url, next, applyTransform);

  if (isEditorMouseModuleUrl(url) || isEditorMouseTuiUrl(url)) {
    if (isEditorMouseModuleUrl(url)) {
      next = applyTransform(next, injectEditorMouse);
      next = applyTransform(next, injectPasteExpand);
    }
    if (isEditorMouseTuiUrl(url)) {
      next = applyTransform(next, injectEditorMouseRouting);
      next = applyTransform(next, injectCollapsibleMouseRouting);
    }
  } else if (isTerminalModuleUrl(url)) {
    next = applyTransform(next, (text) => injectTitleGuard(text, titleGuardHref()));
  } else if (url.includes("@code-yeongyu/senpi/dist/") || isCollapsibleToolGroupUrl(url)) {
    // isCollapsibleToolGroupUrl 은 in-repo tool-group-component.mjs 도 받는다 —
    // 벤더 패치가 만들던 파일의 이사밄 모듈이라 같은 주입을 받아야 한다.
    if (isBusyEnterModuleUrl(url)) next = applyTransform(next, (text) => injectBusyEnter(text, busyEnterHref()));
    if (isRubatoFooterModuleUrl(url)) next = applyTransform(next, (text) => injectRubatoFooter(text, rubatoFooterHref()));
    if (isCollapsibleAssistantUrl(url)) next = applyTransform(next, injectCollapsibleAssistant);
    if (isCollapsibleToolExecutionUrl(url)) next = applyTransform(next, injectCollapsibleToolExecution);
    if (isCollapsibleToolGroupUrl(url)) next = applyTransform(next, injectCollapsibleToolGroup);
    next = applyTransform(next, (text) => stripChangelog(text, url));
  }

  if (next === source) return result;
  return { format: result.format, source: next, shortCircuit: true };
}
