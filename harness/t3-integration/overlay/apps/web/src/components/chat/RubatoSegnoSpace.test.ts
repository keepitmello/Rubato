import { describe, expect, it } from "vite-plus/test";

import { createUiTranslator, type UiDictionary } from "../../rubatoI18n";
import korean from "../../rubatoI18n.ko.json";
import type { SegnoFinished, SegnoLead, SegnoPanel } from "../../state/rubatoCompanion";
import {
  ART_MAX_PX,
  ART_MIN_PX,
  ART_SHARE,
  ART_VISIBLE_MIN,
  CHAT_MIN_PX,
  NIGHT_HOURS,
  elapsed,
  endingKey,
  endingStatus,
  leadStatus,
  leadsInOrder,
  segnoStageLayout,
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

describe("segnoStageLayout", () => {
  const aspect = 804 / 1100;
  const layout = (right: number, height: number, columnLeft = 150) =>
    segnoStageLayout({ right, height, columnLeft, aspect });

  it("sizes Segno by the height alone, the same share at any width", () => {
    for (const [width, height] of [[2560, 1440], [1920, 1080], [1440, 900], [1280, 800], [1100, 800]] as const) {
      const { artHeight, showArt } = layout(width, height);
      expect(showArt).toBe(true);
      expect(artHeight).toBe(Math.round(height * ART_SHARE));
    }
    expect(layout(1440, 900).artHeight).toBe(layout(2560, 900).artHeight);
  });

  it("keeps Segno within its bounds on very short and very tall windows", () => {
    expect(layout(1920, 400).artHeight).toBe(ART_MIN_PX);
    expect(layout(3840, 2160).artHeight).toBe(ART_MAX_PX);
  });

  it("narrows the chat to leave Segno her room, never below the chat's minimum", () => {
    const wide = layout(1920, 1080);
    expect(wide.chatRoom! + 150 + wide.artWidth).toBeLessThanOrEqual(1920);
    const narrow = layout(1000, 800);
    expect(narrow.showArt).toBe(true);
    expect(narrow.chatRoom).toBe(CHAT_MIN_PX);
  });

  it("steps aside when too little of Segno would fit, and leaves the chat alone", () => {
    const hidden = layout(900, 900);
    expect(hidden.showArt).toBe(false);
    expect(hidden.chatRoom).toBeNull();
    // Just enough of the picture fits to show her peeking.
    const art = layout(10_000, 900).artWidth;
    const right = 150 + CHAT_MIN_PX + 16 + 8 + Math.ceil(art * ART_VISIBLE_MIN);
    expect(layout(right, 900).showArt).toBe(true);
    expect(layout(right - 2, 900).showArt).toBe(false);
  });

  it("leaves the chat alone for a companion without pictures", () => {
    expect(segnoStageLayout({ right: 1440, height: 900, columnLeft: 150, aspect: 0 })).toMatchObject({
      showArt: false,
      chatRoom: null,
    });
  });
});
