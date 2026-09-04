import { isHeadlessCli } from "./cli-headless.mjs";

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[?1049l\x1b[?25h";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOGO_MIN_COLUMNS = 34;
const DEFAULT_STATUS = "엔진을 불러오는 중";

let painted = false;
let label = DEFAULT_STATUS;
let history = [DEFAULT_STATUS];
let tick = 0;
let timer = null;
let ioRef = null;
let envRef = process.env;

export function bootChromeColors(env = process.env) {
  const esc = "\x1b";
  const dim = `${esc}[2m`;
  const rst = `${esc}[0m`;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return {
      c1: `${esc}[38;2;244;162;97m`,
      c2: `${esc}[38;2;231;111;81m`,
      dim,
      rst,
    };
  }
  if (env.TERM && env.TERM !== "dumb") {
    return {
      c1: `${esc}[38;5;215m`,
      c2: `${esc}[38;5;209m`,
      dim,
      rst,
    };
  }
  return { c1: "", c2: "", dim, rst };
}

export function bootChromeColumnCount(io = process, env = process.env) {
  const fromIo = Number(io?.stdout?.columns);
  if (Number.isFinite(fromIo) && fromIo > 0) return fromIo;
  const fromEnv = Number(env.COLUMNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 80;
}

function statusList({ status, statuses }) {
  if (Array.isArray(statuses) && statuses.length > 0) return statuses;
  return [status ?? DEFAULT_STATUS];
}

export function composeBootChrome({
  env = process.env,
  columns = 80,
  status = DEFAULT_STATUS,
  statuses,
  frame = 0,
} = {}) {
  const { c1, c2, dim, rst } = bootChromeColors(env);
  const list = statusList({ status, statuses });
  const statusLines = list.map((item, index) => {
    const mark = index === list.length - 1 ? SPINNER[frame % SPINNER.length] : "·";
    return `  ${dim}${mark} ${item}${rst}`;
  });
  if (columns < LOGO_MIN_COLUMNS) return `${statusLines.join("\r\n")}\r\n`;
  return [
    `  ${c1}█▀▄  █ █  █▀▄  ▄▀▄  ▀█▀  ▄▀▄${rst}`,
    `  ${c2}█▀▄  █ █  █▀▄  █▀█   █   █ █${rst}`,
    `  ${c2}▀ ▀  ▀▀▀  ▀▀▀  ▀ ▀   ▀   ▀▀▀${rst}`,
    "",
    ...statusLines,
  ].join("\r\n") + "\r\n";
}

function firstStatusRow(columns) {
  return columns < LOGO_MIN_COLUMNS ? 1 : 5;
}

function currentStatusRow() {
  return firstStatusRow(bootChromeColumnCount(ioRef, envRef)) + history.length - 1;
}

function writeAtStatusRow(row, mark, text) {
  if (!ioRef?.stdout) return;
  const { dim, rst } = bootChromeColors(envRef);
  ioRef.stdout.write(`\x1b[${row};1H\x1b[2K  ${dim}${mark} ${text}${rst}`);
}

function writeStatusLine() {
  if (!painted) return;
  writeAtStatusRow(currentStatusRow(), SPINNER[tick % SPINNER.length], label);
}

export function shouldPaintBootChrome(argv = process.argv.slice(2), io = process, env = process.env) {
  if (env.CI || env.TERM === "dumb" || env.RUBATO_BOOT_CHROME === "0") return false;
  if (argv.includes("--version") || argv.includes("-v") || argv.includes("--help") || argv.includes("-h")) {
    return false;
  }
  if (isHeadlessCli(argv)) return false;
  return io.stdout?.isTTY === true && io.stdin?.isTTY === true;
}

export function setBootChromeStatus(next, io = ioRef) {
  if (!painted || typeof next !== "string" || next.length === 0) return false;
  if (io) ioRef = io;
  if (next === label) return true;
  writeAtStatusRow(currentStatusRow(), "·", label);
  label = next;
  history.push(next);
  const { dim, rst } = bootChromeColors(envRef);
  ioRef.stdout.write(`\r\n  ${dim}${SPINNER[tick % SPINNER.length]} ${label}${rst}`);
  return true;
}

/** Stop writing. The live TUI keeps the same alt-screen. */
export function releaseBootChrome() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  painted = false;
  ioRef = null;
}

/** Enter alt-screen before senpi's graph. Senpi ui.start() takes over the same screen. */
export function enterBootChrome(argv = process.argv.slice(2), io = process, env = process.env) {
  if (!shouldPaintBootChrome(argv, io, env)) return false;
  releaseBootChrome();
  painted = true;
  ioRef = io;
  envRef = env;
  label = DEFAULT_STATUS;
  history = [DEFAULT_STATUS];
  tick = 0;
  const columns = bootChromeColumnCount(io, env);
  io.stdout.write(`${ENTER_ALT}${composeBootChrome({ env, columns, status: label, frame: 0 })}`);
  timer = setInterval(() => {
    tick += 1;
    writeStatusLine();
  }, 80);
  timer.unref?.();
  return true;
}

/** Crash path only. A live TUI owns the alt-screen after ui.start(). */
export function abandonBootChrome(io = process) {
  releaseBootChrome();
  try {
    io.stdout.write(LEAVE_ALT);
  } catch {
    // The TTY may already be gone.
  }
}

export function resetBootChromeForTests() {
  releaseBootChrome();
  label = DEFAULT_STATUS;
  history = [DEFAULT_STATUS];
  tick = 0;
  envRef = process.env;
}
