import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { composeBootChrome } from "./boot-chrome.mjs";
import { INTRO_MS, RELEASE_MS, CLEAR_MS } from "./boot-resonance.mjs";

const control = new Int32Array(workerData.control);
let elapsed = 0, previous = Date.now(), release = null, status = "엔진을 불러오는 중";
let timer;
parentPort.on("message", (message) => {
  if (typeof message.status === "string") status = message.status;
});
function stop(finished) {
  clearInterval(timer);
  Atomics.store(control, 4, 1);
  Atomics.notify(control, 4);
  if (finished) parentPort.postMessage("finished");
  parentPort.close();
}
function tick() {
  if (Atomics.load(control, 0)) { stop(false); return; }
  const now = Date.now(), delta = Math.max(0, Math.min(100, now - previous));
  previous = now; elapsed += delta;
  if (Atomics.load(control, 1) && elapsed >= INTRO_MS) release = release === null ? 0 : release + delta;
  const columns = Atomics.load(control, 2), rows = Atomics.load(control, 3);
  const frame = composeBootChrome({
    env: workerData.env, columns, rows,
    status, time: elapsed, release,
  });
  // Worker process.stdout proxies through the blocked main event loop.
  // A direct descriptor write is essential to keep animation independent.
  if (Atomics.load(control, 0)) { stop(false); return; }
  if (columns !== Atomics.load(control, 2) || rows !== Atomics.load(control, 3)) return;
  writeSync(workerData.fd, frame);
  if (release !== null && release >= RELEASE_MS + CLEAR_MS) {
    writeSync(workerData.fd, "\x1b[0m\x1b[2J\x1b[H");
    stop(true);
  }
}
timer = setInterval(tick, 50);
