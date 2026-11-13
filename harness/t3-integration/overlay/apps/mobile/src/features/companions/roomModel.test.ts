import { describe, expect, it } from "vite-plus/test";

import type { CallRecord } from "./callStore";
import { callHeadline, companionIsWriting, roomItems, roomPreview, spokenText, type RoomMessageInput } from "./roomModel";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 13, 3, 0) + minutes * 60_000).toISOString();
const message = (id: string, role: RoomMessageInput["role"], text: string, minutes: number): RoomMessageInput => ({
  id, role, text, createdAt: at(minutes), streaming: false,
});
const call = (patch: Partial<CallRecord> & { minutes: number; length?: number }): CallRecord => {
  const createdAt = Date.parse(at(patch.minutes));
  return {
    id: `call-${patch.minutes}`, uuid: "00000000-0000-4000-8000-000000000000", companion: "roo", title: "Roo",
    direction: "outgoing", status: "ended", reason: null, createdAt, answeredAt: createdAt,
    endedAt: createdAt + (patch.length ?? 220_000), transcript: [], ...patch,
  };
};

describe("a companion room", () => {
  it("puts the person right and the companion left, grouping close messages from one side", () => {
    const items = roomItems([message("a", "user", "hi", 0), message("b", "user", "you there?", 1), message("c", "assistant", "yes!", 2)], []);
    const bubbles = items.filter((item) => item.kind === "bubble");
    expect(bubbles.map((item) => [item.side, item.groupStart, item.groupEnd])).toEqual([
      ["me", true, false], ["me", false, true], ["companion", true, true],
    ]);
    expect(items[0]?.kind).toBe("separator");
  });

  it("draws a call as one card where it started and keeps the person's call speech in it", () => {
    const card = call({ minutes: 10, transcript: [{ who: "me", text: "[voice] 요금제 바꿔줘", at: 0 }] });
    const items = roomItems(
      [message("a", "user", "전화할게", 9), message("v", "user", "[voice] 요금제 바꿔줘", 11), message("b", "assistant", "통화 끝!", 15),
        message("t", "user", "[voice] 텔레그램 음성", 120)],
      [card],
    );
    expect(items.filter((item) => item.kind !== "separator").map((item) => item.kind === "call" ? "call" : item.id)).toEqual(["a", "call", "b", "t"]);
    expect(items.find((item) => item.id === "t" && item.kind === "bubble")).toMatchObject({ text: "텔레그램 음성" });
  });

  it("shows the dots only while the companion owes an answer", () => {
    const asked = roomItems([message("a", "assistant", "hey", 0), message("b", "user", "what's up", 1)], []);
    expect(companionIsWriting(asked, true)).toBe(true);
    expect(companionIsWriting(asked, false)).toBe(false);
    expect(companionIsWriting(roomItems([message("a", "user", "hey", 0), message("b", "assistant", "hi", 1)], []), true)).toBe(false);
  });

  it("names how a call went and how long it ran", () => {
    expect(callHeadline(call({ minutes: 0, length: 220_000 }))).toEqual({ key: "voiceCall", length: "3:40" });
    expect(callHeadline(call({ minutes: 0, direction: "incoming", status: "missed", answeredAt: null }))).toEqual({ key: "missedCall", length: null });
    expect(callHeadline(call({ minutes: 0, status: "missed", answeredAt: null }))).toEqual({ key: "noAnswer", length: null });
    expect(callHeadline(call({ minutes: 0, status: "declined" })).key).toBe("declinedCall");
  });

  it("reads a transcript line without voice directions", () => {
    expect(spokenText("[laughing] 좋아 <whisper>비밀</whisper>")).toBe("좋아 비밀");
    expect(spokenText("말하는 중 [sig")).toBe("말하는 중");
  });

  it("previews the latest bubble or call for the list", () => {
    expect(roomPreview(roomItems([message("a", "assistant", "잘 자\n내일 봐", 0)], []))).toMatchObject({ text: "잘 자 내일 봐", side: "companion" });
    expect(roomPreview(roomItems([message("a", "user", "hi", 0)], [call({ minutes: 5, direction: "incoming", status: "missed" })])))
      .toMatchObject({ callKey: "missedCall" });
  });
});
