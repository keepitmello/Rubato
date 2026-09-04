import { isHeadlessCli } from "./cli-headless.mjs";
import { isTeamMemberProcess } from "./member-identity.mjs";

const pending = [];

/** Interactive TTY only. RPC/print/members keep the old "load during factory" path. */
export function shouldDeferExtensionActivation(argv = process.argv.slice(2), stdout = process.stdout, stdin = process.stdin) {
  if (isTeamMemberProcess()) return false;
  if (isHeadlessCli(argv)) return false;
  return stdout?.isTTY === true && stdin?.isTTY === true;
}

export function registerDeferredExtension(activate) {
  if (typeof activate !== "function") return;
  pending.push(activate);
}

export async function activateDeferredExtensions() {
  const batch = pending.splice(0, pending.length);
  await Promise.all(batch.map((activate) => activate()));
}

export function resetDeferredExtensionsForTests() {
  pending.length = 0;
}
