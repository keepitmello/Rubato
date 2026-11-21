import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decodeCompanions, encodeCompanions, knownThreadId, type CompanionEntry } from "./companionModel";

const roo: CompanionEntry = {
  environmentId: "env-mac" as EnvironmentId,
  id: "roo",
  title: "루",
  macTitle: "Roo",
  sessionId: "session-1",
  threadId: "thread-1",
  art: "data:image/png;base64,AAAA",
  callable: { id: "roo", title: "Roo", ready: true },
  calls: true,
  callEffort: "low",
};

describe("the kept companion list", () => {
  it("opens the room on the kept thread, and never says a call can go through", () => {
    const [kept] = decodeCompanions(encodeCompanions([roo]));
    expect(kept).toEqual({ ...roo, callable: null });
  });

  it("reads nothing from a missing or broken copy", () => {
    expect(decodeCompanions(null)).toEqual([]);
    expect(decodeCompanions("{not json")).toEqual([]);
    expect(decodeCompanions(JSON.stringify({ companions: [] }))).toEqual([]);
  });

  it("drops entries that do not name their Mac and companion, and fills the rest", () => {
    const stored = JSON.stringify([
      { id: "segno" },
      { environmentId: "env-mac" },
      null,
      { environmentId: "env-mac", id: "segno", threadId: "", callEffort: "loud" },
    ]);
    expect(decodeCompanions(stored)).toEqual([{
      environmentId: "env-mac", id: "segno", title: "segno", macTitle: "segno", sessionId: null, threadId: null,
      art: null, callable: null, calls: false, callEffort: "medium",
    }]);
  });
});

describe("the room's thread when the Mac does not say", () => {
  it("keeps the thread it knew for the same conversation", () => {
    expect(knownThreadId([roo], "env-mac", "roo", "session-1")).toBe("thread-1");
  });

  it("knows none for a new conversation, another Mac or another companion", () => {
    expect(knownThreadId([roo], "env-mac", "roo", "session-2")).toBeNull();
    expect(knownThreadId([roo], "env-other", "roo", "session-1")).toBeNull();
    expect(knownThreadId([roo], "env-mac", "segno", "session-1")).toBeNull();
    expect(knownThreadId([], "env-mac", "roo", "session-1")).toBeNull();
  });
});
