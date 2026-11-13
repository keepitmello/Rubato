import { describe, expect, it } from "vite-plus/test";

import type { CallRecord } from "../../state/rubatoCall";
import { callHeadline, callLength, callPlacement, spokenText, withoutCallSpeech } from "./rubatoCallRoom";
import type { SegnoChatItem, SegnoChatMessageInput } from "./rubatoSegnoRoom";

const at = (iso: string) => Date.parse(iso);
const call = (patch: Partial<CallRecord>): CallRecord => ({
  id: "call-1", companion: "roo", direction: "outgoing", status: "ended", reason: null,
  createdAt: at("2026-11-13T02:00:00Z"), answeredAt: at("2026-11-13T02:00:00Z"), endedAt: at("2026-11-13T02:04:12Z"),
  transcript: [], ...patch,
});
const message = (id: string, text: string, createdAt: string, role: "user" | "assistant" = "user"): SegnoChatMessageInput =>
  ({ id, role, text, createdAt, streaming: false });
const bubble = (id: string, iso: string): SegnoChatItem => ({ kind: "bubble", id, side: "me", text: "", at: at(iso), streaming: false,
  images: [], attachmentNames: [], files: "", groupStart: true, groupEnd: true });

describe("a companion room's calls", () => {
  it("moves the person's call speech into the card and keeps a Telegram voice message outside any call", () => {
    const messages = [
      message("a", "[voice] 루야 들려?", "2026-11-13T02:00:03Z"),
      message("b", "오늘 뭐 했어?", "2026-11-13T02:01:00Z"),
      message("c", "[voice] 텔레그램 음성", "2026-11-13T03:00:00Z"),
    ];
    expect(withoutCallSpeech(messages, [call({})]).map((item) => item.id)).toEqual(["b", "c"]);
    expect(withoutCallSpeech(messages, [call({ status: "missed", answeredAt: null })]).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("stands each call before the first bubble after it started, and the rest at the end", () => {
    const items = [bubble("x", "2026-11-13T01:59:00Z"), bubble("y", "2026-11-13T02:10:00Z")];
    const early = call({ id: "early" });
    const late = call({ id: "late", createdAt: at("2026-11-13T02:20:00Z") });
    const placed = callPlacement(items, [late, early]);
    expect(placed.before.get("y")?.map((item) => item.id)).toEqual(["early"]);
    expect(placed.tail.map((item) => item.id)).toEqual(["late"]);
  });

  it("names a call by how it went", () => {
    expect(callHeadline(call({}))).toEqual({ title: "Voice call", length: "4:12" });
    expect(callHeadline(call({ status: "missed", direction: "incoming", answeredAt: null }))).toEqual({ title: "Missed call", length: null });
    expect(callHeadline(call({ status: "missed", direction: "outgoing", answeredAt: null })).title).toBe("No answer");
    expect(callHeadline(call({ status: "declined" })).title).toBe("Declined call");
    expect(callLength(3_725_000)).toBe("1:02:05");
  });

  it("reads a transcript line without the voice's directions", () => {
    expect(spokenText("[반가워서 웃음이 터지며] 응, 들려! <whisper>비밀</whisper>")).toBe("응, 들려! 비밀");
  });
});
