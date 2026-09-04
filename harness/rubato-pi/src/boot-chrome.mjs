import { isHeadlessCli } from "./cli-headless.mjs";

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[?1049l\x1b[?25h";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOGO_MIN_COLUMNS = 34;
const DEFAULT_STATUS = "엔진을 불러오는 중";

let painted = false;
let label = DEFAULT_STATUS;
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

export function composeBootChrome({
  env = process.env,
  columns = 80,
  status = DEFAULT_STATUS,
  frame = 0,
} = {}) {
  const { c1, c2, dim, rst } = bootChromeColors(env);
  const spin = SPINNER[frame % SPINNER.length];
  const statusLine = `  ${dim}${spin} ${status}${rst}`;
  if (columns < LOGO_MIN_COLUMNS) return `${statusLine}\r\n`;
  return [
    `  ${c1}█▀▄  █ █  █▀▄  ▄▀▄  ▀█▀  ▄▀▄${rst}`,
    `  ${c2}█▀▄  █ █  █▀▄  █▀█   █   █ █${rst}`,
    `  ${c2}▀ ▀  ▀▀▀  ▀▀▀  ▀ ▀   ▀   ▀▀▀${rst}`,
    "",
    statusLine,
  ].join("\r\n") + "\r\n";
}

function statusRow(columns) {
  return columns < LOGO_MIN_COLUMNS ? 1 : 5;
}

function writeStatusLine() {
  if (!painted || !ioRef?.stdout) return;
  const columns = bootChromeColumnCount(ioRef, envRef);
  const { dim, rst } = bootChromeColors(envRef);
  const spin = SPINNER[tick % SPINNER.length];
  ioRef.stdout.write(`\x1b[${statusRow(columns)};1H\x1b[2K  ${dim}${spin} ${label}${rst}`);
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
  label = next;
  if (io) ioRef = io;
  writeStatusLine();
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
  tick = 0;
  envRef = process.env;
}
