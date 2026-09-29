import { describe, expect, it } from "@effect/vitest";

import { threadForSession } from "./RubatoSchedule.ts";

const cursor = (sessionId: string, serverId = "engine-1") => ({ kind: "rubato-pi", serverId, sessionId });

describe("threadForSession", () => {
  const bindings = [
    { threadId: "thread-codex", resumeCursor: { kind: "codex", sessionId: "s1" } },
    { threadId: "import:rubato:engine-1:s1", resumeCursor: cursor("s1") },
    { threadId: "composer-thread", resumeCursor: cursor("s2", "engine-2") },
    { threadId: "no-cursor" },
  ];

  it("finds the thread bound to the run's Rubato session", () => {
    expect(threadForSession(bindings, "s1", "engine-1")).toBe("import:rubato:engine-1:s1");
    // A thread started from T3's composer has its own id; the binding still finds it.
    expect(threadForSession(bindings, "s2", "engine-2")).toBe("composer-thread");
  });

  it("does not open another engine's session with the same id", () => {
    expect(threadForSession(bindings, "s2", "engine-1")).toBeNull();
  });

  it("matches any engine when the run does not name one", () => {
    expect(threadForSession(bindings, "s2", null)).toBe("composer-thread");
  });

  it("has no thread for a session T3 has not picked up yet", () => {
    expect(threadForSession(bindings, "s9", "engine-1")).toBeNull();
  });
});
