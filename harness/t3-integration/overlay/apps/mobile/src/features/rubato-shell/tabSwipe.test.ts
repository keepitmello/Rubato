import { describe, expect, it } from "vite-plus/test";

import { TAB_SWIPE, tabSwipeFollow, tabSwipeNeighbors, tabSwipeStep } from "./tabSwipe";

describe("tabSwipeNeighbors", () => {
  it("puts Threads after Companions, as the tab bar does", () => {
    expect(tabSwipeNeighbors("companions")).toEqual({ previous: null, next: "threads" });
    expect(tabSwipeNeighbors("threads")).toEqual({ previous: "companions", next: null });
  });

  it("gives a tab the bar does not show no neighbours", () => {
    expect(tabSwipeNeighbors("pullRequests")).toEqual({ previous: null, next: null });
  });
});

describe("tabSwipeStep", () => {
  const far = TAB_SWIPE.commitDistance;

  it("moves to the next tab when the finger travels left far enough", () => {
    expect(tabSwipeStep(-far, 0, false, true)).toBe(1);
    expect(tabSwipeStep(-(far - 1), 0, false, true)).toBe(0);
  });

  it("moves to the previous tab when the finger travels right far enough", () => {
    expect(tabSwipeStep(far, 0, true, false)).toBe(-1);
  });

  it("takes a short fast flick", () => {
    expect(tabSwipeStep(-20, -TAB_SWIPE.commitVelocity, false, true)).toBe(1);
    expect(tabSwipeStep(20, TAB_SWIPE.commitVelocity, true, false)).toBe(-1);
  });

  it("stays when there is no tab that way", () => {
    expect(tabSwipeStep(far * 2, 2_000, false, true)).toBe(0);
    expect(tabSwipeStep(-far * 2, -2_000, true, false)).toBe(0);
    expect(tabSwipeStep(0, 0, true, true)).toBe(0);
  });

  it("stays when a long drag is flung back", () => {
    expect(tabSwipeStep(-far * 2, TAB_SWIPE.commitVelocity, false, true)).toBe(0);
  });
});

describe("tabSwipeFollow", () => {
  it("leans toward a tab that exists, damped and capped", () => {
    expect(tabSwipeFollow(-50, false, true)).toBeCloseTo(-50 * TAB_SWIPE.followRatio);
    expect(tabSwipeFollow(-1_000, false, true)).toBe(-TAB_SWIPE.followMax);
    expect(tabSwipeFollow(1_000, true, false)).toBe(TAB_SWIPE.followMax);
  });

  it("does not lean toward the edge", () => {
    expect(tabSwipeFollow(50, false, true)).toBe(0);
    expect(tabSwipeFollow(-50, true, false)).toBe(0);
  });
});
