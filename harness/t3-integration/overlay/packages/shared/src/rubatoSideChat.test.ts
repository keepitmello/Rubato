import { describe, expect, it } from "@effect/vitest";

import { addsSideChat, isSideChatThreadId, SIDE_CHAT_THREAD_PREFIX, withoutSideChats } from "./rubatoSideChat.ts";

const side = `${SIDE_CHAT_THREAD_PREFIX}0b6f0c1e-5b8e-4b8a-9c7e-1f2d3c4b5a69`;

describe("side chat threads", () => {
  it("are told apart by their prefix alone, so a wrong id never names a real thread", () => {
    expect(isSideChatThreadId(side)).toBe(true);
    expect(isSideChatThreadId(SIDE_CHAT_THREAD_PREFIX)).toBe(false);
    expect(isSideChatThreadId("import:rubato:engine:session")).toBe(false);
    expect(isSideChatThreadId("0b6f0c1e-5b8e-4b8a-9c7e-1f2d3c4b5a69")).toBe(false);
  });

  it("stay out of the thread list, from a snapshot and from an event", () => {
    const snapshot = { snapshotSequence: 3, threads: [{ id: "a" }, { id: side }, { id: "b" }] };
    expect(withoutSideChats(snapshot).threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    const plain = { snapshotSequence: 3, threads: [{ id: "a" }] };
    expect(withoutSideChats(plain)).toBe(plain);
    expect(addsSideChat({ kind: "thread-upserted", thread: { id: side } })).toBe(true);
    expect(addsSideChat({ kind: "thread-upserted", thread: { id: "a" } })).toBe(false);
    expect(addsSideChat({ kind: "thread-removed" })).toBe(false);
  });
});
