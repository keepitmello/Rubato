import { describe, expect, it } from "@effect/vitest";

import { sideChatTitle } from "./RubatoSideChat.ts";

describe("side chat", () => {
  it("names the side chat after the thread, within Pi's title limit", () => {
    expect(sideChatTitle("고용24 해커톤 상황 파악")).toBe("고용24 해커톤 상황 파악 (side chat)");
    const long = sideChatTitle("x".repeat(600));
    expect(long).toHaveLength(512);
    expect(long.endsWith(" (side chat)")).toBe(true);
  });
});
