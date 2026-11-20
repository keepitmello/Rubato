import { LIVE_FADE_IN_MS, LIVE_HOLD_MS, LIVE_SETTLE_MS } from "@t3tools/shared/rubatoLiveDictation";
import { describe, expect, it } from "vite-plus/test";

import { liveDictationDisplay } from "./rubatoLiveDictationDisplay.ts";

const at = (text: string, time: number | null) => ({ text, at: time });

describe("liveDictationDisplay", () => {
  it("puts the heard words after the caret's text with a space, the caret after them", () => {
    const draft = "아, 아, 음성 전사 테스트.";
    const display = liveDictationDisplay(draft, { start: draft.length, end: draft.length },
      [at(" 실시간", 0), at(" 받아쓰기", 900)], 1_000);
    expect(display.value).toBe("아, 아, 음성 전사 테스트. 실시간 받아쓰기");
    expect(display.value.slice(display.heard.start, display.heard.end)).toBe("실시간 받아쓰기");
    expect(display.selection).toEqual({ start: display.value.length, end: display.value.length });
  });

  it("gives each word its own clock: fading in, blue, then fading to grey", () => {
    const now = 10_000;
    const display = liveDictationDisplay("", { start: 0, end: 0 },
      [at("오래된", now - LIVE_SETTLE_MS - 1), at(" 바래는", now - LIVE_HOLD_MS - 200), at(" 파란", now - 300),
        at(" 새", now - LIVE_FADE_IN_MS / 2)], now);
    expect(display.value).toBe("오래된 바래는 파란 새");
    const word = (start: number) => display.runs.find((run) => run.start <= start && start < run.end);
    expect(word(0)).toBeUndefined();
    expect(word(4)!.blue).toBeGreaterThan(0);
    expect(word(4)!.blue).toBeLessThan(1);
    expect(word(8)).toMatchObject({ blue: 1, visible: 1 });
    expect(word(11)!.visible).toBeLessThan(1);
    expect(display.animating).toBe(true);
    expect(liveDictationDisplay("", { start: 0, end: 0 }, [at("끝", now - LIVE_SETTLE_MS)], now).animating).toBe(false);
  });

  it("keeps a Korean word apart from the Korean word before it", () => {
    expect(liveDictationDisplay("입력창", { start: 3, end: 3 }, [at("고칠게", 0)], 0).value).toBe("입력창 고칠게");
  });

  it("writes into the middle of a draft at the caret and leaves the rest after it", () => {
    const display = liveDictationDisplay("앞 뒤", { start: 1, end: 1 }, [at("가운데", null)], 0);
    expect(display.value).toBe("앞 가운데 뒤");
    expect(display.selection.start).toBe(5);
    expect(display.runs).toEqual([]);
  });

  it("before any word arrives, shows the draft as it is", () => {
    const display = liveDictationDisplay("draft", { start: 5, end: 5 }, [], 0);
    expect(display.value).toBe("draft");
    expect(display.heard).toEqual({ start: 5, end: 5 });
  });
});
