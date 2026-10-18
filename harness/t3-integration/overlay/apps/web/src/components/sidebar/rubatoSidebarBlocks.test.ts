import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";

import { createSidebarSortingStrategy } from "../Sidebar.drag";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "../Sidebar.logic";
import {
  DEFAULT_SIDEBAR_BLOCK_ORDER,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  RECENT_LIMIT_MIN,
  buildSidebarBlockItems,
  clampRecentLimit,
  isDefaultSidebarBlockOrder,
  moveSidebarBlock,
  nearestSidebarBlockGap,
  resolveSidebarBlockOrder,
  sidebarSpacerMarker,
  type RubatoSidebarBlock,
} from "./rubatoSidebarBlocks";

type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
const thread = (key: string, section: SidebarSection): ThreadItem => ({ kind: "thread", key, section });
const markerOf = (item: SidebarListItem) =>
  item.kind === "marker" ? item.marker : `${item.section}:${item.key}`;

function list(order: readonly RubatoSidebarBlock[], extra: Partial<Parameters<typeof buildSidebarBlockItems>[0]> = {}) {
  return buildSidebarBlockItems({
    order,
    recent: true,
    title: true,
    pinned: [thread("e:p1", "pinned")],
    active: [thread("e:a1", "active"), thread("e:a2", "active")],
    working: [thread("e:w1", "working")],
    snoozed: null,
    settled: [thread("e:s1", "settled"), thread("e:s2", "settled")],
    settledMore: false,
    ...extra,
  });
}

describe("the stored order", () => {
  it("starts with Recent above the project's threads", () => {
    expect(resolveSidebarBlockOrder([])).toEqual(["recent", "threads", "working", "snoozed", "settled"]);
    expect(resolveSidebarBlockOrder(undefined)).toEqual(DEFAULT_SIDEBAR_BLOCK_ORDER);
    expect(isDefaultSidebarBlockOrder(resolveSidebarBlockOrder([]))).toBe(true);
  });

  it("drops unknown ids and repeats, and puts a missing block after its default neighbour", () => {
    expect(resolveSidebarBlockOrder(["settled", "bogus", "recent", "settled"])).toEqual([
      "settled",
      "recent",
      "threads",
      "working",
      "snoozed",
    ]);
    expect(resolveSidebarBlockOrder(["working"])).toEqual([
      "recent",
      "threads",
      "working",
      "snoozed",
      "settled",
    ]);
  });

  it("moves a block before another, or to the end", () => {
    const order = resolveSidebarBlockOrder([]);
    expect(moveSidebarBlock(order, "settled", "threads")).toEqual([
      "recent",
      "settled",
      "threads",
      "working",
      "snoozed",
    ]);
    expect(moveSidebarBlock(order, "recent", null)).toEqual([
      "threads",
      "working",
      "snoozed",
      "settled",
      "recent",
    ]);
    expect(moveSidebarBlock(order, "working", "working")).toEqual(order);
  });

  it("keeps the Recent count between 1 and 15", () => {
    expect(clampRecentLimit(0)).toBe(RECENT_LIMIT_MIN);
    expect(clampRecentLimit(99)).toBe(RECENT_LIMIT_MAX);
    expect(clampRecentLimit(7.4)).toBe(7);
    expect(clampRecentLimit(Number.NaN)).toBe(RECENT_LIMIT_DEFAULT);
  });
});

describe("the list in the user's order", () => {
  it("lays out T3's list unchanged under Recent and the title by default", () => {
    expect(list(DEFAULT_SIDEBAR_BLOCK_ORDER).map(markerOf)).toEqual([
      "rubato-recent",
      "rubato-title",
      "pinned-header",
      "pinned:e:p1",
      "pinned-divider",
      "active-placeholder",
      "active:e:a1",
      "active:e:a2",
      "working-header",
      "working:e:w1",
      "settled-header",
      "settled-placeholder",
      "settled:e:s1",
      "settled:e:s2",
    ]);
  });

  it("gives the free space to the first section after the project's threads", () => {
    expect(sidebarSpacerMarker(list(DEFAULT_SIDEBAR_BLOCK_ORDER))).toBe("working-header");
    expect(sidebarSpacerMarker(list(["threads", "recent", "working", "snoozed", "settled"]))).toBe(
      "rubato-recent",
    );
    expect(sidebarSpacerMarker(list(["recent", "working", "snoozed", "settled", "threads"]))).toBeNull();
  });

  it("puts the drop line at the gap nearest the pointer", () => {
    const blocks = [
      { block: "recent" as const, top: 0, bottom: 100 },
      { block: "threads" as const, top: 100, bottom: 600 },
      { block: "settled" as const, top: 600, bottom: 640 },
    ];
    expect(nearestSidebarBlockGap(blocks, "settled", 120)).toEqual({ before: "threads", y: 100 });
    expect(nearestSidebarBlockGap(blocks, "recent", 590)).toEqual({ before: "settled", y: 600 });
    expect(nearestSidebarBlockGap(blocks, "recent", 635)).toEqual({ before: null, y: 640 });
    expect(nearestSidebarBlockGap(blocks, "recent", 10)).toEqual({ before: "threads", y: 100 });
  });
});

