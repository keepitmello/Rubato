import { describe, expect, it } from "vite-plus/test";

import { sideChatIsEmpty, sideChatSourceReady } from "./rubatoSideChat";

describe("Side chat", () => {
  it("is offered for a Rubato thread that has run, and not before", () => {
    expect(sideChatSourceReady({ latestTurn: { turnId: "t" }, messages: [] }, true)).toBe(true);
    // A thread imported from the engine has messages but no T3 turn yet.
    expect(sideChatSourceReady({ latestTurn: null, messages: [{ id: "m" }] }, true)).toBe(true);
    expect(sideChatSourceReady({ latestTurn: null, messages: [] }, true)).toBe(false);
    expect(sideChatSourceReady({ latestTurn: { turnId: "t" }, messages: [] }, false)).toBe(false);
    expect(sideChatSourceReady(null, true)).toBe(false);
  });

  it("is deleted on leaving only when nothing was asked, and kept when it is not loaded", () => {
    expect(sideChatIsEmpty({ messages: [] })).toBe(true);
    expect(sideChatIsEmpty({ messages: [{ id: "m" }] })).toBe(false);
    expect(sideChatIsEmpty(null)).toBe(false);
  });
});
