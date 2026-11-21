import { describe, expect, it } from "vite-plus/test";

import {
  acceptableAvatar,
  AVATAR_MAX_BYTES,
  avatarSide,
  companionDraft,
  companionLine,
  companionListLine,
  cropSquare,
  dataUrlBytes,
  endsInConsonant,
  initialCrop,
  onboardingChips,
  panCrop,
  proposalPlacement,
  shownProposals,
  sinceLine,
  wordDiff,
  zoomCrop,
} from "./rubatoCompanionModel";

const side = (parts: ReturnType<typeof wordDiff>, kind: "removed" | "added") =>
  parts.filter((part) => part.kind === "same" || part.kind === kind).map((part) => part.text).join("");

describe("wordDiff", () => {
  it("strikes the words that went and marks the words that came, keeping the rest plain", () => {
    const before = "내 말은 한국어 반말이고 짧아. 보통 한두 줄, 길어도 서너 줄. 대답은 \"웅\"이고";
    const after = "내 말은 한국어 반말이고 짧아. 보통 한 줄, 길어도 두 줄. 대답은 \"웅\"이고";
    const parts = wordDiff(before, after);
    expect(parts).toEqual([
      { kind: "same", text: "내 말은 한국어 반말이고 짧아. 보통 " },
      { kind: "removed", text: "한두" },
      { kind: "added", text: "한" },
      { kind: "same", text: " 줄, 길어도 " },
      { kind: "removed", text: "서너" },
      { kind: "added", text: "두" },
      { kind: "same", text: " 줄. 대답은 \"웅\"이고" },
    ]);
    expect(side(parts, "removed")).toBe(before);
    expect(side(parts, "added")).toBe(after);
  });

  it("joins a run of changed words over the spaces between them", () => {
    const parts = wordDiff("keep one two three end", "keep four five end");
    expect(parts).toEqual([
      { kind: "same", text: "keep " },
      { kind: "removed", text: "one two three" },
      { kind: "added", text: "four five" },
      { kind: "same", text: " end" },
    ]);
  });

  it("reads back to both texts for additions, removals and line breaks", () => {
    for (const [before, after] of [
      ["", "brand new"],
      ["all gone", ""],
      ["a\nb c\n\nd", "a\nb x c\n\nd e"],
      ["same", "same"],
    ] as const) {
      const parts = wordDiff(before, after);
      expect(side(parts, "removed")).toBe(before);
      expect(side(parts, "added")).toBe(after);
    }
    expect(wordDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });
});

describe("the round crop", () => {
  it("starts on the largest square: centered, or at the top of a standing figure", () => {
    expect(cropSquare(1600, 900, initialCrop(1600, 900))).toEqual({ sx: 350, sy: 0, size: 900 });
    expect(cropSquare(804, 1100, initialCrop(804, 1100))).toEqual({ sx: 0, sy: 0, size: 804 });
    expect(cropSquare(1000, 1100, initialCrop(1000, 1100))).toEqual({ sx: 0, sy: 50, size: 1000 });
  });

  it("follows a drag in the picture's own pixels and never leaves the picture", () => {
    const start = initialCrop(2000, 1000);
    // A 250 px preview shows 1000 source px: 4 source px per screen px; dragging right shows what was left.
    const moved = panCrop(2000, 1000, start, 50, 0, 250);
    expect(cropSquare(2000, 1000, moved)).toEqual({ sx: 300, sy: 0, size: 1000 });
    const far = panCrop(2000, 1000, start, 10_000, 10_000, 250);
    expect(cropSquare(2000, 1000, far)).toEqual({ sx: 0, sy: 0, size: 1000 });
  });

  it("zooms around the same center within its bounds", () => {
    const zoomed = zoomCrop(1000, 1000, initialCrop(1000, 1000), 2);
    expect(cropSquare(1000, 1000, zoomed)).toEqual({ sx: 250, sy: 250, size: 500 });
    expect(cropSquare(1000, 1000, zoomCrop(1000, 1000, zoomed, 99)).size).toBe(250);
    expect(cropSquare(1000, 1000, zoomCrop(1000, 1000, zoomed, 0.1)).size).toBe(1000);
  });

  it("stores at most 1024 px and never upscales", () => {
    expect(avatarSide(4000)).toBe(1024);
    expect(avatarSide(512.4)).toBe(512);
    expect(avatarSide(0)).toBe(1);
  });

  it("takes only jpeg, png and webp data URLs within 2 MB decoded", () => {
    const base64 = (bytes: number) => btoa("x".repeat(bytes));
    expect(dataUrlBytes(`data:image/png;base64,${base64(10)}`)).toBe(10);
    expect(dataUrlBytes(`data:image/png;base64,${base64(11)}`)).toBe(11);
    expect(acceptableAvatar(`data:image/webp;base64,${base64(AVATAR_MAX_BYTES)}`)).toBe(true);
    expect(acceptableAvatar(`data:image/webp;base64,${base64(AVATAR_MAX_BYTES + 1)}`)).toBe(false);
    expect(acceptableAvatar(`data:image/gif;base64,${base64(10)}`)).toBe(false);
  });
});

describe("the list line", () => {
  const on = { settings: { enabled: true }, threadId: "t" };
  it("says off, starting, getting to know you, or on with its connection", () => {
    expect(companionListLine({ ...on, settings: { enabled: false } })).toEqual(["Off"]);
    expect(companionListLine({ ...on, threadId: null })).toEqual(["Starting"]);
    expect(companionListLine({ ...on, onboarding: { items: [] } })).toEqual(["Getting to know you"]);
    expect(companionListLine({ ...on, telegram: true })).toEqual(["On", "Telegram"]);
    expect(companionListLine(on)).toEqual(["On"]);
  });
});

describe("onboarding chips", () => {
  it("shows every topic in order, the first four required, set and deferred as the engine says", () => {
    const chips = onboardingChips({ items: [
      { key: "look", state: "deferred" },
      { key: "name", state: "set", value: "미루" },
      { key: "callsUser", state: "open" },
    ] });
    expect(chips.map((chip) => [chip.key, chip.state, chip.required])).toEqual([
      ["name", "set", true],
      ["callsUser", "open", true],
      ["work", "open", true],
      ["relationship", "open", true],
      ["look", "deferred", false],
      ["speech", "open", false],
      ["closeness", "open", false],
    ]);
    expect(chips[0]).toMatchObject({ label: "Name", value: "미루" });
    expect(onboardingChips(null)).toEqual([]);
  });
});

describe("proposal cards in the room", () => {
  const card = (id: string, createdAt: number, status: "open" | "superseded" | "applied" = "open") => ({ id, createdAt, status });
  it("stands each card before the first bubble after it, the rest at the end", () => {
    const bubbles = [{ id: "a", at: 10 }, { id: "b", at: 20 }];
    const { before, tail } = proposalPlacement(bubbles, [card("late", 25), card("p2", 15), card("p1", 5), card("p3", 12)]);
    expect(before.get("a")?.map((p) => p.id)).toEqual(["p1"]);
    expect(before.get("b")?.map((p) => p.id)).toEqual(["p3", "p2"]);
    expect(tail.map((p) => p.id)).toEqual(["late"]);
  });

  it("leaves replaced cards and cards from before the drawn days out", () => {
    const shown = shownProposals([card("old", 1), card("gone", 50, "superseded"), card("done", 60, "applied")], 10);
    expect(shown.map((p) => p.id)).toEqual(["done"]);
  });
});

describe("drafts", () => {
  it("names the card in the interface's language and leaves room to go on", () => {
    expect(companionDraft("who", "ko")).toBe("너 소개 카드 말인데, ");
    expect(companionDraft("me", "en")).toMatch(/what you know about me: $/);
  });
});

describe("lines with the name in them", () => {
  it("takes the Korean particle the name's last sound wants", () => {
    expect(endsInConsonant("세뇨")).toBe(false);
    expect(endsInConsonant("미룬")).toBe(true);
    expect(endsInConsonant("Roo")).toBe(false);
    expect(companionLine("who-title", "세뇨", "ko")).toBe("세뇨는 이런 애야");
    expect(companionLine("who-title", "미룬", "ko")).toBe("미룬은 이런 애야");
    expect(companionLine("me-title", "세뇨", "ko")).toBe("세뇨가 아는 나");
    expect(companionLine("me-title", "미룬", "ko")).toBe("미룬이 아는 나");
    expect(companionLine("calls-user", "오빠", "ko")).toBe("나를 오빠라고 불러");
    expect(companionLine("calls-user", "형님", "ko")).toBe("나를 형님이라고 불러");
    expect(companionLine("calls-user", "boss", "en")).toBe("Calls you boss");
  });

  it("says since when, with the year only for another year", () => {
    const now = new Date("2026-11-22T12:00:00");
    expect(sinceLine("2026-10-20", "ko", now)).toBe("10월 20일부터 함께");
    expect(sinceLine("2026-10-20", "en", now)).toBe("Together since October 20");
    expect(sinceLine("2025-10-20", "en", now)).toBe("Together since October 20, 2025");
    expect(sinceLine(null, "en", now)).toBeNull();
    expect(sinceLine("someday", "en", now)).toBeNull();
  });
});
