import { expect, it } from "vite-plus/test";
import { buildThreadFeed, createThreadFeedCache, type LocalThreadMessage } from "./threadActivity";
import { MessageId } from "@t3tools/contracts";

it("reuses an unchanged feed without dropping new rows, a locale switch or an optimistic send", () => {
  const cache = createThreadFeedCache();
  const rows = Object.freeze([]);
  const options = { cache, locale: "ko" };
  const first = buildThreadFeed(rows, options);
  expect(buildThreadFeed(rows, options)).toBe(first);
  expect(buildThreadFeed(rows, { ...options, locale: "en" })).not.toBe(first);
  const message: LocalThreadMessage = {
    id: MessageId.make("pending"), role: "user", text: "hi", createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-20T10:00:00Z", streaming: false,
  };
  const pending = buildThreadFeed(rows, { ...options, anchoredMessages: [message] });
  expect(pending).toHaveLength(1);
  expect(buildThreadFeed(rows, options)).toEqual([]);
});
