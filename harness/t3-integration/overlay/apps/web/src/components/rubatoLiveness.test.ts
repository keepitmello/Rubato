import { describe, expect, it } from "vite-plus/test";

import { STALL_AFTER_MS, countLiveness, formatAgo, livenessOf, type LivenessFacts } from "./rubatoLiveness";

const NOW = Date.parse("2026-11-10T07:00:00.000Z");
const facts = (overrides: Partial<LivenessFacts>): LivenessFacts => ({
  lifecycle: "live",
  turnOpen: true,
  lastActivityAt: NOW,
  ...overrides,
});

describe("livenessOf", () => {
  it("works while its turn is open and it moved within the threshold", () => {
    expect(livenessOf(facts({ lastActivityAt: NOW - 12_000 }), NOW)).toBe("working");
    expect(livenessOf(facts({ lastActivityAt: NOW - STALL_AFTER_MS + 1 }), NOW)).toBe("working");
  });

  it("stalls once its open turn has been quiet for the threshold", () => {
    expect(livenessOf(facts({ lastActivityAt: NOW - STALL_AFTER_MS }), NOW)).toBe("stalled");
    expect(livenessOf(facts({ lastActivityAt: null }), NOW)).toBe("stalled");
  });

  it("never reads a lost or evicted agent as working, however fresh its last line", () => {
    expect(livenessOf(facts({ lifecycle: "lost", lastActivityAt: NOW }), NOW)).toBe("lost");
  });

  it("rests when its turn is closed, however long ago", () => {
    expect(livenessOf(facts({ turnOpen: false, lastActivityAt: NOW - 3 * STALL_AFTER_MS }), NOW)).toBe("resting");
  });

  it("keeps an ended run's ending", () => {
    expect(livenessOf(facts({ lifecycle: "ended" }), NOW)).toBe("done");
    expect(livenessOf(facts({ lifecycle: "failed" }), NOW)).toBe("failed");
    expect(livenessOf(facts({ lifecycle: "stopped" }), NOW)).toBe("stopped");
  });
});

describe("formatAgo", () => {
  it("counts seconds, then minutes, hours and days", () => {
    expect(formatAgo(NOW - 12_400, NOW)).toBe("12s ago");
    expect(formatAgo(NOW - 3 * 60_000 - 5_000, NOW)).toBe("3m ago");
    expect(formatAgo(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(formatAgo(NOW - 4 * 86_400_000, NOW)).toBe("4d ago");
    expect(formatAgo(NOW + 2_000, NOW)).toBe("0s ago");
    expect(formatAgo(null, NOW)).toBeNull();
  });
});

describe("countLiveness", () => {
  it("counts each state once", () => {
    expect(countLiveness(["working", "stalled", "resting", "resting", "lost", "done", "stopped"])).toEqual({
      working: 1,
      stalled: 1,
      resting: 2,
      lost: 1,
      ended: 2,
    });
  });
});
