// Bringing up the Cua Driver daemon, kept apart from Electron so its decisions can be tested.

export interface CuaDaemonHost {
  /** `cua-driver status` reaches a daemon. */
  running(): Promise<boolean>;
  /** Pids of the CuaDriver.app `serve` processes alive now. */
  servePids(): Promise<number[]>;
  /** Launch CuaDriver.app through LaunchServices. */
  open(): Promise<void>;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
}

async function until(check: () => Promise<boolean>, host: CuaDaemonHost, waitMs: number, stepMs: number) {
  for (let waited = 0; ; waited += stepMs) {
    if (await check()) return true;
    if (waited >= waitMs) return false;
    await host.sleep(stepMs);
  }
}

/**
 * Starts the daemon and reports whether the CLI reaches it afterwards.
 *
 * A CuaDriver.app instance can outlive its socket: another `cua-driver serve` replaced the socket
 * file and pid file, then exited. Every call then says "not running", and `open` only reactivates
 * the unreachable instance instead of starting a new one, so the state never heals by itself.
 * When the daemon still does not answer, the instances that were alive before this launch are
 * those unreachable ones: stop them and launch again. One that appeared after the launch may
 * still be starting on a busy machine, so it is left alone.
 */
export async function startCuaDaemon(host: CuaDaemonHost, waitMs = 10_000, stepMs = 250) {
  const before = await host.servePids();
  await host.open();
  if (await until(() => host.running(), host, waitMs, stepMs)) return true;
  const alive = new Set(await host.servePids());
  const stuck = before.filter((pid) => alive.has(pid));
  if (stuck.length === 0) return false;
  for (const pid of stuck) host.kill(pid);
  await until(async () => (await host.servePids()).every((pid) => !stuck.includes(pid)), host, 3_000, stepMs);
  await host.open();
  return until(() => host.running(), host, waitMs, stepMs);
}
