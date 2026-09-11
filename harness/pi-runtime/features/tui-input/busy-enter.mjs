export const BUSY_ENTER_STATUS = "Enter 한 번 더 - 지금 작업에 바로 전달";
export const BUSY_ENTER_STEER_STATUS = "Enter 한 번 더 - 다음 차례로 되돌리기";

let enabled = false;

export function setBusyEnterEnabled(value) {
  enabled = value === true;
}

export function isBusyEnterEnabled() {
  return enabled;
}

/** Stock Enter-while-streaming steers. Product queues as follow-up unless this is disabled. */
export function busyEnterDelivery() {
  return enabled ? "followUp" : "steer";
}

function isUpKey(mode, data) {
  if (mode?.keybindings?.matches?.(data, "tui.editor.cursorUp")) return true;
  return data === "\x1b[A" || data === "\x1bOA";
}

export function promoteBusyEnter(mode) {
  if (!enabled) return;
  const session = mode?.session;
  if (session?.isCompacting) {
    const last = mode.compactionQueuedMessages?.at?.(-1);
    if (!last) return;
    last.mode = last.mode === "steer" ? "followUp" : "steer";
    mode.updatePendingMessagesDisplay?.();
    return;
  }
  if (!session?.isStreaming) return;
  if (typeof session.getSteeringMessages !== "function" || typeof session.clearQueue !== "function") return;
  const steering = [...session.getSteeringMessages()];
  const followUp = [...session.getFollowUpMessages()];
  if (steering.length === 0 && followUp.length === 0) return;
  session.clearQueue();
  if (followUp.length > 0) {
    const last = followUp.pop();
    for (const text of steering) session.steer(text);
    for (const text of followUp) session.followUp(text);
    session.steer(last);
  } else {
    const last = steering.pop();
    for (const text of steering) session.steer(text);
    session.followUp(last);
  }
  mode.updatePendingMessagesDisplay?.();
}

export function recallLatestPending(mode) {
  if (!enabled) return undefined;
  const session = mode?.session;
  if (!session?.isStreaming && !session?.isCompacting) return undefined;
  if (session.isCompacting) {
    const last = mode.compactionQueuedMessages?.at?.(-1);
    if (!last) return undefined;
    mode.compactionQueuedMessages.pop();
    mode.editor?.setText?.(last.text);
    mode.updatePendingMessagesDisplay?.();
    return last.text;
  }
  if (typeof session.getSteeringMessages !== "function" || typeof session.clearQueue !== "function") return undefined;
  const steering = [...session.getSteeringMessages()];
  const followUp = [...session.getFollowUpMessages()];
  const lastFollow = followUp.at(-1);
  const lastSteer = steering.at(-1);
  const last = lastFollow ?? lastSteer;
  if (last === undefined) return undefined;
  session.clearQueue();
  if (lastFollow !== undefined) {
    for (const text of steering) session.steer(text);
    for (const text of followUp.slice(0, -1)) session.followUp(text);
  } else {
    for (const text of steering.slice(0, -1)) session.steer(text);
  }
  mode.editor?.setText?.(last);
  mode.updatePendingMessagesDisplay?.();
  return last;
}

export function handlePendingRecallKey(mode, data, fallback) {
  const editor = mode?.defaultEditor;
  const busy = mode?.session?.isStreaming || mode?.session?.isCompacting;
  const empty = editor?.getText?.() === "";
  const canRecall = enabled && mode?.editor === editor && busy && empty && !editor?.isShowingAutocomplete?.() && isUpKey(mode, data);
  if (canRecall && recallLatestPending(mode) !== undefined) return;
  return fallback();
}

export function createBusyEnterExtension() {
  return function rubatoTuiBusyEnter(_pi) {
    setBusyEnterEnabled(true);
  };
}
