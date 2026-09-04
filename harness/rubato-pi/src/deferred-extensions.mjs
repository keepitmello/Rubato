import { isHeadlessCli } from "./cli-headless.mjs";
import { isTeamMemberProcess } from "./member-identity.mjs";

const pending = [];
let firstPaintDone = false;

/** Interactive TTY only. RPC/print/members keep the old "load during factory" path. */
export function shouldDeferExtensionActivation(argv = process.argv.slice(2), stdout = process.stdout, stdin = process.stdin) {
  if (isTeamMemberProcess()) return false;
  if (isHeadlessCli(argv)) return false;
  return stdout?.isTTY === true && stdin?.isTTY === true;
}

export function hasFinishedFirstPaintDeferral() {
  return firstPaintDone;
}

/**
 * First interactive paint queues work. After that, /resume /new /fork load a
 * new factory and must attach immediately — the boot queue is already empty.
 */
export async function runOrDeferExtension(activate) {
  if (typeof activate !== "function") return;
  if (firstPaintDone || !shouldDeferExtensionActivation()) return activate();
  pending.push(activate);
}

export function registerDeferredExtension(activate) {
  void runOrDeferExtension(activate);
}

export async function activateDeferredExtensions() {
  firstPaintDone = true;
  const batch = pending.splice(0, pending.length);
  await Promise.all(batch.map((activate) => activate()));
}

export function resetDeferredExtensionsForTests() {
  pending.length = 0;
  firstPaintDone = false;
}
