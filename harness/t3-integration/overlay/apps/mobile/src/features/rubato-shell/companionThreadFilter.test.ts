import { describe, expect, it } from "vite-plus/test";

import { withoutThreads } from "./companionThreadFilter";

describe("withoutThreads", () => {
  const threads = [
    { environmentId: "mac", id: "segno-room" },
    { environmentId: "mac", id: "work" },
    { environmentId: "other-mac", id: "segno-room" },
  ];

  it("leaves a companion's room out of the thread list on its own Mac only", () => {
    expect(withoutThreads(threads, [{ environmentId: "mac", threadId: "segno-room" }])).toEqual([
      { environmentId: "mac", id: "work" },
      { environmentId: "other-mac", id: "segno-room" },
    ]);
  });

  it("hides nothing while a companion has no thread yet", () => {
    expect(withoutThreads(threads, [{ environmentId: "mac", threadId: null }])).toBe(threads);
    expect(withoutThreads(threads, [])).toBe(threads);
  });
});
