const MARKER = "rubato.busyEnter.injected";
const INSTALLED = Symbol.for("rubato.busyEnter.installed");
const TRACKED = Symbol.for("rubato.busyEnter.tracked");
const PARTS = Symbol.for("rubato.busyEnter.parts");
const RECALL_INSTALLED = Symbol.for("rubato.busyEnter.recallInstalled");

// 예전에는 이 문구를 showStatus 로 띄웠다. 그 자리는 chatContainer 안이라
// 사고 블록과 같은 dim 색으로 그려지고, 턴이 진행되면 위로 밀려 올라갔다.
// 그래서 문구가 사고처럼 보였다. 지금은 대기열 블록 안에 함께 그린다 —
// 편집기 바로 위 고정 자리라 밀리지 않는다.
export const BUSY_ENTER_STATUS = "Enter 한 번 더 - 지금 작업에 바로 전달";
export const BUSY_ENTER_STEER_STATUS = "Enter 한 번 더 - 다음 차례로 되돌리기";

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`rubato busy enter transform drift: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function isBusyEnterModuleUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js");
}

export function busyEnterHref() {
  return import.meta.url;
}

export function injectBusyEnter(source, href = busyEnterHref()) {
  if (source.includes(MARKER)) return source;
  let next = replaceOnce(
    source,
    "            text = text.trim();\n            if (!text)\n                return;",
    "            text = text.trim();\n            if (!text) {\n                this.__rubatoPromoteBusyEnter?.();\n                return;\n            }",
    "submit trim guard",
  );
  next = replaceOnce(
    next,
    "                    await this.session.prompt(text, {\n                        streamingBehavior: \"steer\",\n                        ...(images.length > 0 ? { images } : {}),\n                        ...this.optimisticUserEchoes.promptOptions(pendingEchoId),\n                    });",
    "                    await this.session.prompt(text, {\n                        streamingBehavior: \"followUp\",\n                        ...(images.length > 0 ? { images } : {}),\n                        ...this.optimisticUserEchoes.promptOptions(pendingEchoId),\n                    });\n                    this.__rubatoRememberBusyEnter?.(text);",
    "streaming prompt option",
  );
  // 압축 중 대기열은 upstream 이 queueCompactionMessage 안에서 showStatus 를 불러
  // 같은 안내를 대화 기록에 한 번 더 남긴다 — 사고처럼 보이던 바로 그 자리다.
  // 이 경로만 잠시 막고 대기열 블록이 대신 보여준다.
  next = replaceOnce(
    next,
    "                    this.queueCompactionSubmission(text, \"steer\");",
    "                    this.__rubatoQuietCompactionStatus?.(() => this.queueCompactionSubmission(text, \"followUp\"));\n                    this.__rubatoRememberBusyEnter?.(text);",
    "compaction queue",
  );
  // 대기열을 그리는 부품은 이 모듈이 직접 import 할 수 없다 — pi-tui 는 senpi 안에
  // 중첩되어 있어 하네스 디렉터리에서는 못 찾는다. 이미 그것들을 import 한
  // 변환 대상 모듈이 넘겨준다.
  return `${next}
