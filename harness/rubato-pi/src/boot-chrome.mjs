import { stripVTControlCharacters } from "node:util";
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { isHeadlessCli } from "./cli-headless.mjs";
import { RELEASE_MS, WORDMARK, renderResonance, resonanceColor } from "./boot-resonance.mjs";

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[0m\x1b[?1049l\x1b[?25h";
const DEFAULT_STATUS = "엔진을 불러오는 중";
let ioRef = null, worker = null, control = null, onResize = null;
let finishPromise = null, resolveFinish = null, rejectFinish = null, workerError = null;

function dimension(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export function bootChromeColumnCount(io = process, env = process.env) {
  return dimension(io?.stdout?.columns, dimension(env.COLUMNS, 80));
}
export function bootChromeRowCount(io = process, env = process.env) {
  return dimension(io?.stdout?.rows, dimension(env.LINES, 24));
}
// All status strings are plain text. Count Korean/CJK cells without importing the TUI graph.
function charWidth(char) {
  const c = char.codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff01 && c <= 0xff60) ? 2 : 1;
}
function fit(text, width) {
  let out = "", cells = 0;
  for (const c of stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ")) {
    const next = charWidth(c);
    if (cells + next > width) break;
    cells += next; out += c;
  }
  return { text: out, cells };
}

export function composeBootChrome({
  env = process.env, columns = 80, rows = 24, status = DEFAULT_STATUS, time = 0, release = null,
} = {}) {
  columns = dimension(columns, 80); rows = dimension(rows, 24);
  let lines = Array(rows).fill("");
  let overlay = "";
  // Reserve an untouched rightmost column to avoid terminal autowrap/scroll.
  const available = Math.max(0, columns - 1);
  const artColumns = Math.max(0, Math.min(80, columns - 4, Math.floor((rows - 7) * 80 / 28)));
  const artRows = Math.floor(artColumns * 28 / 80);
  const showArt = artColumns >= 16 && artRows >= 5;
  const height = (showArt ? artRows + 2 : 0) + (rows >= 3 ? 3 : 1);
  const top = Math.max(0, Math.min(rows - height, Math.round(rows * .45 - height / 2)));
  const ended = release !== null && release >= RELEASE_MS;
  const fading = release !== null && release >= RELEASE_MS - 750;
  const color = resonanceColor(fading ? 1 : 7, env);
  const centered = (text, tone) => {
    const clipped = fit(text, available);
    return " ".repeat(Math.max(0, Math.floor((available - clipped.cells) / 2))) + tone + clipped.text + "\x1b[0m";
  };
  if (!ended) {
    let row = top;
    if (showArt) {
      const left = Math.max(0, Math.floor((available - artColumns) / 2));
      if (release !== null) {
        // Expand the canvas, not the mark. Its scale and origin are unchanged
        // on the first release frame; only outgoing particles use the extra room.
        const releaseRadius = Math.max(90, Math.hypot(
          available * 2 / (artColumns / 80),
          rows * 4 / (artRows / 28) / .7,
        ) / 2);
        lines = renderResonance({
          time, release, columns: available, rows, env, artColumns, artRows,
          offsetColumns: left, offsetRows: top, releaseRadius,
        });
        row += artRows;
      } else {
        for (const line of renderResonance({ time, columns: artColumns, rows: artRows, env })) {
          lines[row++] = " ".repeat(left) + line;
        }
      }
      row += 2;
    }
    const putLabel = (y, text, tone) => {
      if (release !== null && showArt) {
        const fitted = fit(text, available);
        const x = Math.max(0, Math.floor((available - fitted.cells) / 2));
        overlay += `\x1b[${y + 1};${x + 1}H${tone}${fitted.text}\x1b[0m`;
      } else {
        lines[y] = centered(text, tone);
      }
    };
    if (rows >= 3) {
      putLabel(row++, WORDMARK, color);
      row++;
    }
    const mark = release === null ? ["·", "⠂", "⠆", "⠇", "⠆", "⠂"][Math.floor(time / 180) % 6] : "✓";
    if (row < rows) putLabel(row, `${mark} ${release === null ? status : "준비 완료"}`, resonanceColor(fading ? 1 : 4, env));
  }
  // Atomic redraw, absolute rows, no newline at the bottom: no scrollback pollution.
  return "\x1b[?2026h" + lines.map((line, i) => `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`).join("") + overlay + "\x1b[?2026l";
}

export function shouldPaintBootChrome(argv = process.argv.slice(2), io = process, env = process.env) {
  if (env.CI || env.TERM === "dumb" || env.RUBATO_BOOT_CHROME === "0" || env.RUBATO_NO_SPLASH) return false;
  if (argv.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg))) return false;
  return !isHeadlessCli(argv) && io.stdout?.isTTY === true && io.stdin?.isTTY === true;
}
export function setBootChromeStatus(next, io = ioRef) {
  if (!ioRef || typeof next !== "string" || !next) return false;
  worker?.postMessage({ status: next });
  return true;
}

/** Immediate cancellation / ownership release. Never writes after the live TUI starts. */
export function releaseBootChrome() {
  if (control && Atomics.load(control, 4) === 0) {
    Atomics.store(control, 0, 1);
    // The renderer writes directly to the TTY. Wait for its acknowledgement so
    // neither cancellation nor the next owner can race a final worker paint.
    Atomics.wait(control, 4, 0, 1000);
  }
  worker?.terminate();
  if (onResize) ioRef?.stdout?.off?.("resize", onResize);
  worker = null; control = null; onResize = null;
  ioRef = null;
  const resolve = resolveFinish;
  resolveFinish = null; rejectFinish = null; finishPromise = null;
  resolve?.(false);
}

/** Called at the existing interactive-screen boundary, before ui.start(). */
export function finishBootChrome() {
  if (workerError) return Promise.reject(workerError);
  if (!ioRef) return Promise.resolve(false);
  if (finishPromise) return finishPromise;
  finishPromise = new Promise((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
  Atomics.store(control, 1, 1);
  // A pending UI handoff must keep the process alive; loading alone need not.
  worker.ref();
  return finishPromise;
}

export function enterBootChrome(argv = process.argv.slice(2), io = process, env = process.env) {
  if (!shouldPaintBootChrome(argv, io, env)) return false;
  releaseBootChrome();
  ioRef = io; workerError = null;
  control = new Int32Array(new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT));
  onResize = () => {
    Atomics.store(control, 2, bootChromeColumnCount(io, env));
    Atomics.store(control, 3, bootChromeRowCount(io, env));
  };
  onResize();
  writeSync(io.stdout.fd ?? 1, ENTER_ALT + composeBootChrome({
    env, columns: control[2], rows: control[3], status: DEFAULT_STATUS,
  }));
  const current = new Worker(new URL("./boot-worker.mjs", import.meta.url), {
    // Never load engine hooks in the renderer; they would recreate the startup stall.
    execArgv: [], env: { ...process.env, NODE_OPTIONS: "" },
    workerData: { control: control.buffer, fd: io.stdout.fd ?? 1, env },
  });
  worker = current;
  const fail = (error) => {
    if (worker !== current) return;
    workerError = error;
    const reject = rejectFinish;
    rejectFinish = null; resolveFinish = null;
    releaseBootChrome();
    writeSync(io.stdout.fd ?? 1, LEAVE_ALT);
    reject?.(error);
  };
  current.on("message", (message) => {
    if (message !== "finished" || worker !== current) return;
    const resolve = resolveFinish;
    resolveFinish = null;
    releaseBootChrome();
    resolve?.(true);
  });
  current.on("error", fail);
  current.on("exit", (code) => {
    if (worker === current) fail(new Error(`Boot renderer exited before handoff (code ${code})`));
  });
  io.stdout.on?.("resize", onResize);
  current.unref();
  return true;
}

/** Crash/exit only, and only while this splash still owns the screen. */
export function abandonBootChrome(io = ioRef) {
  if (!ioRef) return;
  releaseBootChrome();
  try { writeSync(io?.stdout?.fd ?? 1, LEAVE_ALT); } catch { /* TTY may already be gone. */ }
}
export function resetBootChromeForTests() {
  releaseBootChrome();
  workerError = null;
}
