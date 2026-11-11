import { describe, expect, it } from "vite-plus/test";

import {
  arrivals,
  GROUP_GAP_MS,
  personText,
  previewText,
  splitFileLines,
  SEPARATOR_GAP_MS,
  segnoChatItems,
  segnoDays,
  segnoDaysThrough,
  segnoDrawStart,
  segnoIsWriting,
  segnoSpans,
  segnoTurnMarks,
  spanCounts,
  spanDuration,
  wakeCounts,
  type SegnoChatMessageInput,
} from "./rubatoSegnoRoom";

const base = new Date(2026, 9, 21, 9, 0, 0).getTime();
const message = (
  id: string,
  role: SegnoChatMessageInput["role"],
  offsetMs: number,
  text = id,
): SegnoChatMessageInput => ({
  id,
  role,
  text,
  createdAt: new Date(base + offsetMs).toISOString(),
  streaming: false,
});

const bubbles = (items: ReturnType<typeof segnoChatItems>) =>
  items.flatMap((item) =>
    item.kind === "bubble"
      ? [`${item.side}:${item.id}:${item.groupStart ? "start" : ""}${item.groupEnd ? "end" : ""}`]
      : [`time:${item.id}`],
  );

describe("Segno's chat room", () => {
  it("places restored Telegram history by its original time, not its append order", () => {
    const items = segnoChatItems([message("new", "assistant", 30_000), message("old", "user", 0)]);
    expect(items.filter(item => item.kind === "bubble").map(item => item.id)).toEqual(["old", "new"]);
  });
  it("puts the person on the right and Segno on the left, one time line at the top", () => {
    const items = segnoChatItems([message("a", "user", 0), message("b", "assistant", 30_000)]);
    expect(bubbles(items)).toEqual(["time:separator:a", "me:a:startend", "segno:b:startend"]);
  });

  it("groups one side's messages close together; only the last carries the tail", () => {
    const items = segnoChatItems([
      message("a", "assistant", 0),
      message("b", "assistant", 20_000),
      message("c", "assistant", 40_000),
      message("d", "user", 60_000),
    ]);
    expect(bubbles(items)).toEqual([
      "time:separator:a",
      "segno:a:start",
      "segno:b:",
      "segno:c:end",
      "me:d:startend",
    ]);
  });

  it("starts a new group after a pause, and a time line after a long gap", () => {
    const items = segnoChatItems([
      message("a", "user", 0),
      message("b", "user", GROUP_GAP_MS + 1),
      message("c", "user", GROUP_GAP_MS + 1 + SEPARATOR_GAP_MS),
    ]);
    expect(bubbles(items)).toEqual([
      "time:separator:a",
      "me:a:startend",
      "me:b:startend",
      "time:separator:c",
      "me:c:startend",
    ]);
  });

  it("leaves out system lines and empty messages", () => {
    const items = segnoChatItems([message("a", "system", 0), message("b", "assistant", 1_000, "  "), message("c", "user", 2_000)]);
    expect(bubbles(items)).toEqual(["time:separator:c", "me:c:startend"]);
  });

  it("shows Segno writing only while its turn runs and the person waits for an answer", () => {
    const asked = segnoChatItems([message("a", "assistant", 0), message("b", "user", 10_000)]);
    const answered = segnoChatItems([message("a", "user", 0), message("b", "assistant", 10_000)]);
    expect(segnoIsWriting(asked, true)).toBe(true);
    expect(segnoIsWriting(asked, false)).toBe(false);
    expect(segnoIsWriting(answered, true)).toBe(false);
    expect(segnoIsWriting([], true)).toBe(false);
  });

  it("draws the latest days that have messages, and cuts them by day", () => {
    const day = 24 * 60 * 60_000;
    // Four days with messages, and a quiet week between the first and the rest.
    const items = segnoChatItems([
      message("d0", "user", -10 * day),
      message("d1a", "user", -2 * day),
      message("d1b", "assistant", -2 * day + 60_000),
      message("d2", "user", -day),
      message("d3a", "user", 0),
      message("d3b", "assistant", 60_000),
    ]);
    const start = segnoDrawStart(items, 3);
    expect(items[start]).toMatchObject({ kind: "separator", id: "separator:d1a" });
    expect(segnoDrawStart(items, 4)).toBe(0);
    expect(segnoDrawStart(items, 9)).toBe(0);
    expect(segnoDays(items, start).map((range) => items.slice(range.from, range.to).filter((item) => item.kind === "bubble").map((item) => item.id))).toEqual([
      ["d1a", "d1b"],
      ["d2"],
      ["d3a", "d3b"],
    ]);
    const first = items.findIndex((item) => item.id === "d0");
    expect(segnoDaysThrough(items, first)).toBe(4);
    expect(segnoDrawStart(items, segnoDaysThrough(items, first))).toBeLessThanOrEqual(first);
  });

  it("springs in only bubbles newer than what the room knew; earlier history loads in still", () => {
    const known = { ids: new Set(["b", "c"]), latest: 200 };
    expect(arrivals([{ id: "a", at: 100 }, { id: "b", at: 150 }, { id: "c", at: 200 }], known)).toEqual([]);
    expect(arrivals([{ id: "a", at: 100 }, { id: "c", at: 200 }, { id: "d", at: 260 }], known)).toEqual(["d"]);
    expect(arrivals([{ id: "d", at: 260 }, { id: "e", at: 260 }], known)).toEqual(["e"]);
  });
});

