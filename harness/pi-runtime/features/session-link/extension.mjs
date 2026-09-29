import { DELIVER_REQUEST, SESSION_MESSAGE_TYPE, buildSessionMessage, deliveredMessageIds, parseDelivery } from "./message.mjs";
import { renderSessionMessage } from "./render.mjs";
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
 * Pi's steering queue, which a user's clear empties and no extension can read:
 * - idle session: sent with a turn; Pi writes it as the run starts and the first request reads it;
 * - running session: held here until the run ends, never handed over mid-run, since whether the
 *   run makes another request cannot be told from its tool results (a provider can return results
 *   it already executed, and a tool can end the run). After a normal end it is sent with a turn,
 *   which starts the next run inside this run's settle; after a stop or failure it is written
 *   without one.
 * Each path writes the message once, so a messageId is a duplicate while it is held here or by Pi,
 * and once it is in the transcript.
 */
export function installSessionLink(pi, { sessionLink } = {}) {
  const state = {
    ctx: undefined,
    waiting: new Map(), // messageId -> details, in arrival order: held here for a boundary
    handed: new Set(), // messageIds sent to Pi and not yet seen in the transcript
    running: false, // between this session's agent_start and agent_settled
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

  function reset(ctx) {
    clearTimeout(state.retry);
    Object.assign(state, { ctx, waiting: new Map(), handed: new Set(), running: false, interrupted: false, retry: undefined });
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", () => reset(undefined));
  pi.on("agent_start", () => {
    state.running = true;
    state.interrupted = false;
  });
  pi.on("agent_end", (event, ctx) => {
    const last = (event?.messages ?? []).findLast((message) => message?.role === "assistant");
    state.interrupted = Boolean(ctx?.signal?.aborted) || last?.stopReason === "aborted" || last?.stopReason === "error";
  });
  pi.on("agent_settled", () => {
    state.running = false;
    reconcile();
    sendWhenIdle({ settled: true });
  });

  pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);

  pi.rpc?.handle(DELIVER_REQUEST, (data) => {
    const details = parseDelivery(data);
    const { messageId } = details;
    reconcile();
    if (written().has(messageId)) return { messageId, duplicate: true, state: "written" };
    if (state.waiting.has(messageId) || state.handed.has(messageId)) return { messageId, duplicate: true, state: "queued" };
    state.waiting.set(messageId, details);
    sendWhenIdle();
    return { messageId, duplicate: false, state: written().has(messageId) ? "written" : "queued" };
  });

  if (!sessionLink) return;
  for (const tool of createSessionTools(() => sessionLink)) pi.registerTool(tool);
}

export default function sessionLinkExtension(pi, options) {
  installSessionLink(pi, options);
}
