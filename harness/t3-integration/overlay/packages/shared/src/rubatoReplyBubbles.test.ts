// The same cases as harness/companion/test/reply-bubbles.test.mjs: the app and Telegram break a
// reply at the same places.
import { describe, expect, it } from "vite-plus/test";

import { REPLY_BUBBLES_MAX, replyBubbleGapMs, replyBubbles } from "./rubatoReplyBubbles.ts";

describe("replyBubbles", () => {
  it("makes each paragraph its own bubble; one paragraph stays one, nothing is none", () => {
    expect(replyBubbles("응, 봤어.\n\n저녁은 먹었어?\r\n\r\n나는 아까 라면.")).toEqual(["응, 봤어.", "저녁은 먹었어?", "나는 아까 라면."]);
    expect(replyBubbles("한 줄\n바로 다음 줄")).toEqual(["한 줄\n바로 다음 줄"]);
    expect(replyBubbles("  혼자  ")).toEqual(["혼자"]);
    expect(replyBubbles("")).toEqual([]);
  });

  it("keeps a code block, a spread-out list, a lead-in, a heading and an indented line with their bubble", () => {
    expect(replyBubbles("이렇게 고치면 돼\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n됐지?")).toEqual([
      "이렇게 고치면 돼",
      "```js\nconst a = 1;\n\nconst b = 2;\n```",
      "됐지?",
    ]);
    expect(replyBubbles("오늘 할 거:\n\n- 장보기\n\n- 빨래\n\n1. 하나\n\n2. 둘\n\n끝!")).toEqual([
      "오늘 할 거:\n\n- 장보기\n\n- 빨래\n\n1. 하나\n\n2. 둘",
      "끝!",
    ]);
    expect(replyBubbles("## 오늘\n\n맑음\n\n내일은 비")).toEqual(["## 오늘\n\n맑음", "내일은 비"]);
    expect(replyBubbles("- 항목\n\n  이어지는 설명\n\n다음 얘기")).toEqual(["- 항목\n\n  이어지는 설명", "다음 얘기"]);
    expect(replyBubbles("```\n열린 채로\n\n끝남")).toEqual(["```\n열린 채로\n\n끝남"]);
  });

  it("lets file lines ride with the last words", () => {
    expect(replyBubbles("사진 봐\n\n예쁘지?\n\n![a.png](</tmp/a.png>)\n\n[b.pdf](</tmp/b.pdf>)")).toEqual([
      "사진 봐",
      "예쁘지?\n\n![a.png](</tmp/a.png>)\n\n[b.pdf](</tmp/b.pdf>)",
    ]);
  });

  it("joins what is past the cap into the last bubble", () => {
    const many = Array.from({ length: REPLY_BUBBLES_MAX + 3 }, (_, index) => `p${index}`);
    const bubbles = replyBubbles(many.join("\n\n"));
    expect(bubbles).toHaveLength(REPLY_BUBBLES_MAX);
    expect(bubbles.slice(0, -1)).toEqual(many.slice(0, REPLY_BUBBLES_MAX - 1));
    expect(bubbles.at(-1)).toBe(many.slice(REPLY_BUBBLES_MAX - 1).join("\n\n"));
  });

  it("pauses longer for more words, never long", () => {
    expect(replyBubbleGapMs("응")).toBeLessThan(replyBubbleGapMs("조금 더 긴 말풍선 하나"));
    expect(replyBubbleGapMs("x".repeat(5000))).toBe(2200);
  });
});
