/** One request at a time. Leaving the screen cancels the request as well as its next wake-up.
 * Returning false means the record is final (e.g. a finished call's transcript). */
export function startRoomPoll(delay: number, ask: (signal: AbortSignal) => Promise<void | false>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    let again: void | false = undefined;
    try {
      again = await ask(controller.signal);
    } catch {
      // The Mac may be offline. Keep the last answer and retry only while still on screen.
    }
    if (!controller.signal.aborted && again !== false) timer = setTimeout(tick, delay);
  }
  void tick();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
