import { describe, expect, it } from "vite-plus/test";

import { composerFieldHeight, liveWordsSegments, NATIVE_MEASURED_LINES } from "./composerFieldLayout";

const LINE = 22;
const INSET = 8.5;
const field = (lines: number, maxLines = 6) =>
  composerFieldHeight({
    contentHeight: Math.min(lines, NATIVE_MEASURED_LINES) * LINE,
    lineHeight: LINE,
    inset: INSET,
    minLines: 1,
    maxLines,
  });

describe("composerFieldHeight", () => {
  it("is one line and its insets when empty", () => {
    expect(composerFieldHeight({ contentHeight: 0, lineHeight: LINE, inset: INSET, minLines: 1, maxLines: 6 }))
      .toEqual({ height: LINE + 2 * INSET, overflows: false });
  });

  it("adds the insets back to the native height, so every line shows", () => {
    expect(field(3).height).toBe(3 * LINE + 2 * INSET);
    expect(field(3).overflows).toBe(false);
  });

  it("stops at the four lines the native editor reports and offers the full-screen editor there", () => {
    expect(field(4)).toEqual({ height: 4 * LINE + 2 * INSET, overflows: true });
    expect(field(9)).toEqual({ height: 4 * LINE + 2 * INSET, overflows: true });
  });

  it("overflows past a smaller maximum as soon as the text is taller", () => {
    expect(field(2, 2).overflows).toBe(false);
    expect(field(3, 2)).toEqual({ height: 2 * LINE + 2 * INSET, overflows: true });
  });
});

describe("liveWordsSegments", () => {
  it("keeps the draft before the heard words and tints only the moving ones", () => {
    const value = "앞의 글 새 말";
    expect(liveWordsSegments(value, [{ start: 5, end: 6, visible: 0.5, blue: 1 }])).toEqual([
      { text: "앞의 글 ", tint: null },
      { text: "새", tint: { visible: 0.5, blue: 1 } },
      { text: " 말", tint: null },
    ]);
  });

  it("is the whole value in grey without runs, and nothing for an empty value", () => {
    expect(liveWordsSegments("draft", [])).toEqual([{ text: "draft", tint: null }]);
    expect(liveWordsSegments("", [])).toEqual([]);
  });

  it("clamps runs to the value and never repeats a character", () => {
    const segments = liveWordsSegments("abc", [
      { start: 2, end: 9, visible: 1, blue: 1 },
      { start: 1, end: 3, visible: 1, blue: 0.5 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe("abc");
  });
});
