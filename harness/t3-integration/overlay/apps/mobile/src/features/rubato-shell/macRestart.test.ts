import { describe, expect, it } from "vite-plus/test";

import { describeMacRestart, macRestartLine, type MacRestartStatus } from "./macRestart";

const idle: MacRestartStatus = { busy: false, job: null, result: null, log: "/mac/update.log" };

describe("describeMacRestart", () => {
  it("follows one restart from rebuilding through the Mac's absence to its result", () => {
    expect(describeMacRestart(null, idle)).toEqual({ phase: "idle" });
    expect(describeMacRestart("t1", { ...idle, busy: true, job: { token: "t1", stage: "building", now: false } })).toEqual({ phase: "building" });
    expect(describeMacRestart("t1", null)).toEqual({ phase: "reconnecting" });
    expect(describeMacRestart("t1", { ...idle, result: { token: "t1", kind: "restart", status: "succeeded", message: null } })).toEqual({ phase: "succeeded" });
  });

  it("offers restarting now only while running work holds it", () => {
    expect(describeMacRestart("t1", { ...idle, busy: true, job: { token: "t1", stage: "draining", now: false } })).toEqual({ phase: "draining", now: false });
  });

  it("says where to look when it failed, and ignores another job's result", () => {
    const failed = describeMacRestart("t1", { ...idle, result: { token: "t1", kind: "restart", status: "failed", message: "build broke" } });
    expect(macRestartLine(failed)).toBe("The restart failed: build broke. The Mac's log is at /mac/update.log.");
    expect(describeMacRestart("t1", { ...idle, result: { token: "old", kind: "update", status: "failed", message: "x" } })).toEqual({ phase: "building" });
  });
});
