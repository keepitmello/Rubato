import { describe, expect, it } from "@effect/vitest";

import { retainUserMessagesAfterRevert } from "./rubatoRevertRetention.ts";

let clock = 0;
const at = () => `2026-09-01T00:00:${String(clock++).padStart(2, "0")}.000Z`;
const user = (id: string) => ({ id, role: "user", turnId: null, createdAt: at() });
const reply = (id: string, turnId: string) => ({ id, role: "assistant", turnId, createdAt: at() });

describe("retainUserMessagesAfterRevert", () => {
  it("keeps a message steered into a kept turn", () => {
    const messages = [user("ask"), reply("a1", "t1"), user("steer"), reply("a1b", "t1"), user("next"), reply("a2", "t2")];
    const result = retainUserMessagesAfterRevert(messages, new Set(["t1"]));
    expect([...result.retained]).toEqual(["ask", "steer"]);
    expect(result.promptlessTurns).toBe(0);
  });

  it("drops the rewound prompt when a kept turn was woken without one", () => {
    const messages = [user("ask"), reply("a1", "t1"), reply("wake", "t2"), user("next"), reply("a3", "t3")];
    const result = retainUserMessagesAfterRevert(messages, new Set(["t1", "t2"]));
    expect([...result.retained]).toEqual(["ask"]);
    expect(result.decided.has("next")).toBe(true);
    expect(result.promptlessTurns).toBe(1);
  });

  it("leaves prompts without a following turn to the counting rule", () => {
    const messages = [user("ask"), reply("a1", "t1"), user("unanswered")];
    const result = retainUserMessagesAfterRevert(messages, new Set(["t1"]));
    expect([...result.retained]).toEqual(["ask"]);
    expect(result.decided.has("unanswered")).toBe(false);
  });
});