describe("the person's pictures", () => {
  const image = { type: "image", id: "img-1", name: "image.png", mimeType: "image/png", sizeBytes: 10 } as const;
  const file = { type: "file", id: "file-1", name: "notes.pdf", mimeType: "application/pdf", sizeBytes: 10 } as const;

  it("drops the picture's context link from the words and keeps other links as their label", () => {
    expect(personText("이거 봐 ![image.png](t3-context://v1/image/image_275a022f)")).toBe("이거 봐");
    expect(personText("[notes.pdf](t3-context://v1/file/file_1) 읽어 줘")).toBe("notes.pdf 읽어 줘");
  });

  it("draws pictures in the bubble and lists only the other files by name", () => {
    const [bubble] = segnoChatItems([
      { id: "m1", role: "user", text: "![image.png](t3-context://v1/image/image_1)", createdAt: "2026-10-21T10:00:00Z", streaming: false, attachments: [image, file] },
    ]).filter((item) => item.kind === "bubble");
    expect(bubble).toMatchObject({ text: "", images: [image], attachmentNames: ["notes.pdf"] });
  });
});

describe("files that came by path", () => {
  it("takes the person's messenger files out of the words and keeps them to draw", () => {
    const [bubble] = segnoChatItems([
      { id: "t1", role: "user", text: "이거 봐\n\n![1-a.jpg](</home/received/1-a.jpg>)\n\n[b.pdf](</home/received/b.pdf>)", createdAt: "2026-10-21T10:00:00Z", streaming: false },
    ]).filter((item) => item.kind === "bubble");
    expect(bubble).toMatchObject({
      text: "이거 봐",
      files: "![1-a.jpg](</home/received/1-a.jpg>)\n\n[b.pdf](</home/received/b.pdf>)",
    });
  });

  it("leaves the person's own words alone, links and blank lines included", () => {
    const words = "봐 [이거](</tmp/x.png>) 어때\n\n\n둘째 줄";
    expect(splitFileLines(words)).toEqual({ words, files: "" });
  });

  it("keeps the companion's file lines in its words, for its markdown to draw", () => {
    const text = "만들었어\n\n![shot.png](</out/shot.png>)";
    const [bubble] = segnoChatItems([
      { id: "s1", role: "assistant", text, createdAt: "2026-10-21T10:00:00Z", streaming: false },
    ]).filter((item) => item.kind === "bubble");
    expect(bubble).toMatchObject({ text, files: "" });
  });

  it("reads a file line as its name in a preview", () => {
    expect(previewText("만들었어\n\n![shot.png](</out/shot.png>)\n\n[page.html](</out/page.html>)")).toBe(
      "만들었어\n\nshot.png\n\npage.html",
    );
  });
});

