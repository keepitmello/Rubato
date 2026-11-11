import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  RAIL_DAY_ROW_PX,
  RAIL_MARK_SPACING_PX,
  railContentHeight,
  railDayLabel,
  railDayTitle,
  railFollowScrollTop,
  railRows,
  rubatoTimelineItemTimes,
} from "./rubatoTimelineRail.logic";

const now = new Date(2026, 10, 11, 16, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();

describe("railRows", () => {
  it("names no day when the conversation stays within one", () => {
    const rows = railRows([at(11, 9), at(11, 10), null, at(11, 12)]);
    expect(rows.every((row) => row.kind === "mark")).toBe(true);
    expect(railContentHeight(rows)).toBe(4 * RAIL_MARK_SPACING_PX);
  });

  it("starts each day with its name, before that day's first mark", () => {
    const rows = railRows([at(9, 9), at(9, 20), null, at(10, 8), at(11, 9)]);
    expect(rows.map((row) => (row.kind === "day" ? `day ${new Date(row.at).getDate()}` : row.index))).toEqual([
      "day 9",
      0,
      1,
      2,
      "day 10",
      3,
      "day 11",
      4,
    ]);
    expect(railContentHeight(rows)).toBe(3 * RAIL_DAY_ROW_PX + 5 * RAIL_MARK_SPACING_PX);
  });
});

describe("day names", () => {
  it("says today and yesterday, then month/day, with the year once it is another year", () => {
    expect(railDayLabel(at(11, 9), now, "en-US")).toBe("Today");
    expect(railDayLabel(at(10, 9), now, "en-US")).toBe("Yesterday");
    expect(railDayLabel(at(10, 9), now, "ko-KR")).toBe("어제");
    expect(railDayLabel(at(8, 9), now, "ko-KR")).toBe("11/8");
    expect(railDayLabel(new Date(2025, 11, 30, 9).getTime(), now, "en-US")).toBe("2025/12/30");
  });

  it("titles a day with its date and weekday", () => {
    expect(railDayTitle(at(10, 9), now, "ko-KR")).toBe("어제 · 11월 10일 화요일");
    expect(railDayTitle(at(8, 9), now, "en-US")).toBe("Sunday, November 8");
  });
});

describe("railFollowScrollTop", () => {
  const view = { viewHeight: 400, contentHeight: 2_000 };
  it("stays while the reader's mark is in the middle band", () => {
    expect(railFollowScrollTop({ ...view, markTop: 600, markHeight: 8, scrollTop: 400 })).toBeNull();
  });
  it("centers a mark that left the band, within what the rail can scroll", () => {
    expect(railFollowScrollTop({ ...view, markTop: 1_000, markHeight: 8, scrollTop: 400 })).toBe(804);
    expect(railFollowScrollTop({ ...view, markTop: 20, markHeight: 8, scrollTop: 400 })).toBe(0);
    expect(railFollowScrollTop({ ...view, markTop: 1_990, markHeight: 8, scrollTop: 0 })).toBe(1_600);
  });
  it("leaves a rail that fits alone", () => {
    expect(railFollowScrollTop({ markTop: 300, markHeight: 8, scrollTop: 0, viewHeight: 400, contentHeight: 400 })).toBeNull();
  });
});

describe("rubatoTimelineItemTimes", () => {
  it("reads each mark's time from its user message", () => {
    const rows = [
      { kind: "message", id: "u1", message: { role: "user", createdAt: "2026-11-10T03:00:00.000Z" } },
      { kind: "working", id: "w", createdAt: null },
      { kind: "message", id: "u2", message: { role: "user", createdAt: "not a date" } },
    ] as unknown as MessagesTimelineRow[];
    const items = [
      { id: "u1", rowIndex: 0, userText: "a", assistantText: null },
      { id: "w", rowIndex: 1, userText: null, assistantText: null },
      { id: "u2", rowIndex: 2, userText: "b", assistantText: null },
    ];
    expect(rubatoTimelineItemTimes(rows, items)).toEqual([Date.parse("2026-11-10T03:00:00.000Z"), null, null]);
  });
});
