import { describe, expect, it } from "vite-plus/test";

import { sideChatIsEmpty, sideChatSourceReady } from "./rubatoSideChat";

describe("Side chat", () => {
  it("is offered for a Rubato thread that has run, and not before", () => {
    const thread = (latestRun: unknown, latestUserMessageAt: string | null) => ({
      environmentId: "env" as never,
      providerInstanceId: "rubato",
      latestRun,
      latestUserMessageAt,
    });
    expect(sideChatSourceReady(thread({ runId: "r" }, null), true)).toBe(true);
    // A thread imported from the engine has messages but no run yet.
    expect(sideChatSourceReady(thread(null, "2026-10-16T00:00:00.000Z"), true)).toBe(true);
    expect(sideChatSourceReady(thread(null, null), true)).toBe(false);
    expect(sideChatSourceReady(thread({ runId: "r" }, null), false)).toBe(false);
    expect(sideChatSourceReady(null, true)).toBe(false);
  });

  it("is deleted on leaving only when nothing was asked, and kept when it is not loaded", () => {
    expect(sideChatIsEmpty({ messages: [] })).toBe(true);
    expect(sideChatIsEmpty({ messages: [{ id: "m" }] })).toBe(false);
    expect(sideChatIsEmpty(null)).toBe(false);
  });
});
