import { describe, expect, it } from "@effect/vitest";

import { forkTitle, piSessionOf } from "./RubatoThreadFork.ts";

describe("thread fork", () => {
  it("forks the Pi session a Rubato thread resumes, and nothing for another provider", () => {
    expect(piSessionOf({ kind: "rubato-pi", serverId: "engine-1", sessionId: "s1" })).toBe("s1");
    expect(piSessionOf({ kind: "codex", sessionId: "s1" })).toBeNull();
    expect(piSessionOf({ kind: "rubato-pi", sessionId: "" })).toBeNull();
    expect(piSessionOf(null)).toBeNull();
  });

  it("names the copy after the thread, within Pi's title limit", () => {
    expect(forkTitle("고용24 해커톤 상황 파악")).toBe("고용24 해커톤 상황 파악 (fork)");
    const long = forkTitle("x".repeat(600));
    expect(long).toHaveLength(512);
    expect(long.endsWith(" (fork)")).toBe(true);
  });
});
