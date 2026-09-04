import { isHeadlessCli } from "./cli-headless.mjs";

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[?1049l\x1b[?25h";
const MARK = "\x1b[2m  rubato\x1b[0m\r\n";

export function shouldPaintBootChrome(argv = process.argv.slice(2), io = process, env = process.env) {
  if (env.CI || env.TERM === "dumb" || env.RUBATO_BOOT_CHROME === "0") return false;
  if (argv.includes("--version") || argv.includes("-v") || argv.includes("--help") || argv.includes("-h")) {
    return false;
  }
  if (isHeadlessCli(argv)) return false;
  return io.stdout?.isTTY === true && io.stdin?.isTTY === true;
}

/** Enter alt-screen before senpi's graph. Senpi ui.start() takes over the same screen. */
export function enterBootChrome(argv = process.argv.slice(2), io = process, env = process.env) {
  if (!shouldPaintBootChrome(argv, io, env)) return false;
  io.stdout.write(`${ENTER_ALT}${MARK}`);
  return true;
}

/** Crash path only. A live TUI owns the alt-screen after ui.start(). */
export function abandonBootChrome(io = process) {
  try {
    io.stdout.write(LEAVE_ALT);
  } catch {
    // The TTY may already be gone.
  }
}
