/** Modes that never reach InteractiveMode.init. */
const HEADLESS_MODES = new Set(["json", "print", "rpc"]);

/** RPC/print/json/--print. InteractiveMode.init never runs here. */
export function isHeadlessCli(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--print" || token === "-p") return true;
    if (token === "app-server") return true;
    if (token === "--mode") {
      if (HEADLESS_MODES.has(argv[i + 1])) return true;
      continue;
    }
    if (typeof token === "string" && token.startsWith("--mode=") && HEADLESS_MODES.has(token.slice("--mode=".length))) {
      return true;
    }
  }
  return false;
}
