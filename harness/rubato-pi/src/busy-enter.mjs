const MARKER = "rubato.busyEnter.injected";
const INSTALLED = Symbol.for("rubato.busyEnter.installed");
const TRACKED = Symbol.for("rubato.busyEnter.tracked");
const PARTS = Symbol.for("rubato.busyEnter.parts");

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
__rubatoInstallBusyEnter(InteractiveMode.prototype, { Spacer, TruncatedText, theme });
`;
}

function agentMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function locateFreshFollowUp(mode, text) {
  if (mode.session?.isCompacting) {
    const queued = mode.compactionQueuedMessages;
    if (!Array.isArray(queued)) return undefined;
    for (let i = queued.length - 1; i >= 0; i -= 1) {
      const item = queued[i];
      if (item?.mode === "followUp") return { kind: "compaction", message: item, text: item.text };
    }
    return undefined;
  }
  const messages = mode.session?.agent?.followUpQueue?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { kind: "native", text };
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (agentMessageText(message) === text) return { kind: "native", message, text };
  }
  return { kind: "native", message: messages[messages.length - 1], text };
}

/**
 * 세션 장부에 적힐 문자열은 우리가 받은 생텍스트가 아니라 **큐에 실제로 들어간**
 * 문자열이다. `prompt()` 은 스킬·템플릿을 펼친 뒤(`expandedText`) 큐에 넣기 때문에,
 * `/template args` 같은 입력은 원본과 큐 안의 값이 다르다. 원본으로 장부를
 * 짐지하면 followUp 쪽은 안 지워지고 steer 쪽에 유령이 남는다.
 */
function trackedText(tracked) {
  if (!tracked) return undefined;
  if (tracked.kind === "compaction") return tracked.message?.text ?? tracked.text;
  const fromMessage = tracked.message ? agentMessageText(tracked.message) : "";
  return fromMessage || tracked.text;
}

export function rememberBusyEnter(mode, text) {
  mode[TRACKED] = locateFreshFollowUp(mode, text) ?? { kind: "native", text };
  // showStatus 는 부르지 않는다. 안내문구는 아래 대기열 블록이 직접 그린다.
  mode.updatePendingMessagesDisplay?.();
}

/** 지금 추적 중인 메시지가 이미 스티어링으로 올라갔는가. */
function trackedIsSteering(mode) {
  const tracked = mode[TRACKED];
  if (!tracked) return false;
  if (tracked.kind === "compaction") return tracked.message?.mode === "steer";
  return tracked.promoted === true;
}

/**
 * 대기열 안내문구. 추적 중인 메시지가 있을 때만, 그리고 다음 Enter 가
 * 어느 쪽으로 갈지를 그대로 적는다.
 */
export function busyEnterHint(mode) {
  const tracked = mode[TRACKED];
  if (!tracked) return undefined;
  // 플래그만 믿지 않는다 — 추적하던 메시지가 이미 배달되어 빠졌으면
  // 누르나마나 아무 일도 안 일어난다. 그럴 땐 문구를 아예 안 보여준다.
  if (tracked.kind === "compaction") {
    const queued = mode.compactionQueuedMessages;
    if (!Array.isArray(queued) || queued.indexOf(tracked.message) === -1) return undefined;
  } else {
    const agent = mode.session?.agent;
    const queue = tracked.promoted ? agent?.steeringQueue?.messages : agent?.followUpQueue?.messages;
    if (!Array.isArray(queue) || queue.indexOf(tracked.message) === -1) return undefined;
  }
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
  if (!tracked) return;

  if (tracked.kind === "compaction") {
    const queued = mode.compactionQueuedMessages;
    const message = tracked.message;
    if (!Array.isArray(queued) || !message || queued.indexOf(message) === -1) {
      mode[TRACKED] = undefined;
      return;
    }
    message.mode = message.mode === "steer" ? "followUp" : "steer";
    mode.updatePendingMessagesDisplay?.();
    return;
  }

  const agent = session.agent;
  const message = tracked.message;
  if (!message) {
    mode[TRACKED] = undefined;
    return;
  }
  const toSteer = !tracked.promoted;
  const from = toSteer ? agent?.followUpQueue?.messages : agent?.steeringQueue?.messages;
  const to = toSteer ? agent?.steeringQueue?.messages : agent?.followUpQueue?.messages;
  const index = Array.isArray(from) ? from.indexOf(message) : -1;
  if (index === -1) {
    // 이미 빠져나갔다 — 돌릴 대상이 없으므로 추적만 끊는다.
    mode[TRACKED] = undefined;
    mode.updatePendingMessagesDisplay?.();
    return;
  }
  from.splice(index, 1);

  const text = trackedText(tracked);
  const fromMode = toSteer ? "followUp" : "steer";
  const toMode = toSteer ? "steer" : "followUp";
  const fromList = toSteer ? session._followUpMessages : session._steeringMessages;
  const toList = toSteer ? session._steeringMessages : session._followUpMessages;
  if (Array.isArray(fromList)) {
    const listIndex = fromList.lastIndexOf(text);
    if (listIndex !== -1) fromList.splice(listIndex, 1);
  }
  const order = session._queuedInputOrder?.find((item) => item.mode === fromMode && item.text === text);
  session._removeQueuedInput?.(text, fromMode);
  const enqueueOrder = order?.enqueueOrder ?? tracked.enqueueOrder;
  // 돌아갈 때는 원래 자리로 돌려놓는다. 그냥 append 하면 뒤에 쌓인 다른
  // follow-up 보다 늦게 배달되어 사용자가 친 순서가 바뀜다.
  if (toSteer) {
    tracked.followUpIndex = index;
    agent.steer(message);
  } else if (Array.isArray(to)) {
    const back = Math.min(tracked.followUpIndex ?? to.length, to.length);
    to.splice(back, 0, message);
  } else {
    agent.followUp(message);
  }
  if (Array.isArray(toList)) {
    if (toSteer) toList.push(text);
    else toList.splice(Math.min(tracked.followUpIndex ?? toList.length, toList.length), 0, text);
  }
  session._recordQueuedInput?.(text, toMode, enqueueOrder);
  session._emitQueueUpdate?.();
  tracked.enqueueOrder = enqueueOrder;
  tracked.promoted = toSteer;
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
  const line = (label, message) => {
    const tag = theme.fg("dim", `${label}: `);
    const body = theme.fg("text", message);
    container.addChild(new TruncatedText(tag + body, 1, 0));
  };
  for (const message of steering) line("Steering", message);
  for (const message of followUp) line("Follow-up", message);

  const hint = busyEnterHint(mode);
  if (hint) container.addChild(new TruncatedText(theme.fg("dim", `\u21b3 ${hint}`), 1, 0));
  const dequeue = mode.getAppKeyDisplay?.("app.message.dequeue");
  if (dequeue) {
    container.addChild(
      new TruncatedText(theme.fg("dim", `\u21b3 ${dequeue} to edit all queued messages`), 1, 0),
    );
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
