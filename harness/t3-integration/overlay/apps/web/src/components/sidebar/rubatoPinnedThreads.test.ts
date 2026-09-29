import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pinMenuItems, pinnedThreadsFirst } from "./rubatoPinnedThreads";

const env = "env-1" as EnvironmentId;
const thread = (id: string, over: { pinnedAt?: string | null; pinOrderKey?: string | null } = {}) => ({
  id,
  environmentId: env,
  createdAt: "2026-09-01T00:00:00.000Z",
  pinnedAt: null,
  pinOrderKey: null,
  ...over,
});

describe("the legacy sidebar's pinned threads", () => {
  it("puts pinned threads first in pin order and keeps the rest in the given order", () => {
    const ordered = pinnedThreadsFirst([
      thread("recent"),
      thread("pinned-second", { pinnedAt: "2026-09-02T00:00:00.000Z", pinOrderKey: "b" }),
      thread("older"),
      thread("pinned-first", { pinnedAt: "2026-09-03T00:00:00.000Z", pinOrderKey: "a" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["pinned-first", "pinned-second", "recent", "older"]);
  });

  it("leaves a list without pins as it was", () => {
    const ordered = pinnedThreadsFirst([thread("b"), thread("a"), thread("c")]);
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });

  it("offers Pin for an unpinned thread and Unpin for a pinned one", () => {
    const supported = () => true;
    expect(pinMenuItems(thread("t"), supported).map((item) => item.id)).toEqual(["pin"]);
    expect(
      pinMenuItems(thread("t", { pinnedAt: "2026-09-02T00:00:00.000Z" }), supported).map((item) => item.id),
    ).toEqual(["unpin"]);
  });

  it("offers nothing when the thread's server cannot pin", () => {
    expect(pinMenuItems(thread("t"), () => false)).toEqual([]);
  });
});
