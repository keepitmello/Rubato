import { describe, expect, it } from "vite-plus/test";

import { liveDictationDisplay } from "./rubatoLiveDictationDisplay.ts";

describe("liveDictationDisplay", () => {
  it("puts the heard words after the caret's text with a space, the new ones painted blue", () => {
    const draft = "아, 아, 음성 전사 테스트.";
    const display = liveDictationDisplay(draft, { start: draft.length, end: draft.length }, {
      settled: " 실시간",
      fresh: " 받아쓰기",
    });
    expect(display.value).toBe("아, 아, 음성 전사 테스트. 실시간 받아쓰기");
    expect(display.value.slice(display.dictation.freshStart, display.dictation.end)).toBe(" 받아쓰기");
    expect(display.selection).toEqual({ start: display.value.length, end: display.value.length });
  });

  it("keeps a Korean word apart from the Korean word before it", () => {
    const display = liveDictationDisplay("입력창", { start: 3, end: 3 }, { settled: "", fresh: "고칠게" });
    expect(display.value).toBe("입력창 고칠게");
  });

  it("writes into the middle of a draft at the caret and leaves the rest after it", () => {
    const display = liveDictationDisplay("앞 뒤", { start: 1, end: 1 }, { settled: "가운데", fresh: "" });
    expect(display.value).toBe("앞 가운데 뒤");
    expect(display.selection.start).toBe(5);
    expect(display.dictation.freshStart).toBe(display.dictation.end);
  });

  it("before any word arrives, shows the draft as it is, all grey", () => {
    const display = liveDictationDisplay("draft", { start: 5, end: 5 }, { settled: "", fresh: "" });
    expect(display.value).toBe("draft");
    expect(display.dictation).toEqual({ freshStart: 5, end: 5 });
  });
});
