import { describe, expect, it } from "@effect/vitest";

import { sideChatsOf, sideChatsToSweep, sideChatTitle } from "./RubatoSideChat.ts";

describe("side chat", () => {
  it("names the side chat after the thread, within Pi's title limit", () => {
    expect(sideChatTitle("고용24 해커톤 상황 파악")).toBe("고용24 해커톤 상황 파악 (side chat)");
    const long = sideChatTitle("x".repeat(600));
    expect(long).toHaveLength(512);
    expect(long.endsWith(" (side chat)")).toBe(true);
  });

  const sessions = [
    { sessionId: "side-old", createdAt: 1, sideChatOf: "parent" },
    { sessionId: "side-new", createdAt: 2, sideChatOf: "parent" },
    { sessionId: "side-unmade", createdAt: 3, sideChatOf: "parent" },
    { sessionId: "side-other", createdAt: 4, sideChatOf: "other-parent" },
    { sessionId: "side-orphan", createdAt: 5, sideChatOf: "deleted-parent" },
  ];
  const threads = new Map([
    ["parent", ["thread-parent"]],
    ["other-parent", ["thread-other"]],
    ["side-old", ["side-chat:old"]],
    ["side-new", ["side-chat:new"]],
    ["side-other", ["side-chat:other"]],
    ["side-orphan", ["side-chat:orphan"]],
  ]);

  it("lists a thread's own side chats that have a thread, newest first", () => {
    expect(sideChatsOf("parent", sessions, threads).map((entry) => entry.threadId)).toEqual([
      "side-chat:new",
      "side-chat:old",
    ]);
  });

  it("sweeps the side chats whose source thread is gone, and only those", () => {
    expect(sideChatsToSweep(sessions, threads)).toEqual([{ sessionId: "side-orphan", threadIds: ["side-chat:orphan"] }]);
    // A side chat thread bound to the source session does not keep its siblings alive.
    const onlySide = new Map([["parent", ["side-chat:stray"]]]);
    expect(sideChatsToSweep(sessions.slice(0, 1), onlySide)).toEqual([{ sessionId: "side-old", threadIds: [] }]);
  });
});
