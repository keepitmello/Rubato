import { DRAIN_TIMEOUT_MS } from './drain.mjs';

/*
 * A stopped engine has handed its conversations to the next one (drain.mjs) and closed its
 * socket, so nothing it still holds serves anyone. It used to end only when its event loop
 * emptied: a close step that never returned, or a handle something left open, kept the process
 * alive with no socket. launchd counts a live process as its running engine and starts no other,
 * so the app found no engine until someone killed that process by hand (2026-10-23, 17 minutes).
 *
 * Now the engine leaves on its own, and says what held it so that one can be fixed:
 *   - closed: the event loop gets `graceMs` to empty; if something still holds it, the engine
 *     names those resources and exits.
 *   - not closed `limitMs` after the stop: the engine names the close step it is stuck in and
 *     exits. The limit covers the drain and stays well inside what a restart waits for the old
 *     process (restart-profile-engine.mjs), so the restart sees it end and the next one starts.
 */
export const STOP_LIMIT_MS = DRAIN_TIMEOUT_MS + 60_000;
export const EXIT_GRACE_MS = 2_000;

/** "PipeWrap, Timeout ×2" from process.getActiveResourcesInfo(). */
export function describeResources(types) {
  const counts = new Map();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts].map(([type, count]) => count > 1 ? `${type} ×${count}` : type).join(', ') || 'nothing';
}

/** Close `service` with a drain and make sure the process ends. Resolves with the exit code a
 * clean close leaves, for the event loop to end with. */
export async function closeAndExit(service, { exit, log, limitMs = STOP_LIMIT_MS, graceMs = EXIT_GRACE_MS,
  resources = () => process.getActiveResourcesInfo() }) {
  const limit = setTimeout(() => {
    log(`rubato-pi-server: closing did not finish within ${Math.round(limitMs / 1000)} s (stuck at: ${service.closingStep ?? 'unknown'}; `
      + `still open: ${describeResources(resources())}); exiting`);
    exit(1);
  }, limitMs);
  limit.unref?.();
  let code = 0;
  try { await service.close({ drain: true }); } catch (error) { log(error?.stack ?? String(error)); code = 1; }
  clearTimeout(limit);
  setTimeout(() => {
    log(`rubato-pi-server: closed, but ${describeResources(resources())} still held the process; exiting`);
    exit(code);
  }, graceMs).unref?.();
  return code;
}
