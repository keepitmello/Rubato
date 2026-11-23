import { describe, expect, it } from "vite-plus/test";
import { roomLeadEndStatus, roomWorkSessions, roomWorkThreads } from "./roomLeadsModel";

const launch = { id: "tool", at: 1, title: "Work", sessionId: "created", error: null, done: 2 };
const thread = (sessionId: string, patch: Partial<typeof base> = {}) =>
  ({ ...base, id: `import:rubato:mac:${sessionId}`, ...patch });
const base = {
  id: "", environmentId: "mac", archivedAt: null as string | null, deletedAt: null as string | null,
  settledOverride: null as "settled" | "active" | null, updatedAt: "2026-11-23T10:00:00Z", rank: 2,
};

describe("companion’s current work", () => {
  it("uses only successful launches for attribution, not to invent placeholder rows", () => {
    const sessions = roomWorkSessions([
      launch, launch, { ...launch, sessionId: "pending", error: "Failed" }, { ...launch, sessionId: null, done: null },
    ]);
    expect([...sessions]).toEqual(["created"]);
    expect(roomWorkThreads([], "mac", sessions, (x: typeof base) => x.rank)).toEqual([]);
  });

  it("hides historical, archived, deleted and settled work and never crosses Macs", () => {
    const names = ["archived", "deleted", "settled", "wrong-mac", "resting", "working", "answer", "snoozed"];
    const history = [...names, ...Array.from({ length: 400 }, (_, i) => `old-${i}`)]
      .map((sessionId) => ({ ...launch, sessionId }));
    const work = [
      thread("archived", { archivedAt: base.updatedAt }),
      thread("deleted", { deletedAt: base.updatedAt }),
      thread("settled", { settledOverride: "settled" }),
      thread("wrong-mac", { environmentId: "other" }),
      thread("unrelated"),
      thread("resting"),
      thread("working", { rank: 1 }),
      thread("answer", { rank: 0 }),
      thread("snoozed", { updatedAt: "2026-11-23T11:00:00Z" }),
    ];
    const ranked: string[] = [];
    const result = roomWorkThreads(Object.freeze(work), "mac", roomWorkSessions(history), (item) => {
      ranked.push(item.id);
      return item.rank;
    });
    expect(result).toEqual([work[7], work[6], work[8], work[5]]);
    expect(ranked).toHaveLength(4);
  });

  it("distinguishes a stopped lead from a successful finish or a failure", () => {
    expect(["interrupted", "cancelled", "completed", "failed", "ongoing"].map(roomLeadEndStatus))
      .toEqual(["stopped", "stopped", "completed", "failed", null]);
  });
});
