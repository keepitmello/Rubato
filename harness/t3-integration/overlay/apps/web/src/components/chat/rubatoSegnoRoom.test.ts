import { describe, expect, it } from "vite-plus/test";

import {
  arrivals,
  GROUP_GAP_MS,
  personText,
  SEPARATOR_GAP_MS,
  segnoChatItems,
  segnoIsWriting,
  segnoSpans,
  separatorLabel,
  spanCounts,
  spanDuration,
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

  it("writes the time line as a time today, yesterday with a time, or a date", () => {
    const now = base + 5 * 60 * 60_000;
    expect(separatorLabel(base, now, "en-US")).toBe("9:00 AM");
    expect(separatorLabel(base - 24 * 60 * 60_000, now, "en-US")).toBe("yesterday 9:00 AM");
    expect(separatorLabel(base - 3 * 24 * 60 * 60_000, now, "en-US")).toBe("Sun, October 18 9:00 AM");
    expect(separatorLabel(base - 24 * 60 * 60_000, now, "ko-KR")).toBe("어제 오전 9:00");
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

  it("names the counts one phrase each, and the time in the room's language", () => {
    expect(spanCounts({ thinking: 1, text: 1, tools: 1, wakes: 2, messages: 0 })).toEqual(["2 wakes", "2 thoughts", "1 tool"]);
    expect(spanCounts({ thinking: 0, text: 0, tools: 0, wakes: 0, messages: 1 })).toEqual(["1 message"]);
    expect(spanDuration(41_000, "en-US")).toBe("41s");
    expect(spanDuration(200, "en-US")).toBe("1s");
    expect(spanDuration(3 * 60_000, "en-US")).toBe("3m");
    expect(spanDuration(80 * 60_000, "en-US")).toBe("1h 20m");
    expect(spanDuration(41_000, "ko-KR")).toBe("41초");
  });
});
