/** One request at a time. Leaving the screen cancels the request as well as its next wake-up.
 * Returning false means the record is final (e.g. a finished call's transcript). */
export function startRoomPoll(delay: number, ask: (signal: AbortSignal) => Promise<void | false | number>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    let again: void | false | number = undefined;
    try {
      again = await ask(controller.signal);
    } catch {
      // The Mac may be offline. Keep the last answer and retry only while still on screen.
    }
    if (!controller.signal.aborted && again !== false) timer = setTimeout(tick, typeof again === "number" ? again : delay);
  }
  void tick();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

/** Probe promptly after opening or a change. A steady mark doesn't need a radio wake every second. */
export function startLiveWorkPoll<T>(
  read: (signal: AbortSignal) => Promise<T>,
  show: (value: T) => void,
) {
  let previous: T;
  let seen = false;
  let delay = 1_200;
  return startRoomPoll(4_000, async (signal) => {
    const work = await read(signal);
    if (signal.aborted) return false;
    if (!seen || work !== previous) {
      seen = true;
      previous = work;
      delay = 1_200;
      show(work);
    } else {
      delay = Math.min(delay * 2, 4_000);
    }
    return delay;
  });
}
