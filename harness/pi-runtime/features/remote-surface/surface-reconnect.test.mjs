import assert from "node:assert/strict";
import test from "node:test";
import { RemoteSurface } from "./surface.mjs";
import { loadRemoteProtocol } from "./protocol-loader.mjs";

// A hub that is not listening is asked again every second, and the backoff for a hub that accepts and
// then drops the surface does not grow while it is down: the surface is back within a second of the
// hub, however long the hub was gone.
function hubDownCase(RemoteSurface, protocol) {
  return async () => {
    const timers = [];
    let attempts = 0;
    let listening = false;
    const surface = new RemoteSurface({}, protocol, {
      surfaceToken: "surface-token",
      connect: async () => {
        attempts += 1;
        if (!listening) throw Object.assign(new Error("connect ECONNREFUSED"), { code: attempts % 2 ? "ECONNREFUSED" : "ENOENT" });
        return { send() {}, close() {} };
      },
      clock: { now: () => 0, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval, clearInterval },
    });
    const errors = console.error;
    console.error = () => {};
    try {
      for (let index = 0; index < 8; index += 1) {
        if (index === 0) await surface.connectNow();
        else await timers.at(-1).fn();
      }
    } finally { console.error = errors; }
    assert.deepEqual(timers.map((timer) => timer.ms), [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000]);
    assert.equal(surface.reconnectDelay, 250, "the drop backoff did not grow while the hub was down");
    listening = true;
    await timers.at(-1).fn();
    assert.equal(surface.connection !== undefined, true);
    // A connection the hub opened and then dropped still backs off as before.
    surface.disconnected();
    assert.equal(timers.at(-1).ms, 250);
    surface.disconnected();
    assert.equal(surface.reconnectDelay, 500);
    surface.stop();
  };
}

test("a hub that is not listening is retried every second without growing the backoff", async () => {
  const { module: protocol } = await loadRemoteProtocol();
  await hubDownCase(RemoteSurface, protocol)();
});
