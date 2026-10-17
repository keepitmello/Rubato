// One gate for every agent loop in this process: the profile engine hosts every
// conversation, and the children an in-process task runner starts run their loops here too.
//
// A restart (pi-server drain.mjs) closes the gate. A loop that reaches its next model request
// then waits there instead of sending it: the reply it was writing and the tool calls that
// reply asked for have finished and are in the session file, and nothing that was paid for is
// lost. The engine closes once every running loop waits here. The abort that closes a session
// ends a waiting loop without a message, so the session file ends at those tool results and
// the next engine continues from them (conversation-rewind `continue`).
//
// The gate is a process singleton under a global symbol, so a second copy of this module (a
// runtime loaded twice) still counts the same loops.
const KEY = Symbol.for("rubato.drain-gate");

export function createDrainGate() {
  let active = 0;
  let parked = 0;
  let draining = false;
  const released = new Set();
  return {
    get draining() { return draining; },
    get active() { return active; },
    get parked() { return parked; },
    /** Every running loop waits at the gate, or none runs. */
    get quiet() { return active === parked; },
    /** A loop starts. The returned function ends it, once. */
    enter() {
      active += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        active -= 1;
      };
    },
    /** Close the gate: the next model request of every loop waits. */
    begin() { draining = true; },
    /** Open it again (a restart that gave up): waiting loops send their request. */
    end() {
      draining = false;
      for (const release of [...released]) release(false);
    },
    /**
     * Wait at the gate while it is closed. Resolves true when the loop must stop (its run was
     * aborted while waiting), false when it may send its request.
     */
    park(signal) {
      if (!draining) return Promise.resolve(false);
      if (signal?.aborted) return Promise.resolve(true);
      parked += 1;
      return new Promise((resolve) => {
        let done = false;
        const finish = (stop) => {
          if (done) return;
          done = true;
          released.delete(finish);
          signal?.removeEventListener("abort", onAbort);
          parked -= 1;
          resolve(stop);
        };
        const onAbort = () => finish(true);
        released.add(finish);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export const rubatoDrainGate = globalThis[KEY] ??= createDrainGate();