// ${MARKER}
const { installBusyEnter: __rubatoInstallBusyEnter } = await import(${JSON.stringify(href)});
__rubatoInstallBusyEnter(InteractiveMode.prototype, { Spacer, TruncatedText, matchesKey, theme });
`;
}

function agentMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function agentMessageImages(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "image")
    : [];
}

function nativeImageRecallPlan(mode, candidate) {
  const images = agentMessageImages(candidate.message);
  if (images.length === 0) return { images, markerState: undefined };
  const editor = mode.editor;
  if (!(mode.pendingImages instanceof Map) ||
      typeof editor?.setImageMarkerState !== "function" ||
      typeof editor?.restoreAttachmentState !== "function") return undefined;
  const ids = [...candidate.text.matchAll(/\[Image #([1-9]\d*)\]/g)]
    .map((match) => Number.parseInt(match[1], 10));
  const canonical = ids.length === images.length &&
    ids.every((id, index) => id === index + 1);
  if (!canonical) return undefined;
  return { images, markerState: { ids, imageCounter: ids.length } };
}

function restoreCandidateToEditor(mode, candidate) {
  const editor = mode.editor;
  if (candidate.kind !== "native") {
    editor?.setText?.(candidate.text);
    return true;
  }
  const plan = nativeImageRecallPlan(mode, candidate);
  if (!plan) return false;
  editor?.setText?.(candidate.text);
  if (plan.markerState) {
    editor.setImageMarkerState(plan.markerState);
    editor.restoreAttachmentState(new Map(plan.images.map((image, index) => [index + 1, image])));
  }
  return true;
}

function locateFreshFollowUp(mode) {
  if (mode.session?.isCompacting) {
    const message = mode.compactionQueuedMessages?.at(-1);
    return message?.mode === "followUp"
      ? { kind: "compaction", message, text: message.text, enqueueOrder: message.enqueueOrder }
      : undefined;
  }
  const session = mode.session;
  const message = session?.agent?.followUpQueue?.messages?.at(-1);
  const record = session?._queuedInputOrder?.at(-1);
  const visibleIndex = session?._followUpMessages?.length - 1;
  if (!message || record?.mode !== "followUp" ||
      record.text !== agentMessageText(message) || session._followUpMessages?.[visibleIndex] !== record.text) {
    return undefined;
  }
  return {
    kind: "native",
    message,
    record,
    text: record.text,
    enqueueOrder: record.enqueueOrder,
  };
}

export function rememberBusyEnter(mode) {
  mode[TRACKED] = locateFreshFollowUp(mode);
  mode.updatePendingMessagesDisplay?.();
}

function isSubsequence(needles, haystack) {
  let next = 0;
  for (const value of haystack) {
    if (value === needles[next]) next += 1;
  }
  return next === needles.length;
}

/**
 * 실제 Agent 큐에는 표시 장부가 없는 extension/custom 메시지도 섞일 수 있다.
 * tracked 객체의 현재 큐 위치를 기준으로, 표시 문자열 전체와 모순 없이 대응하는
 * 행이 하나뿐일 때만 그 행을 돌려준다. 앞 항목이 배달되어 인덱스가 당겨져도
 * 매번 다시 계산하고, 같은 문자열 때문에 대응이 모호하면 안전하게 회수하지 않는다.
 */
function visibleIndexForQueuedMessage(queue, queueIndex, visible) {
  const queueText = queue.map(agentMessageText);
  const target = queueText[queueIndex];
  const matches = [];
  for (let visibleIndex = 0; visibleIndex < visible.length; visibleIndex += 1) {
    if (visible[visibleIndex] !== target) continue;
    const prefixMatches = isSubsequence(
      visible.slice(0, visibleIndex),
      queueText.slice(0, queueIndex),
    );
    const suffixMatches = isSubsequence(
      visible.slice(visibleIndex + 1),
      queueText.slice(queueIndex + 1),
    );
    if (prefixMatches && suffixMatches) matches.push(visibleIndex);
  }
  return matches.length === 1 ? matches[0] : -1;
}

function trackedCandidate(mode) {
  const tracked = mode[TRACKED];
  if (!tracked) return undefined;
  if (tracked.kind === "compaction") {
    const index = mode.compactionQueuedMessages?.indexOf(tracked.message) ?? -1;
    return index === -1 ? undefined : { ...tracked, index };
  }
  const session = mode.session;
  const recordIndex = session?._queuedInputOrder?.indexOf(tracked.record) ?? -1;
  const modeName = tracked.record?.mode;
  const queue = modeName === "steer"
    ? session?.agent?.steeringQueue?.messages
    : session?.agent?.followUpQueue?.messages;
  const visible = modeName === "steer" ? session?._steeringMessages : session?._followUpMessages;
  const queueIndex = queue?.indexOf(tracked.message) ?? -1;
  const visibleIndex = Array.isArray(queue) && Array.isArray(visible)
    ? visibleIndexForQueuedMessage(queue, queueIndex, visible)
    : -1;
  if (recordIndex === -1 || queueIndex === -1 || !Array.isArray(visible) ||
      visible[visibleIndex] !== tracked.record.text) return undefined;
  return {
    ...tracked,
    text: tracked.record.text,
    mode: modeName,
    recordIndex,
    queue,
    queueIndex,
    visible,
    visibleIndex,
  };
}

function newestVisibleOrder(mode) {
  const orders = [
    ...(mode.session?._queuedInputOrder ?? []).map((record) => record?.enqueueOrder),
    ...(mode.compactionInFlightMessages ?? []).map((message) => message?.enqueueOrder),
    ...(mode.compactionQueuedMessages ?? []).map((message) => message?.enqueueOrder),
  ].filter(Number.isFinite);
  return orders.length > 0 ? Math.max(...orders) : undefined;
}

function recallableTracked(mode) {
  const candidate = trackedCandidate(mode);
  if (!candidate || candidate.enqueueOrder !== newestVisibleOrder(mode)) return undefined;
  if (candidate.kind === "native" && nativeImageRecallPlan(mode, candidate) === undefined) return undefined;
  return candidate;
}

export function recallLatestPending(mode) {
  const session = mode.session;
  if (!session?.isStreaming && !session?.isCompacting) return undefined;
  const candidate = recallableTracked(mode);
  if (!candidate || !restoreCandidateToEditor(mode, candidate)) return undefined;

  if (candidate.kind === "compaction") {
    mode.compactionQueuedMessages.splice(candidate.index, 1);
    if (candidate.message.pendingEchoId) {
      mode.optimisticUserEchoes?.remove?.(candidate.message.pendingEchoId);
    }
  } else {
    candidate.queue.splice(candidate.queueIndex, 1);
    candidate.visible.splice(candidate.visibleIndex, 1);
    session._queuedInputOrder.splice(candidate.recordIndex, 1);
    session._emitQueueUpdate?.();
  }
  mode[TRACKED] = undefined;
  mode.updatePendingMessagesDisplay?.();
  mode.ui?.requestRender?.();
  return candidate.text;
}

export function handlePendingRecallKey(mode, data, fallback) {
  const editor = mode.defaultEditor;
  const physicalMatcher = mode[PARTS]?.matchesKey;
  const isPlainUp = physicalMatcher
    ? physicalMatcher(data, "up")
    : mode.keybindings?.matches?.(data, "tui.editor.cursorUp");
  const canRecall = mode.editor === editor &&
    (mode.session?.isStreaming || mode.session?.isCompacting) &&
    editor?.getText?.() === "" &&
    !editor?.isShowingAutocomplete?.() &&
    isPlainUp;
  if (canRecall && recallLatestPending(mode) !== undefined) return;
  return fallback();
}

function installPendingRecall(mode) {
  const editor = mode.defaultEditor;
  if (!editor || editor[RECALL_INSTALLED] || typeof editor.handleInput !== "function") return;
  const original = editor.handleInput;
  editor.handleInput = function handleInput(data) {
    return handlePendingRecallKey(mode, data, () => original.call(this, data));
  };
  editor[RECALL_INSTALLED] = true;
}

/** 지금 추적 중인 메시지가 이미 스티어링으로 올라갔는가. */
function trackedIsSteering(mode) {
  const tracked = mode[TRACKED];
  if (!tracked) return false;
  return tracked.kind === "compaction"
    ? tracked.message?.mode === "steer"
    : tracked.record?.mode === "steer";
}

/**
 * 대기열 안내문구. 추적 중인 메시지가 있을 때만, 그리고 다음 Enter 가
 * 어느 쪽으로 갈지를 그대로 적는다.
 */
export function busyEnterHint(mode) {
  if (!trackedCandidate(mode)) return undefined;
  return trackedIsSteering(mode) ? BUSY_ENTER_STEER_STATUS : BUSY_ENTER_STATUS;
}

/**
 * 빈 Enter 를 누를 때마다 호출된다. 한번은 큰→스티어링, 다음은 다시 큰으로
 * 되돌린다. 예전에는 한 번 올리면 추적을 놓아버려서 되돌릴 길이 없었다.
 */
export function promoteBusyEnter(mode) {
  const session = mode.session;
  if (!session?.isStreaming && !session?.isCompacting) return;
  const tracked = mode[TRACKED];
  const candidate = trackedCandidate(mode);
  if (!tracked || !candidate) {
    mode[TRACKED] = undefined;
    mode.updatePendingMessagesDisplay?.();
    return;
  }

  if (tracked.kind === "compaction") {
    tracked.message.mode = tracked.message.mode === "steer" ? "followUp" : "steer";
    mode.updatePendingMessagesDisplay?.();
    return;
  }

  const toSteer = candidate.mode === "followUp";
  const destination = toSteer
    ? session.agent?.steeringQueue?.messages
    : session.agent?.followUpQueue?.messages;
  const destinationVisible = toSteer ? session._steeringMessages : session._followUpMessages;
  if (!Array.isArray(destination) || !Array.isArray(destinationVisible)) return;

  candidate.queue.splice(candidate.queueIndex, 1);
  candidate.visible.splice(candidate.visibleIndex, 1);
  tracked.record.mode = toSteer ? "steer" : "followUp";
  if (toSteer) {
    tracked.followUpIndex = candidate.queueIndex;
    tracked.followUpVisibleIndex = candidate.visibleIndex;
    session.agent.steer(tracked.message);
    destinationVisible.push(tracked.text);
  } else {
    const queueIndex = Math.min(tracked.followUpIndex, destination.length);
    const visibleIndex = Math.min(tracked.followUpVisibleIndex, destinationVisible.length);
    destination.splice(queueIndex, 0, tracked.message);
    destinationVisible.splice(visibleIndex, 0, tracked.text);
  }
  session._emitQueueUpdate?.();
  mode.updatePendingMessagesDisplay?.();
}

/**
 * 대기열 블록을 직접 그린다. upstream 은 세 줄을 전부 dim 으로 칠해서 무슨 글자가
 * 대기 중인지 읽기 힘들었다. 사용자가 보려는 것은 자기가 친 문장이므로
 * 본문은 편집기와 같은 text 색으로 두고, 격인 이름표와 힌트만 dim 으로 남긴다.
 */
export function renderPendingMessages(mode, parts) {
  const { Spacer, TruncatedText, theme } = parts ?? {};
  const container = mode.pendingMessagesContainer;
  if (!container || !TruncatedText || !theme) return false;
  container.clear();
  const { steering = [], followUp = [] } = mode.getAllQueuedMessages?.() ?? {};
  if (steering.length === 0 && followUp.length === 0) return true;

  if (Spacer) container.addChild(new Spacer(1));
  const section = (heading, messages) => {
    if (messages.length === 0) return;
    container.addChild(new TruncatedText(theme.fg("dim", heading), 1, 0));
    for (const message of messages) {
      const indent = theme.fg("dim", "  └ ");
      const body = theme.fg("text", message);
      container.addChild(new TruncatedText(indent + body, 1, 0));
    }
  };
  section("STEERING · current turn", steering);
  section("NEXT TURN · follow-up", followUp);

  const hints = [];
  if (recallableTracked(mode)) hints.push("↑ edit latest Enter input");
  const toggleHint = busyEnterHint(mode);
  if (toggleHint) hints.push(toggleHint);
  if (hints.length > 0) {
    container.addChild(new TruncatedText(theme.fg("dim", `  ${hints.join("  ·  ")}`), 1, 0));
  }
  return true;
}

/**
 * upstream 이 압축 대기열을 쌓으면서 부르는 "Queued message for after compaction" 만
 * 삼킨다. 같은 말을 대기열 블록이 이미 고정 자리에 보여주기 때문이다.
 * 이미지가 버려졌다는 실제 경고는 그대로 통과시킨다.
 */
export function quietCompactionStatus(mode, run) {
  const original = mode.showStatus;
  if (typeof original !== "function") return run();
  mode.showStatus = function showStatus(message) {
    if (typeof message === "string" && message.startsWith("Queued message for after compaction")) return;
    return original.call(this, message);
  };
  try {
    return run();
  } finally {
    mode.showStatus = original;
  }
}

export function installBusyEnter(proto, parts) {
  if (proto == null || typeof proto !== "object") return false;
  if (proto[INSTALLED]) return false;
  proto[PARTS] = parts;
  proto.__rubatoRememberBusyEnter = function remember(text) {
    rememberBusyEnter(this, text);
  };
  proto.__rubatoQuietCompactionStatus = function quiet(run) {
    return quietCompactionStatus(this, run);
  };
  proto.__rubatoPromoteBusyEnter = function promote() {
    promoteBusyEnter(this);
  };
  proto.__rubatoRecallLatestPending = function recall() {
    return recallLatestPending(this);
  };
  const originalSetupKeyHandlers = proto.setupKeyHandlers;
  if (typeof originalSetupKeyHandlers === "function") {
    proto.setupKeyHandlers = function setupKeyHandlers(...args) {
      const result = originalSetupKeyHandlers.apply(this, args);
      installPendingRecall(this);
      return result;
    };
  }
  // 대기열 렌더러를 갈아끼운다. 부품이 안 넘어왔거나 모양이 바뀌었으면
  // renderPendingMessages 가 false 를 돌려주므로 upstream 원본으로 되돌아간다.
  const original = proto.updatePendingMessagesDisplay;
  if (typeof original === "function") {
    proto.updatePendingMessagesDisplay = function updatePendingMessagesDisplay() {
      if (renderPendingMessages(this, proto[PARTS])) return;
      return original.call(this);
    };
  }
  proto[INSTALLED] = true;
  return true;
}
