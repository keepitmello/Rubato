// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: React.ReactElement; children: React.ReactNode }) => (
    <span>
      {render}
      {children}
    </span>
  ),
  TooltipPopup: () => null,
}));

import { RubatoTimelineRail } from "./RubatoTimelineRail";
import { RAIL_DAY_ROW_PX, RAIL_MARK_SPACING_PX } from "./rubatoTimelineRail.logic";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const day = (date: number, hour: number) => new Date(2026, 10, date, hour).getTime();
const items: TimelineMinimapItem[] = Array.from({ length: 6 }, (_, index) => ({
  id: `t${index}`,
  rowIndex: index * 2,
  userText: `question ${index}`,
  assistantText: `answer ${index}`,
}));
// Two turns on the 9th, three on the 10th, one on the 11th.
const times = [day(9, 9), day(9, 10), day(10, 9), day(10, 11), day(10, 15), day(11, 8)];

function draw(props: Partial<Parameters<typeof RubatoTimelineRail>[0]> = {}) {
  const onSelect = vi.fn();
  const onWheel = vi.fn();
  act(() =>
    root.render(
      <RubatoTimelineRail
        items={items}
        times={times}
        hasPersistentGutter
        hitStripWidth={40}
        currentIndex={5}
        stripMap={new Map()}
        onWheel={onWheel}
        onSelect={onSelect}
        {...props}
      />,
    ),
  );
  return { onSelect, onWheel };
}

const mark = (index: number) => host.querySelector<HTMLElement>(`[data-rail-index="${index}"]`)!;

it("keeps every mark's spacing and starts each day with its name", () => {
  draw();
  const days = [...host.querySelectorAll("[data-rubato-rail-day]")].map((node) => node.textContent);
  expect(days).toHaveLength(3);
  expect(days[0]).toBe("11/9");
  const button = host.querySelector<HTMLButtonElement>("[data-rubato-timeline-rail-list] > button")!;
  expect(button.style.height).toBe(`${3 * RAIL_DAY_ROW_PX + 6 * RAIL_MARK_SPACING_PX}px`);
  // Each day's name comes right before that day's first mark.
  expect(mark(2).previousElementSibling?.hasAttribute("data-rubato-rail-day")).toBe(true);
  expect(mark(3).previousElementSibling?.hasAttribute("data-rubato-rail-day")).toBe(false);
});

it("previews a turn with when it was, and says an undrawn one loads its day", () => {
  draw({ pendingIds: new Set(["t0", "t1"]) });
  expect(mark(0).querySelector("[data-minimap-strip]")?.getAttribute("data-pending")).toBe("true");
  expect(mark(4).querySelector("[data-minimap-strip]")?.hasAttribute("data-pending")).toBe(false);

  act(() => mark(1).dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  const preview = host.querySelector("[data-minimap-preview]")!;
  expect(preview.textContent).toContain("question 1");
  expect(preview.textContent).toContain("answer 1");
  expect(preview.textContent).toContain("November 9");
  expect(preview.textContent).toContain("Click to load that day and go there");

  act(() => mark(4).dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  expect(host.querySelector("[data-minimap-preview]")!.textContent).not.toContain("Click to load");
});

it("goes to the turn whose mark is clicked", () => {
  const { onSelect } = draw();
  act(() => mark(3).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onSelect).toHaveBeenCalledWith(items[3]);
});

it("names no day for a conversation within one day", () => {
  draw({ times: times.map(() => day(11, 9)) });
  expect(host.querySelectorAll("[data-rubato-rail-day]")).toHaveLength(0);
});

it("passes the wheel to the conversation while the rail fits", () => {
  const { onWheel } = draw();
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 });
  act(() => mark(2).dispatchEvent(event));
  expect(onWheel).toHaveBeenCalledTimes(1);
});
