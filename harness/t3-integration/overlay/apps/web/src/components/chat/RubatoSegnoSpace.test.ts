import { describe, expect, it } from "vite-plus/test";

import { createUiTranslator, type UiDictionary } from "../../rubatoI18n";
import korean from "../../rubatoI18n.ko.json";
import type { SegnoFinished, SegnoLead, SegnoPanel } from "../../state/rubatoCompanion";
import {
  NIGHT_HOURS,
  elapsed,
  endingKey,
  endingStatus,
  leadStatus,
  leadsInOrder,
  stageStateOf,
} from "./RubatoSegnoSpace";

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

const MIN = 60_000;
const ending = (outcome: SegnoFinished["outcome"], at: number): SegnoFinished => ({
  sessionId: `s-${outcome}`,
  title: outcome,
  cwd: "/work/app",
  outcome,
  at,
});
const ko = createUiTranslator(korean as unknown as UiDictionary);

describe("the task panel's rows", () => {
  it("say how long in the unit a person would", () => {
    expect(elapsed(0, 30_000)).toBeNull();
    expect(elapsed(0, 12 * MIN)).toEqual({ n: 12, unit: "min" });
    expect(elapsed(0, 3 * 60 * MIN)).toEqual({ n: 3, unit: "hr" });
    expect(elapsed(0, 50 * 60 * MIN)).toEqual({ n: 2, unit: "day" });
  });

  it("say what a lead is doing and since when, in Korean too", () => {
    const now = 100 * MIN;
    const running = { ...lead("running"), since: now - 12 * MIN };
    expect(leadStatus(running, now)).toBe("Working for 12 min");
    expect(ko.lookup(leadStatus(running, now))).toBe("12분째 작업 중");
    expect(ko.lookup(leadStatus({ ...running, since: now }, now))).toBe("방금 시작함");
    expect(ko.lookup(leadStatus(lead("asked"), now))).toBe("답을 기다리는 중");
    expect(ko.lookup(leadStatus(lead("queued"), now))).toBe("아직 시작 전");
  });

  it("say how handed work ended and how long ago, in Korean too", () => {
    const now = 1000 * MIN;
    expect(ko.lookup(endingStatus(ending("completed", now - 4 * MIN), now))).toBe("4분 전 완료");
    expect(ko.lookup(endingStatus(ending("failed", now - 3 * 60 * MIN), now))).toBe("3시간 전 실패");
    expect(ko.lookup(endingStatus(ending("stopped", now), now))).toBe("방금 중단됨");
    expect(ko.lookup(endingStatus(ending("lost", now - 25 * 60 * MIN), now))).toBe("1일 전 중간에 끊김");
  });

  it("put the leads that wait for the person first", () => {
    const order = leadsInOrder([lead("queued"), lead("running"), lead("asked")]).map((row) => row.state);
    expect(order).toEqual(["asked", "running", "queued"]);
  });

  it("close one ending, not every ending of the same conversation", () => {
    expect(endingKey(ending("completed", 1))).not.toBe(endingKey(ending("completed", 2)));
  });
});
