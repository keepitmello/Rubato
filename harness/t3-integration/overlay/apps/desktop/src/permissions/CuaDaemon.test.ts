import { describe, expect, it } from "vite-plus/test";

import { type CuaDaemonHost, startCuaDaemon } from "./CuaDaemon.ts";

/**
 * macOS as the daemon sees it: `open -a` starts CuaDriver.app only when no instance runs, and
 * otherwise just reactivates the one that does. An instance answers once it has finished starting,
 * unless its socket was taken from it.
 */
function mac(instances: Array<{ pid: number; reachable: boolean; readyAfterMs?: number }>, startMs = 0) {
  let clock = 0;
  let nextPid = 9000;
  const procs = instances.map((p) => ({ ...p, readyAt: p.readyAfterMs ?? 0 }));
  const killed: number[] = [];
  let opens = 0;
  const host: CuaDaemonHost = {
    running: async () => procs.some((p) => p.reachable && clock >= p.readyAt),
    servePids: async () => procs.map((p) => p.pid),
    open: async () => {
      opens++;
      if (procs.length === 0) procs.push({ pid: nextPid++, reachable: true, readyAt: clock + startMs });
    },
    kill: (pid) => {
      killed.push(pid);
      procs.splice(procs.findIndex((p) => p.pid === pid), 1);
    },
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { host, killed, procs, opens: () => opens };
}

describe("starting the Cua Driver daemon", () => {
  it("launches it when nothing runs and kills nothing", async () => {
    const m = mac([]);
    expect(await startCuaDaemon(m.host)).toBe(true);
    expect(m.killed).toEqual([]);
  });

  it("replaces an instance that lost its socket, which open alone only reactivates", async () => {
    const m = mac([{ pid: 9935, reachable: false }]);
    expect(await startCuaDaemon(m.host)).toBe(true);
    expect(m.killed).toEqual([9935]);
    expect(m.procs.map((p) => p.pid)).not.toContain(9935);
    expect(m.opens()).toBe(2);
  });

  it("leaves a daemon it just launched alone while it is slow to start", async () => {
    const m = mac([], 30_000);
    expect(await startCuaDaemon(m.host)).toBe(false);
    expect(m.killed).toEqual([]);
  });

  it("leaves a running daemon alone", async () => {
    const m = mac([{ pid: 4242, reachable: true }]);
    expect(await startCuaDaemon(m.host)).toBe(true);
    expect(m.killed).toEqual([]);
  });
});
