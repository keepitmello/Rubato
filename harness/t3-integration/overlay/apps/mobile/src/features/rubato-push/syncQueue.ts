/** Both jobs write the same device state. Serialize them, and let a registration already
 * in flight cover any card requests up until it actually starts reading the Macs' cards. */
export function createPushSyncQueue(register: () => Promise<void>, refreshCard: () => Promise<void>) {
  let full = false;
  let card = false;
  let running = false;
  return async (scope: "full" | "card") => {
    if (scope === "full") full = true;
    card = true;
    if (running) return;
    running = true;
    try {
      while (full || card) {
        if (full) {
          full = false;
          await register();
        } else {
          card = false;
          await refreshCard();
        }
      }
    } finally {
      running = false;
    }
  };
}

/** Notification Center and system prompts make iOS inactive, not backgrounded. Only replay
 * a card that actually missed its foreground window; a real return also reconciles tokens. */
export function foregroundPushRefresh(initial: string | null) {
  let needsFull = initial !== "active";
  let missed = false;
  return {
    missedCard() { missed = true; },
    change(state: string): "full" | "card" | null {
      if (state === "background") needsFull = true;
      if (state !== "active") return null;
      const scope = needsFull ? "full" : missed ? "card" : null;
      needsFull = false;
      missed = false;
      return scope;
    },
  };
}