describe("dragging a thread when the sections are moved", () => {
  const id = (marker: SidebarListMarker) => sidebarMarkerId(marker);

  it("settles a thread dropped among Settled above the project's threads", () => {
    const items = list(["settled", "recent", "threads", "working", "snoozed"]);
    expect(resolveSidebarDropTarget(items, "e:a1", "e:s1")?.section).toBe("settled");
  });

  it("settles a thread lifted up into a collapsed Settled above the project's threads", () => {
    const items = list(["recent", "settled", "threads", "working", "snoozed"], { settled: [] });
    expect(resolveSidebarDropTarget(items, "e:a1", id("settled-placeholder"))?.section).toBe("settled");
    // Just above Settled's header is Recent, where nothing lands.
    expect(resolveSidebarDropTarget(items, "e:a1", id("settled-header"))).toBeNull();
  });

  it("keeps the pins and inbox order of the project's section wherever it sits", () => {
    const items = list(["settled", "working", "threads", "recent", "snoozed"]);
    const target = resolveSidebarDropTarget(items, "e:a2", "e:a1");
    expect(target).toEqual({ section: "active", pinnedOrder: ["e:p1"], activeOrder: ["e:a2", "e:a1"] });
    expect(resolveSidebarDropTarget(items, "e:s1", "e:a2")).toEqual({
      section: "active",
      pinnedOrder: ["e:p1"],
      activeOrder: ["e:a1", "e:a2", "e:s1"],
    });
  });

  it("lands nowhere in Recent or Working", () => {
    const items = list(DEFAULT_SIDEBAR_BLOCK_ORDER);
    expect(resolveSidebarDropTarget(items, "e:a1", id("rubato-recent"))).toBeNull();
    expect(resolveSidebarDropTarget(items, "e:a1", "e:w1")).toBeNull();
  });

  it("pins a thread dropped at the top of the project's section", () => {
    const items = list(DEFAULT_SIDEBAR_BLOCK_ORDER);
    expect(resolveSidebarDropTarget(items, "e:a1", id("pinned-header"))?.section).toBe("pinned");
  });

  it("moves Recent and the title with the preview instead of hiding them", () => {
    const items = list(["settled", "recent", "threads", "working", "snoozed"], { settledMore: true });
    let top = 0;
    const rects = items.map((item) => {
      const height = item.kind === "thread" ? 40 : item.marker === "rubato-recent" ? 120 : 20;
      const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
      top += height + 1;
      return rect;
    });
    const activeIndex = items.findIndex((item) => sidebarListItemId(item) === "e:a1");
    const overIndex = items.findIndex((item) => sidebarListItemId(item) === "e:s1");
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: ["e:s1", "e:s2"],
      settledExpanded: true,
    });
    const transforms = items.map((_, index) =>
      strategy({
        rects,
        activeIndex,
        overIndex,
        activeNodeRect: rects[activeIndex]!,
        index,
      } satisfies Parameters<SortingStrategy>[0]),
    );
    const at = (marker: SidebarListMarker) => {
      const index = items.findIndex((item) => item.kind === "marker" && item.marker === marker);
      return { transform: transforms[index]!, top: rects[index]!.top + (transforms[index]?.y ?? 0) };
    };
    for (const marker of ["rubato-recent", "rubato-title", "rubato-settled-more"] as const) {
      expect(at(marker).transform?.scaleY).toBe(1);
    }
    // Settled grew by the dropped row, and the sections below it follow in order.
    expect(at("settled-header").top).toBe(0);
    expect(at("rubato-settled-more").top).toBeLessThan(at("rubato-recent").top);
    expect(at("rubato-recent").top).toBeLessThan(at("rubato-title").top);
    expect(at("rubato-title").top).toBeLessThan(at("working-header").top);
  });
});
