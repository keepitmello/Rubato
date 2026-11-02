// What the engine's one thread costs, in pi-server.log. Every conversation, the app's requests
// and the resident services share that thread, so when it is held everything waits: a reply
// stops streaming, a new thread times out. These lines say when and for how long, so a slow
// moment can be matched to what ran then (`session … opened in`, `catalogue … in`).

/** Logs each stretch the event loop could not turn for `thresholdMs` or longer. */
export function watchStalls({ log, thresholdMs = 1000, intervalMs = 200, now = () => performance.now(),
  every = setInterval, stop = clearInterval } = {}) {
  let last = now();
  const timer = every(() => {
    const at = now();
    const held = at - last - intervalMs;
    last = at;
    if (held >= thresholdMs) log(`engine stalled ${Math.round(held)}ms`);
  }, intervalMs);
  timer?.unref?.();
  return () => stop(timer);
}

/** Opening a conversation or listing a folder's catalogue at or above this is logged. */
export const SLOW_OPEN_MS = 1500;
