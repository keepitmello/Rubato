import { describe, expect, it } from "vite-plus/test";
import { roomLeadEndStatus, roomLeadRows } from "./roomLeadsModel";

const lead = { id: "tool-1", at: 1, title: "A lead", sessionId: "lead", error: null, done: 2 };

describe("companion’s lead list", () => {
  it("opens empty and populated lists without toSorted, without changing the launch history", () => {
    const input = [lead, { ...lead, id: "new", sessionId: "new", at: 3 }];
    const empty: typeof input = [];
    for (const launches of [input, empty]) Object.defineProperty(launches, "toSorted", { value: undefined });
    expect(roomLeadRows(Object.freeze(empty))).toEqual([]);
    expect(roomLeadRows(Object.freeze(input)).map(({ id }) => id)).toEqual(["new", "tool-1"]);
    expect(input.map(({ id }) => id)).toEqual(["tool-1", "new"]);
  });

  it("shows newly starting and previously launched leads newest first, without duplicates or failed creations", () => {
    const pending = { ...lead, id: "pending", at: 8, sessionId: null, done: null };
    const failed = { ...pending, id: "failed", at: 9, error: "failed", done: 10 };
    expect(roomLeadRows([lead, pending, failed, { ...lead, id: "old", at: 0 }])).toEqual([pending, lead]);
  });

  it("distinguishes a stopped lead from a successful finish or a failure", () => {
    expect(["interrupted", "cancelled", "completed", "failed", "ongoing"].map(roomLeadEndStatus))
      .toEqual(["stopped", "stopped", "completed", "failed", null]);
  });
});
