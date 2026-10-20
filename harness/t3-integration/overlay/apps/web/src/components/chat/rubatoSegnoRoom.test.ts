import { describe, expect, it } from "vite-plus/test";

import {
  GROUP_GAP_MS,
  SEPARATOR_GAP_MS,
  segnoChatItems,
  segnoIsWriting,
  separatorLabel,
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
});
