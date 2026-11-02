// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";

vi.mock("../../state/rubatoCompanion", () => ({
  useRubatoCompanion: () => ({ companions: [{ id: "segno", threadId: "segno-thread" }] }),
  rubatoCompanion: { innerSummaries: async () => ({ spans: [] }) },
}));
vi.mock("./RubatoSegnoInner", () => ({
  RubatoSegnoSpanLine: () => null,
  useSegnoSpanSummaries: () => [],
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));

const { RubatoSegnoChat } = await import("./RubatoSegnoChat");

const entry = (id: string, role: "user" | "assistant", minute: number, text: string) =>
  ({
    kind: "message",
    id,
    createdAt: new Date(2026, 10, 2, 9, minute).toISOString(),
    message: { id, role, text, createdAt: new Date(2026, 10, 2, 9, minute).toISOString(), streaming: false },
  }) as unknown as TimelineEntry;
const entries = [
  entry("a", "user", 0, "폴라리스 빼고"),
  entry("b", "assistant", 1, "고쳤어"),
  entry("c", "user", 2, "고마워"),
  entry("d", "assistant", 3, "응"),
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/** jsdom lays nothing out: the scroller is 2000px of content in a 500px window. */
function scrollTo(scroller: HTMLElement, top: number) {
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  scroller.scrollTop = top;
  act(() => {
    scroller.dispatchEvent(new Event("scroll"));
  });
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

it("draws the timeline with one mark per turn, and shows Scroll to end only away from the end", () => {
  act(() => root.render(<RubatoSegnoChat entries={entries} working={false} cwd={undefined} bottomInset={80} threadId="segno-thread" />));
  expect(host.querySelector("[data-testid='timeline-minimap']")).not.toBeNull();
  expect([...host.querySelectorAll("[data-rubato-segno-mark]")].map((row) => row.getAttribute("data-rubato-segno-mark"))).toEqual(["a", "c"]);

  const scroller = host.querySelector<HTMLElement>("[data-rubato-segno-scroller]")!;
  scrollTo(scroller, 200);
  const pill = host.querySelector<HTMLButtonElement>("button[aria-label='Scroll to end']");
  expect(pill).not.toBeNull();
  expect(pill!.parentElement!.style.bottom).toBe("84px");

  scroller.scrollTo = vi.fn();
  act(() => pill!.click());
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
  expect(host.querySelector("button[aria-label='Scroll to end']")).toBeNull();

  scrollTo(scroller, 1500);
  expect(host.querySelector("button[aria-label='Scroll to end']")).toBeNull();
});
