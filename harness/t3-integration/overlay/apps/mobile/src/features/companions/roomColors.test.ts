import { describe, expect, it } from "vite-plus/test";

import { parseColor, rubatoFaintInk, SENT_CONTRAST, sentBubbleColor, toOklch, whiteContrast } from "./roomColors";

const linear = (hex: string) =>
  parseColor(hex)!.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

describe("the person's bubble color", () => {
  it("deepens a light accent until white words read, keeping its hue", () => {
    // Ocean's dark accent (oklch 0.79 0.105 200) as the phone's theme hands it over.
    const ocean = "#6dc9d3";
    const bubble = sentBubbleColor(ocean);
    expect(whiteContrast(linear(bubble))).toBeGreaterThanOrEqual(SENT_CONTRAST);
    // Not deeper than it needs: a step lighter would no longer read.
    expect(whiteContrast(linear(bubble))).toBeLessThan(SENT_CONTRAST + 0.4);
    expect(Math.abs(toOklch(parseColor(bubble)!)[2] - toOklch(parseColor(ocean)!)[2])).toBeLessThan(6);
  });

  it("keeps an accent that is already deep enough", () => {
    expect(sentBubbleColor("#1d4ed8")).toBe("#1d4ed8");
  });

  it("gives a monochrome theme a grey that white words read on", () => {
    const ink = sentBubbleColor("rgb(252, 251, 253)");
    expect(whiteContrast(linear(ink))).toBeGreaterThanOrEqual(SENT_CONTRAST);
    expect(toOklch(parseColor(ink)!)[1]).toBeLessThan(0.02);
  });

  it("reads the theme's color forms", () => {
    expect(parseColor("#fff")).toEqual([1, 1, 1]);
    expect(parseColor("rgba(255, 0, 0, 0.5)")).toEqual([1, 0, 0]);
    expect(parseColor("oklch(0.5 0.1 200)")).toBeNull();
  });
});

describe("the spoken-message underline", () => {
  it("is the ink at a faint alpha", () => {
    expect(rubatoFaintInk("#ffffff")).toBe("rgba(255, 255, 255, 0.18)");
    expect(rubatoFaintInk("rgb(10, 20, 30)", 0.1)).toBe("rgba(10, 20, 30, 0.1)");
    expect(rubatoFaintInk("not a color")).toBe("not a color");
  });
});
