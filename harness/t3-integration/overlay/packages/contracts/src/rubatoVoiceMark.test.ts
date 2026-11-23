import { describe, expect, it } from "@effect/vitest";

import { RUBATO_VOICE_MARK, rubatoVoiceDisplay, withMessageSenderNote } from "./orchestrationV2.ts";

const person = { createdBy: "user", creationSource: "web" } as const;

describe("the voice mark", () => {
  it("reaches the model as [voice] and nothing else changes", () => {
    expect(withMessageSenderNote(person, `${RUBATO_VOICE_MARK}재시작 고쳐 줘`)).toBe("[voice] 재시작 고쳐 줘");
    expect(withMessageSenderNote(person, "typed")).toBe("typed");
  });

  it("is drawn as the words alone, spoken, for a dictation, a call or Telegram", () => {
    expect(rubatoVoiceDisplay(`${RUBATO_VOICE_MARK}hello`)).toEqual({ text: "hello", voiced: true });
    expect(rubatoVoiceDisplay("[voice] 텔레그램 음성")).toEqual({ text: "텔레그램 음성", voiced: true });
    expect(rubatoVoiceDisplay("typed [voice] later")).toEqual({ text: "typed [voice] later", voiced: false });
  });
});
