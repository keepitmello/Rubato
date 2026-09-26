export const EXTENSION_RPC_CHANNEL = "rubato.extension-rpc.event";

function rpcName(name) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("Extension RPC name must not be empty");
  return name.trim();
}

/** Registry ownership follows the stock extension and its runtime lifetime. */
export function createExtensionRpc(extension, assertActive, eventBus) {
  return {
    emit(name, data) {
      assertActive();
      eventBus.emit(EXTENSION_RPC_CHANNEL, { name: rpcName(name), data });
    },
    handle(name, handler) {
      assertActive();
      const normalized = rpcName(name);
      if (typeof handler !== "function") throw new TypeError("Extension RPC handler must be a function");
      const handlers = extension.rpcHandlers ??= new Map();
      if (handlers.has(normalized)) throw new Error(`RPC extension request handler already registered: ${normalized}`);
      handlers.set(normalized, handler);
    },
  };
}

/**
 * Every `<namespace>.pending-work` handler answers with the work that will still wake this
 * session: `active` (running work whose completion is delivered as a turn) and `undelivered`
 * (a completion already produced but not yet handed to the session). Several extensions may
 * answer; an unanswerable source holds nothing.
 */
export const PENDING_WORK_SUFFIX = ".pending-work";

function countOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export async function collectPendingWork(extensions, assertActive) {
  assertActive();
  const handlers = extensions.flatMap((extension) =>
    [...(extension.rpcHandlers ?? [])].filter(([name]) => name.endsWith(PENDING_WORK_SUFFIX)).map(([, handler]) => handler));
  let active = 0, undelivered = 0;
  for (const handler of handlers) {
    try {
      const result = await handler(undefined);
      active += countOf(result?.active);
      undelivered += countOf(result?.undelivered);
    } catch {}
  }
  assertActive();
  return { active, undelivered };
}

/**
 * A one-shot run ends when the agent is idle with nothing pending, not when its first turn
 * ends: a tool that answered "completion will be reported automatically" wakes the session
 * with a follow-up turn, and the run must still be there to take it. Completions that sit
 * undelivered while the session idles past `stuckDeliveryMs` stop holding the run, so a
 * delivery that can no longer happen cannot keep the process alive. Once the run has held,
 * "nothing pending" must last `settleMs` before it ends: some hand-offs are asynchronous
 * with no count in between (a team's aggregate wake goes through the lead's mailbox, polled
 * every second). A run that never held exits at once.
 */
export async function holdForPendingWork(getSession, options = {}) {
  const pollMs = options.pollMs ?? 250;
  const stuckDeliveryMs = options.stuckDeliveryMs ?? 90_000;
  const settleMs = options.settleMs ?? 3_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let stuckSince, held = false, settled = false;
  for (;;) {
    const session = getSession();
    await session.waitForIdle();
    if (typeof session.extensionRunner?.pendingWork !== "function") return;
    let pending;
    try { pending = await session.extensionRunner.pendingWork(); } catch { return; }
    if (getSession() !== session || !session.isIdle) { stuckSince = undefined; held = true; settled = false; continue; }
    if (pending.active === 0 && pending.undelivered === 0) {
      if (!held || settled) return;
      settled = true;
      await sleep(settleMs);
      continue;
    }
    held = true; settled = false;
    if (pending.active === 0) {
      stuckSince ??= now();
      if (now() - stuckSince >= stuckDeliveryMs) return;
    } else stuckSince = undefined;
    await sleep(pollMs);
  }
}

export async function requestExtensionRpc(extensions, assertActive, name, data) {
  assertActive();
  const normalized = rpcName(name);
  const handlers = extensions.flatMap((extension) => {
    const handler = extension.rpcHandlers?.get(normalized);
    return handler ? [handler] : [];
  });
  if (!handlers.length) throw new Error(`Unknown extension RPC request: ${normalized}`);
  if (handlers.length > 1) throw new Error(`Multiple extension RPC request handlers registered: ${normalized}`);
  const result = await handlers[0](data);
  assertActive(); // An answer from an unloaded runtime is not a current result.
  return result;
}
