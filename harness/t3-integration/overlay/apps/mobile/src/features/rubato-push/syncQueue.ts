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
