import { describe, expect, it } from "vite-plus/test";

import type { SegnoLead, SegnoPanel } from "../../state/rubatoCompanion";
import { NIGHT_HOURS, stageStateOf } from "./RubatoSegnoSpace";

const lead = (state: SegnoLead["state"]): SegnoLead => ({
  sessionId: `s-${state}`,
  title: state,
  cwd: "/work/app",
  state,
  since: 0,
});
const held = { id: "m1", text: "draft", createdAt: "2026-10-20T10:00:00Z", to: null };
const panel = (parts: Partial<SegnoPanel> = {}): SegnoPanel => ({
  leads: [],
  finished: [],
  held: [],
  ...parts,
});
const at = (hour: number) => new Date(2026, 9, 20, hour, 30);

describe("stageStateOf", () => {
  it("rests by day with nothing to follow", () => {
    expect(stageStateOf(panel(), at(14))).toBe("idle");
  });

  it("sleeps in the quiet hours with nothing running", () => {
    expect(stageStateOf(panel(), at(NIGHT_HOURS.from))).toBe("night");
    expect(stageStateOf(panel(), at(NIGHT_HOURS.to - 1))).toBe("night");
    expect(stageStateOf(panel(), at(NIGHT_HOURS.to))).toBe("idle");
    expect(stageStateOf(panel(), at(0))).toBe("idle");
  });

  it("works while a followed lead runs, at night too", () => {
    expect(stageStateOf(panel({ leads: [lead("running")] }), at(14))).toBe("working");
    expect(stageStateOf(panel({ leads: [lead("running")] }), at(3))).toBe("working");
    expect(stageStateOf(panel({ leads: [lead("queued")] }), at(14))).toBe("idle");
  });

  it("waits for the person when a reply is held or a lead asked, over everything else", () => {
    expect(stageStateOf(panel({ held: [held], leads: [lead("running")] }), at(14))).toBe(
      "waiting",
    );
    expect(stageStateOf(panel({ leads: [lead("running"), lead("asked")] }), at(3))).toBe(
      "waiting",
    );
  });
});