describe("the room's timeline at its left edge", () => {
  it("marks each turn at the person's first bubble, with the companion's answer before the person speaks again", () => {
    const items = segnoChatItems([
      message("hello", "assistant", 0, "좋은 아침"),
      message("ask", "user", 60_000, "폴라리스 빼고"),
      message("more", "user", 70_000, "나머지만 세션 띄워"),
      message("ok", "assistant", 120_000, "고쳤어"),
      message("done", "assistant", 130_000, "네 개 띄웠어"),
      message("next", "user", 200_000, "고마워"),
    ]);
    const marks = segnoTurnMarks(items);
    expect(marks.map((mark) => [mark.id, mark.userText, mark.assistantText])).toEqual([
      ["ask", "폴라리스 빼고\n나머지만 세션 띄워", "고쳤어\n네 개 띄웠어"],
      ["next", "고마워", null],
    ]);
    expect(items[marks[0]!.rowIndex]).toMatchObject({ kind: "bubble", id: "ask" });
  });

  it("names a turn of only pictures and files by their names", () => {
    const image = { type: "image", id: "img-1", name: "image.png", mimeType: "image/png", sizeBytes: 10 } as const;
    const items = segnoChatItems([
      { id: "pic", role: "user", text: "![image.png](t3-context://v1/image/image_1)", createdAt: "2026-10-21T10:00:00Z", streaming: false, attachments: [image] },
    ]);
    expect(segnoTurnMarks(items)).toMatchObject([{ id: "pic", userText: "image.png", assistantText: null }]);
  });
});

describe("the work between bubbles (user f8828a9f)", () => {
  const items = segnoChatItems([message("a", "user", 0), message("b", "assistant", 60_000), message("c", "user", 120_000)]);
  const at = (offset: number) => base + offset;

  it("puts the work behind a reply above it, work that led to no reply on its own line, and what runs now last", () => {
    const spans = segnoSpans(items, { writing: false, partial: false });
    expect(spans.boundaries).toEqual([at(0), at(60_000), at(120_000)]);
    expect(spans.after).toBeUndefined();
    expect(spans.before.get("a")).toEqual({ index: 0, after: null, until: at(0), placement: "quiet" });
    expect(spans.before.get("b")).toEqual({ index: 1, after: at(0), until: at(60_000), placement: "attached" });
    expect(spans.before.get("c")).toEqual({ index: 2, after: at(60_000), until: at(120_000), placement: "quiet" });
    expect(spans.tail).toEqual({ index: 3, after: at(120_000), until: null, placement: "quiet" });
    expect(segnoSpans(items, { writing: true, partial: false }).tail.placement).toBe("live");
  });

  it("does not read the whole conversation before the first loaded bubble while earlier history is not loaded", () => {
    const spans = segnoSpans(items, { writing: false, partial: true });
    expect(spans.after).toBe(at(0));
    expect(spans.before.get("a")?.after).toBe(at(0));
  });

  it("names each kind of wake by its own name; only a heartbeat is called one (user ffaeed47)", () => {
    expect(wakeCounts({ wakes: 4, wakeKinds: { inbox: 1, heartbeat: 2, call: 1 } })).toEqual([
      { label: "Work room", count: 1 },
      { label: "Heartbeat", count: 2 },
      { label: "Voice call", count: 1 },
    ]);
    expect(wakeCounts({ wakes: 2, wakeKinds: { wake: 1, someday: 1 } })).toEqual([
      { label: "Started again", count: 1 },
      { label: "Other", count: 1 },
    ]);
    expect(wakeCounts({ wakes: 1 })).toEqual([{ label: "Other", count: 1 }]);
    expect(wakeCounts({ wakes: 0, wakeKinds: {} })).toEqual([]);
  });

  it("names the counts one phrase each, and the time in the room's language", () => {
    expect(spanCounts({ thinking: 1, text: 1, tools: 1, messages: 0 })).toEqual(["2 thoughts", "1 tool"]);
    expect(spanCounts({ thinking: 0, text: 0, tools: 0, messages: 1 })).toEqual(["1 message"]);
    expect(spanDuration(41_000, "en-US")).toBe("41s");
    expect(spanDuration(200, "en-US")).toBe("1s");
    expect(spanDuration(3 * 60_000, "en-US")).toBe("3m");
    expect(spanDuration(80 * 60_000, "en-US")).toBe("1h 20m");
    expect(spanDuration(41_000, "ko-KR")).toBe("41초");
  });
});
