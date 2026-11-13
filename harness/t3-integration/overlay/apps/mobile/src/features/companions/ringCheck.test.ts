import { describe, expect, it } from "vite-plus/test";

import { ringCheck, type LiveAnswer } from "./ringCheck";

const ringing = { id: "c1", status: "ringing" as const };

describe("a ring on the phone's call screen", () => {
  it("keeps ringing while no Mac can be reached, however often it asks", () => {
    const down: LiveAnswer[] = [{ environmentId: "mac", failed: true }];
    for (let poll = 0; poll < 5; poll += 1) expect(ringCheck("c1", undefined, down)).toEqual({ kind: "unknown" });
    expect(ringCheck("c1", "mac", down)).toEqual({ kind: "unknown" });
    expect(ringCheck("c1", undefined, [])).toEqual({ kind: "unknown" });
  });

  it("stops when the Mac says another device took it, or that it is no longer live", () => {
    expect(ringCheck("c1", undefined, [{ environmentId: "mac", live: [{ id: "c1", status: "active" }] }])).toEqual({ kind: "taken", environmentId: "mac" });
    expect(ringCheck("c1", "mac", [{ environmentId: "mac", live: [] }])).toEqual({ kind: "gone", environmentId: "mac" });
    expect(ringCheck("c1", undefined, [{ environmentId: "mac", live: [ringing] }])).toEqual({ kind: "ringing", environmentId: "mac" });
  });

  it("does not let another Mac's answer end a ring whose own Mac is unreachable", () => {
    const answers: LiveAnswer[] = [{ environmentId: "home", failed: true }, { environmentId: "work", live: [] }];
    expect(ringCheck("c1", undefined, answers)).toEqual({ kind: "unknown" });
    expect(ringCheck("c1", "home", answers)).toEqual({ kind: "unknown" });
    expect(ringCheck("c1", "work", answers)).toEqual({ kind: "gone", environmentId: "work" });
  });
});
