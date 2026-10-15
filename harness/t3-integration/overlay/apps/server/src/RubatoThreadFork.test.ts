import { describe, expect, it } from "@effect/vitest";

import { forkPointOf, forkTitle, piSessionOf } from "./RubatoThreadFork.ts";

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

  it("forks at the Pi message a reply names, and refuses a reply Pi did not write", () => {
    expect(
      forkPointOf("assistant:pi:01a13e73-6910-77b7-ae3b-5237c1cb0e9c:90309b6127bde2e0aca503ca"),
    ).toBe("90309b6127bde2e0aca503ca");
    expect(forkPointOf("import:codex:01a0946a-e5b6-7e71-8ef3-2da627249b08:000001")).toBeNull();
    expect(forkPointOf("assistant:turn-1")).toBeNull();
  });
});
