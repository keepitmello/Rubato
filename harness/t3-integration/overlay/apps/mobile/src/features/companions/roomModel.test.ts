import { describe, expect, it } from "vite-plus/test";
import { replyBubbleGapMs } from "@t3tools/shared/rubatoReplyBubbles";

import type { CallRecord } from "./callTypes";
import {
  callHeadline, callPreviewLines, companionTyping, feedRoomPreview, fileLines, roomItems, roomPreview, roomTool, separatorParts, spokenText, typedSoFar,
  type RoomMessageInput,
} from "./roomModel";

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
  it("previews the last two spoken lines without reading the rest of a long call", () => {
    let reads = 0;
    const transcript = Array.from({ length: 2000 }, (_, i) => ({
      who: "me" as const, at: i,
      get text() { reads++; return i === 1998 ? "[sigh]" : `line ${i}`; },
    }));
    expect(callPreviewLines(call({ minutes: 0, transcript })).map((line) => line.text))
      .toEqual(["line 1997", "line 1999"]);
    expect(reads).toBe(3);
  });
  it("keeps unchanged bubble rows across arrivals, but redraws a previous group tail", () => {
    const a = message("a", "user", "hi", 0);
    const b = message("b", "assistant", "one", 2);
    const c = message("c", "assistant", "two", 2.5);
    const first = roomItems([a, b], []);
    expect(typedSoFar(first, Date.now()).shown).toBe(first);
    const second = roomItems([a, b, c], []);
    expect(second.find((r) => r.id === "a")).toBe(first.find((r) => r.id === "a"));
    expect(second.find((r) => r.id === "b")).toMatchObject({ groupEnd: false });
    expect(first.find((r) => r.id === "b")).toMatchObject({ groupEnd: true });
  });
  it("previews the same last bubble without laying out the history (ties, files, reordered rows and blank replies)", () => {
    const rows = [
      message("a", "assistant", "First\n\nLast", 5),
      message("b", "user", "[log](</log>)", 5),
      message("old", "assistant", "Older", 2),
      message("blank", "assistant", " ", 8),
      message("system", "system", "hidden", 9),
    ];
    for (let i = 0; i <= rows.length; i++) {
      const messages = rows.slice(0, i);
      expect(feedRoomPreview(messages.map((message) => ({ type: "message", message }))))
        .toEqual(roomPreview(roomItems(messages, [])));
    }
  });
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

  it("ends a group with a tail after a pause of more than a minute, even on the same side", () => {
    const bubbles = roomItems([message("a", "assistant", "자냐~!!", 0), message("b", "assistant", "님아 꼭 해야됨", 2), message("c", "assistant", "야", 2.5)], [])
      .filter((item) => item.kind === "bubble");
    expect(bubbles.map((item) => [item.id, item.groupStart, item.groupEnd])).toEqual([["a", true, true], ["b", true, false], ["c", false, true]]);
  });

  it("puts a time line between bubbles a quarter of an hour apart", () => {
    const kinds = roomItems([message("a", "user", "hi", 0), message("b", "user", "hm", 14), message("c", "user", "?", 30)], [])
      .map((item) => item.kind === "separator" ? "time" : item.id);
    expect(kinds).toEqual(["time", "a", "b", "time", "c"]);
  });

  it("writes a time line as Messages does: today, yesterday, a weekday, then a date", () => {
    const now = new Date(2026, 10, 22, 15, 0).getTime();
    const ko = (date: Date) => separatorParts(date.getTime(), now, "ko-KR");
    expect(ko(new Date(2026, 10, 22, 14, 12))).toEqual({ day: "오늘", time: "오후 2:12" });
    expect(ko(new Date(2026, 10, 21, 21, 23)).day).toBe("어제");
    expect(ko(new Date(2026, 10, 19, 9, 0)).day).toBe("목요일");
    expect(ko(new Date(2026, 10, 7, 21, 23))).toEqual({ day: "11월 7일 (토)", time: "오후 9:23" });
    expect(ko(new Date(2025, 10, 7, 21, 23)).day).toBe("2025년 11월 7일 (금)");
    expect(separatorParts(new Date(2026, 10, 22, 14, 12).getTime(), now, "en-US")).toEqual({ day: "Today", time: "2:12 PM" });
  });

  it("shows the typing bubble the whole time the person's turn runs, answered or not, but not over a call", () => {
    const answered = roomItems([message("a", "user", "봐줘", 0), message("b", "assistant", "응 볼게", 1)], []);
    expect(companionTyping(answered, true)).toBe(true);
    expect(companionTyping(answered, false)).toBe(false);
    expect(companionTyping(roomItems([], [call({ minutes: 0, status: "active", endedAt: null })]), true)).toBe(false);
    expect([roomTool("terminal"), roomTool("mystery"), roomTool(null)]).toEqual(["terminal", "other", null]);
  });

  it("moves the tail to the newest bubble in sight while a reply comes in bubble by bubble", () => {
    const sent = Date.parse(at(0));
    const items = roomItems([message("r", "assistant", "응.\n\n저녁은?", 0)], []);
    const [only] = typedSoFar(items, sent).shown.filter((item) => item.kind === "bubble");
    expect(only).toMatchObject({ id: "r", groupEnd: true });
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

  it("keeps a message that carries only pictures or files, and splits the person's file lines from their words", () => {
    const picture = { ...message("p", "user", "", 0), attachments: [{ type: "image", id: "a1", name: "cat.png", mimeType: "image/png", sizeBytes: 3 }] } as RoomMessageInput;
    const sent = message("f", "user", "봐봐\n\n![shot.png](</Users/me/shot.png>)", 1);
    const [first, second] = roomItems([picture, sent], []).filter((item) => item.kind === "bubble");
    expect(first).toMatchObject({ text: "", attachments: [{ name: "cat.png" }] });
    expect(second).toMatchObject({ text: "봐봐", files: "![shot.png](</Users/me/shot.png>)" });
    expect(roomPreview(roomItems([picture], []))).toMatchObject({ text: "📎 cat.png" });
  });

  it("shows the companion's reply of several paragraphs as that many bubbles of one group, the files on the last", () => {
    const reply = message("r", "assistant", "응, 봤어.\n\n저녁은 먹었어?\n\n- 하나\n\n- 둘\n\n![a.png](</tmp/a.png>)", 0);
    const bubbles = roomItems([message("q", "user", "봤어?", 0), reply], []).filter((item) => item.kind === "bubble");
    expect(bubbles.map((item) => [item.id, item.text, item.files, item.part, item.groupStart, item.groupEnd])).toEqual([
      ["q", "봤어?", "", 0, true, true],
      ["r", "응, 봤어.", "", 0, true, false],
      ["r#1", "저녁은 먹었어?", "", 1, false, false],
      ["r#2", "- 하나\n\n- 둘", "![a.png](</tmp/a.png>)", 2, false, true],
    ]);
    expect(roomPreview(roomItems([reply], []))).toMatchObject({ text: "- 하나 - 둘", side: "companion" });

    // Said just now, its next bubbles come one after another; said a while ago, all at once.
    const sent = Date.parse(at(0));
    const items = roomItems([reply], []);
    const ids = (clock: number) => typedSoFar(items, clock).shown.filter((item) => item.kind === "bubble").map((item) => item.id);
    expect(ids(sent)).toEqual(["r"]);
    expect(typedSoFar(items, sent).next).toBe(sent + replyBubbleGapMs("저녁은 먹었어?"));
    expect(ids(sent + replyBubbleGapMs("저녁은 먹었어?"))).toEqual(["r", "r#1"]);
    expect(ids(sent + 60_000)).toEqual(["r", "r#1", "r#2"]);
    expect(typedSoFar(items, sent + 60_000).next).toBeNull();
    expect(roomItems([message("p", "user", "한 문단\n\n두 문단", 0)], []).filter((item) => item.kind === "bubble")).toHaveLength(1);
  });

  it("takes the companion's reply files out of its words, so the bubble draws them in its own layout", () => {
    const reply = message("r", "assistant", "캡처 두 장이야\n\n![fb-1.jpg](</tmp/fb-1.jpg>)\n\n![fb-2.jpg](</tmp/fb-2.jpg>)\n\n[notes.pdf](</tmp/notes.pdf>)", 0);
    const [bubble] = roomItems([reply], []).filter((item) => item.kind === "bubble");
    expect(bubble).toMatchObject({ text: "캡처 두 장이야" });
    expect(fileLines(bubble!.kind === "bubble" ? bubble!.files : "")).toEqual([
      { embed: true, name: "fb-1.jpg", path: "/tmp/fb-1.jpg" },
      { embed: true, name: "fb-2.jpg", path: "/tmp/fb-2.jpg" },
      { embed: false, name: "notes.pdf", path: "/tmp/notes.pdf" },
    ]);
    const onlyFiles = roomItems([message("o", "assistant", "![fb-1.jpg](</tmp/fb-1.jpg>)", 0)], []);
    expect(roomPreview(onlyFiles)).toMatchObject({ text: "📎 fb-1.jpg", side: "companion" });
  });

  it("draws what the person just sent before the conversation holds it, a picture alone too", () => {
    const photo = { id: "d1", type: "image", name: "cat.jpg", mimeType: "image/jpeg", sizeBytes: 3, uri: "file:///cat.jpg" };
    const sending = { ...message("s", "user", "", 1), pending: { attachments: [photo] } } as unknown as RoomMessageInput;
    const items = roomItems([message("a", "assistant", "hi", 0), sending], []);
    expect(items.filter((item) => item.kind === "bubble").map((item) => item.kind === "bubble" && [item.id, item.side, item.pending !== null]))
      .toEqual([["a", "companion", false], ["s", "me", true]]);
    expect(companionTyping(items, true)).toBe(true);
    expect(roomPreview(items)).toMatchObject({ text: "📎 cat.jpg", side: "me" });
  });

  it("previews the latest bubble or call for the list", () => {
    expect(roomPreview(roomItems([message("a", "assistant", "잘 자\n내일 봐", 0)], []))).toMatchObject({ text: "잘 자 내일 봐", side: "companion" });
    expect(roomPreview(roomItems([message("a", "user", "hi", 0)], [call({ minutes: 5, direction: "incoming", status: "missed" })])))
      .toMatchObject({ callKey: "missedCall" });
  });
});

describe("change cards in the room", () => {
  const proposal = (id: string, minutes: number, status: "open" | "applied" | "declined" | "superseded" = "open") => ({
    kind: "piece" as const, id, createdAt: Date.parse(at(minutes)), status, label: "말투", piece: "soul", before: "a", after: "b",
  });
  it("puts a card where it was proposed, and leaves out one a newer card replaced", () => {
    const items = roomItems(
      [message("a", "user", "더 짧게 해줘", 0), message("b", "assistant", "이렇게 고치면 어때?", 1), message("c", "assistant", "적용하면 바뀌어", 2)],
      [],
      Date.now(),
      [proposal("old", 1, "superseded"), proposal("new", 1)],
    );
    expect(items.filter((item) => item.kind !== "separator").map((item) => item.id)).toEqual(["a", "b", "proposal:new", "c"]);
    const after = items.find((item) => item.id === "c");
    expect(after).toMatchObject({ kind: "bubble", groupStart: true });
  });

  it("does not take a card for the list preview", () => {
    const items = roomItems([message("a", "assistant", "고쳐봤어", 0)], [], Date.now(), [proposal("p", 1)]);
    expect(roomPreview(items)?.text).toBe("고쳐봤어");
  });
});

