import { describe, expect, it } from "@effect/vitest";

import { keptAfterRevertCut, retainUserMessagesAfterRevert } from "./rubatoRevertRetention.ts";

let clock = 0;
const at = () => `2026-09-01T00:00:${String(clock++).padStart(2, "0")}.000Z`;
const user = (id: string) => ({ id, role: "user", turnId: null, createdAt: at() });
const reply = (id: string, turnId: string) => ({ id, role: "assistant", turnId, createdAt: at() });

describe("retainUserMessagesAfterRevert", () => {
  it("keeps a message steered into a kept turn", () => {
    const messages = [
      user("ask"),
      reply("a1", "t1"),
      user("steer"),
      reply("a1b", "t1"),
      user("next"),
      reply("a2", "t2"),
    ];
    const result = retainUserMessagesAfterRevert(messages, new Set(["t1"]));
    expect([...result.retained]).toEqual(["ask", "steer"]);
    expect(result.promptlessTurns).toBe(0);
  });

  it("drops the rewound prompt when a kept turn was woken without one", () => {
    const messages = [
      user("ask"),
      reply("a1", "t1"),
      reply("wake", "t2"),
      user("next"),
      reply("a3", "t3"),
    ];
    const result = retainUserMessagesAfterRevert(messages, new Set(["t1", "t2"]));
    expect([...result.retained]).toEqual(["ask"]);
    expect(result.decided.has("next")).toBe(true);
    expect(result.promptlessTurns).toBe(1);
  });

  it("keeps a steer stamped the same millisecond as the reply after it", () => {
    const ask = user("ask");
    const first = reply("a1", "t1");
    const steer = { id: "zzz-steer", role: "user", turnId: null, createdAt: at() };
    const answer = {
      id: "aaa-answer",
      role: "assistant",
      turnId: "t1",
      createdAt: steer.createdAt,
    };
    const result = retainUserMessagesAfterRevert(
      [ask, first, answer, steer, user("next"), reply("a2", "t2")],
      new Set(["t1"]),
    );
    expect([...result.retained]).toEqual(["ask", "zzz-steer"]);
  });

  it("leaves prompts without a following turn to the counting rule", () => {
    const messages = [user("ask"), reply("a1", "t1"), user("unanswered")];
    const result = retainUserMessagesAfterRevert(messages, new Set(["t1"]));
    expect([...result.retained]).toEqual(["ask"]);
    expect(result.decided.has("unanswered")).toBe(false);
  });
});

describe("keptAfterRevertCut", () => {
  const row = (id: string, turnId: string | null, second: number, role?: string) => ({
    id,
    turnId,
    createdAt: `2026-09-02T00:00:${String(second).padStart(2, "0")}.000Z`,
    ...(role ? { role } : {}),
  });

  it("drops the cut turn's rows after the step and a message steered in after it", () => {
    const rows = [
      row("ask", null, 1, "user"),
      row("read", "t1", 2),
      row("test", "t1", 3),
      row("steer", null, 4, "user"),
      row("edit", "t1", 5),
      row("notice", null, 6),
    ];
    const kept = keptAfterRevertCut(rows, { turnId: "t1", after: "2026-09-02T00:00:03.000Z" });
    expect(kept.map((entry) => entry.id)).toEqual(["ask", "read", "test", "notice"]);
  });

  it("keeps every row when the rewind has no step", () => {
    const rows = [row("a", "t1", 1), row("b", "t2", 2)];
    expect(keptAfterRevertCut(rows, undefined)).toBe(rows);
  });
});
