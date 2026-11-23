import { describe, expect, it } from "vite-plus/test";
import { roomLeadEndStatus, roomLeadRows } from "./roomLeadsModel";

const lead = { id: "tool-1", at: 1, title: "A lead", sessionId: "lead", error: null, done: 2 };

describe("companion’s lead list", () => {
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
