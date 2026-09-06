// Shell-phase Resonance renderer. rubato-pi.sh starts this right after
// `rubato-splash.sh open` so the intro animates through the shell prerequisites
// (skills sync, engine freshness) instead of only once Node is up. The engine
// entry point (enterBootChrome) adopts the alt-screen and the clock instead of
// re-entering the screen and replaying the intro.
//
// Protocol, all inside the directory given as argv[2]:
//   t0      written here at start: epoch ms the intro began
//   status  written by the shell (`rubato-splash.sh step`), one plain line
//   stop    written by the next owner: "adopt" (engine takes the screen as-is)
//           or "close" (leave the alt-screen). Acknowledged with `stopped`,
//           after which this process never writes to the TTY again.
//   pid     written here so a stuck renderer can be killed by the adopter.
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { bootChromeColumnCount, bootChromeRowCount, composeBootChrome } from "./boot-chrome.mjs";

export const LEAVE_ALT = "\x1b[0m\x1b[?1049l\x1b[?25h";
const DEFAULT_STATUS = "시작을 준비하는 중";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: boot-splash.mjs <dir>\n");
  process.exit(2);
}
const fd = 1;
// The session picker may have started this intro in the previous terminal
// owner; continue its clock so the attach cut lands on the same frame.
const inherited = Number(process.env.RUBATO_BOOT_T0);
const t0 = Number.isFinite(inherited) && inherited > 0 && inherited <= Date.now() ? inherited : Date.now();
writeFileSync(join(dir, "t0"), String(t0));
writeFileSync(join(dir, "pid"), String(process.pid));

let previous = Date.now(), elapsed = previous - t0, done = false;
function finish(leave) {
  if (done) return;
  done = true;
  clearInterval(timer);
  if (leave) { try { writeSync(fd, LEAVE_ALT); } catch { /* TTY may be gone */ } }
  try { writeFileSync(join(dir, "stopped"), leave ? "closed" : "adopted"); } catch { /* dir may be gone */ }
  process.exit(0);
}
const parent = process.ppid;
function parentAlive() {
  if (parent <= 1) return false;
  try { process.kill(parent, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function readStatus() {
  try {
    const text = readFileSync(join(dir, "status"), "utf8").trim();
    return text || DEFAULT_STATUS;
  } catch { return DEFAULT_STATUS; }
}
function tick() {
  if (done) return;
  let stop = null;
  try { stop = readFileSync(join(dir, "stop"), "utf8").trim(); } catch { /* keep running */ }
  if (stop !== null) { finish(stop !== "adopt"); return; }
  // The launcher exec's into the engine, so its pid survives; if that lineage
  // died we are an orphan and must give the terminal back. process.ppid is
  // sampled once at startup, so probe the parent instead of comparing to 1.
  if (!parentAlive() || !existsSync(dir)) { finish(true); return; }
  const now = Date.now(), delta = Math.max(0, Math.min(100, now - previous));
  previous = now; elapsed += delta;
  const columns = bootChromeColumnCount(process, process.env), rows = bootChromeRowCount(process, process.env);
  try {
    writeSync(fd, composeBootChrome({ env: process.env, columns, rows, status: readStatus(), time: elapsed }));
  } catch { finish(false); }
}
const timer = setInterval(tick, 50);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => finish(true));
