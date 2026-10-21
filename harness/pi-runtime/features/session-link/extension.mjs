import { DELIVER_REQUEST, SESSION_MESSAGE_TYPE, answeredMessageIds, buildSessionMessage, deliveredMessageIds, parseDelivery, parseDeliveryMode, projectWakes } from "./message.mjs";
import { renderSessionMessage } from "./render.mjs";
import { trackSideChatCache } from "./side-chat.mjs";
import { createSessionTools } from "./tools.mjs";

// How often a message held while the session is busy without a run (a manual compaction or a
// branch summary, which emit nothing when they end) looks again for an idle session.
const IDLE_RETRY_MS = 250;

/**
 * Session-to-session messaging inside one runtime:
 * - the deliver handler takes a message another conversation sent into this session and wakes it;
 * - the renderer shows that message as its own bubble in the terminal;
 * - the six conversation tools call the engine's `sessionLink`. Without one (this process is not
 *   hosted by the engine) they are not registered at all, so the model never sees a dead tool.
 *
 * A delivery is accepted when this session took it, not when it is written, and it never enters
 * Pi's steering queue, which a user's clear empties and no extension can read. The answer's
 * `delivery` says which path it took:
 * - idle session (`started`): sent with a turn; Pi writes it as the run starts and the first
 *   request reads it;
 * - running session, `queue` mode (`queued`): held here until the run ends. After a normal end it
 *   is sent with a turn, which starts the next run inside this run's settle; after a stop or
 *   failure it is written without one;
 * - running session, `steer` mode (`steered`): handed to Pi as a context message, which Pi writes
 *   at the end of the current step (after its tool results, never between a call and its result)
 *   and keeps through a clear. The next request of the run reads it. Whether there is one cannot
 *   be told in advance (a reply without tools, a tool that ends the run, results the provider
 *   already executed), so at the run's last boundary a steered message no reply has followed yet
 *   continues the run once; a stop or failure leaves it written without a turn, as in `queue`.
 *   A steer that arrives after the run's model work ended goes the `queue` way.
 * Each path writes the message once, so a messageId is a duplicate while it is held here or by Pi,
 * and once it is in the transcript.
 *
 * A wake from Rubato's own clock (heartbeat, daily report) reaches a model that takes system
 * messages mid-conversation as a system message (message.mjs projectWakes), on every request of
 * the turn, the cache warmer's replays included, since they reuse the projected context.
 */
export function installSessionLink(pi, { sessionLink, companion = false } = {}) {
  const state = {
    ctx: undefined,
    waiting: new Map(), // messageId -> details, in arrival order: held here for a boundary
    handed: new Set(), // messageIds sent to Pi and not yet seen in the transcript
    running: false, // between this session's agent_start and agent_settled
    stepping: false, // between agent_start and agent_end: a steered message still reaches a request
    steered: new Set(), // messageIds steered into this run
    interrupted: false, // the last run ended stopped or failed
    retry: undefined,
  };

  const written = () => deliveredMessageIds(state.ctx?.sessionManager?.getEntries?.());
  const idle = () => state.ctx?.isIdle?.() ?? true;

  function send(details, options) {
    state.waiting.delete(details.messageId);
    state.handed.add(details.messageId);
    pi.sendMessage(buildSessionMessage(details), options);
  }

  // Pi writes every message it was sent by the time it is idle again; one it did not write (its run
  // failed before starting) is nowhere, so its messageId is free again.
  function reconcile() {
    const ids = written();
    for (const id of state.handed) if (ids.has(id) || idle()) state.handed.delete(id);
  }

  function sendWhenIdle({ settled = false } = {}) {
    if (!state.waiting.size) return;
    if (!idle()) {
      if (!state.running && !state.retry) {
        state.retry = setTimeout(() => { state.retry = undefined; sendWhenIdle(); }, IDLE_RETRY_MS);
        state.retry.unref?.();
      }
      return;
    }
    if (settled && state.interrupted) {
      // The user stopped the run (or it failed): write the messages where the user sees them,
      // without starting the turn the stop just ended.
      for (const details of [...state.waiting.values()]) send(details, { triggerTurn: false });
      return;
    }
    // One message starts the run; the rest follow at its boundaries.
    send(state.waiting.values().next().value, { triggerTurn: true });
  }

  let untrackSideChat = () => {};
  function reset(ctx) {
    clearTimeout(state.retry);
    untrackSideChat();
    // A side chat keeps using the prompt cache of the conversation it came from (side-chat.mjs).
    untrackSideChat = ctx ? trackSideChatCache(ctx) : () => {};
    Object.assign(state, { ctx, waiting: new Map(), handed: new Set(), running: false, stepping: false, steered: new Set(), interrupted: false, retry: undefined });
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", () => reset(undefined));
  pi.on("agent_start", () => {
    state.running = true;
    state.stepping = true;
    state.interrupted = false;
  });
  pi.on("agent_end", (event, ctx) => {
    state.stepping = false;
    const last = (event?.messages ?? []).findLast((message) => message?.role === "assistant");
    state.interrupted = Boolean(ctx?.signal?.aborted) || last?.stopReason === "aborted" || last?.stopReason === "error";
  });
  // The run's last boundary: a steered message no reply has followed (written after the last
  // reply, or still waiting for Pi to write it right after this) gets one more request.
  pi.on("agent_before_settle", (event, ctx) => {
    if (!state.steered.size || state.interrupted || event?.outcome !== "completed") return undefined;
    const answered = answeredMessageIds((ctx ?? state.ctx)?.sessionManager?.getBranch?.());
    for (const id of state.steered) if (answered.has(id)) state.steered.delete(id);
    return state.steered.size ? { continue: true } : undefined;
  });
  pi.on("agent_settled", () => {
    state.running = false;
    state.stepping = false;
    state.steered.clear();
    reconcile();
    sendWhenIdle({ settled: true });
  });

  pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);

  pi.on("context_with_system", (event, ctx) => {
    const native = ctx?.model?.compat?.supportsMidConvoSystemMessages === true;
    const messages = projectWakes(event.messages, { native });
    return messages === event.messages ? undefined : { messages };
  });

  pi.rpc?.handle(DELIVER_REQUEST, (data) => {
    const details = parseDelivery(data);
    const mode = parseDeliveryMode(data);
    const { messageId } = details;
    reconcile();
    if (written().has(messageId)) return { messageId, duplicate: true, state: "written" };
    if (state.waiting.has(messageId) || state.handed.has(messageId)) return { messageId, duplicate: true, state: "queued" };
    let delivery;
    if (mode === "steer" && state.stepping && !idle()) {
      state.steered.add(messageId);
      send(details, { triggerTurn: false });
      delivery = "steered";
    } else {
      state.waiting.set(messageId, details);
      sendWhenIdle();
      delivery = state.handed.has(messageId) ? "started" : "queued";
    }
    return { messageId, duplicate: false, state: written().has(messageId) ? "written" : "queued", delivery };
  });

  if (!sessionLink) return;
  for (const tool of createSessionTools(() => sessionLink, { companion })) pi.registerTool(tool);
}

export default function sessionLinkExtension(pi, options) {
  installSessionLink(pi, options);
}
