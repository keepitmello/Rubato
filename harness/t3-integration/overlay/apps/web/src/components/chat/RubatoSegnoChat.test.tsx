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

const render = (list: TimelineEntry[]) =>
  act(() => root.render(<RubatoSegnoChat entries={list} working={false} cwd={undefined} bottomInset={80} threadId="segno-thread" />));
const pillText = () => host.querySelector("button[aria-label='Scroll to end']")?.textContent ?? null;

it("counts the companion's messages that arrive while the reader is up the conversation", () => {
  render(entries);
  const scroller = host.querySelector<HTMLElement>("[data-rubato-segno-scroller]")!;
  scrollTo(scroller, 200);
  expect(pillText()).toBe("Scroll to end");

  render([...entries, entry("e", "assistant", 4, "하나 더"), entry("f", "assistant", 5, "또 하나")]);
  expect(pillText()).toBe("2 new messages");

  scrollTo(scroller, 1500);
  expect(pillText()).toBeNull();
  scrollTo(scroller, 200);
  expect(pillText()).toBe("Scroll to end");
});

it("brings the room to the end when the person's own message arrives", () => {
  render(entries);
  const scroller = host.querySelector<HTMLElement>("[data-rubato-segno-scroller]")!;
  scrollTo(scroller, 200);
  scroller.scrollTo = vi.fn();
  render([...entries, entry("g", "user", 6, "보냈어")]);
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
  expect(pillText()).toBeNull();
});

it("moves the room with page keys when no field has them, and leaves the composer's keys alone", () => {
  render(entries);
  const scroller = host.querySelector<HTMLElement>("[data-rubato-segno-scroller]")!;
  scrollTo(scroller, 1500);
  scroller.scrollBy = vi.fn();
  scroller.scrollTo = vi.fn();
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
  });
  expect(scroller.scrollBy).toHaveBeenCalledWith({ top: -340, behavior: "smooth" });
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  });
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

  const field = document.createElement("textarea");
  document.body.append(field);
  act(() => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
  });
  expect(scroller.scrollBy).toHaveBeenCalledTimes(1);
  field.remove();
});

it("gives both sides' bubbles a menu with Copy, and rewind only to the person's; every bubble carries its time", () => {
  act(() =>
    root.render(
      <RubatoSegnoChat entries={entries} working={false} cwd={undefined} bottomInset={80} threadId="segno-thread" onRewind={() => {}} />,
    ),
  );
  const bubble = (id: string) =>
    [...host.querySelectorAll("[data-rubato-segno-row]")].find((row) => row.textContent?.includes(id))!.querySelector("[data-rubato-segno-bubble]")!;
  act(() => {
    bubble("고쳤어").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  let menu = host.querySelector("[data-rubato-segno-menu]")!;
  expect([...menu.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Copy"]);
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  act(() => {
    bubble("폴라리스 빼고").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  menu = host.querySelector("[data-rubato-segno-menu]")!;
  expect(menu.querySelector("[data-rubato-segno-rewind]")).not.toBeNull();
  expect(host.querySelectorAll("time[data-rubato-segno-at]")).toHaveLength(4);
});

it("puts a pencil on the person's bubbles only, and the pencil or the menu turns that bubble into an editor", () => {
  act(() =>
    root.render(
      <RubatoSegnoChat
        entries={entries}
        working={false}
        cwd={undefined}
        bottomInset={80}
        threadId="segno-thread"
        threadKey="env:segno-thread"
        onRewind={() => {}}
      />,
    ),
  );
  const row = (text: string) => [...host.querySelectorAll("[data-rubato-segno-row]")].find((item) => item.textContent?.includes(text))!;
  expect(row("고쳤어").querySelector("[data-rubato-segno-edit]")).toBeNull();
  const pencil = row("폴라리스 빼고").querySelector<HTMLButtonElement>("[data-rubato-segno-edit] button[aria-label='Edit message']");
  expect(pencil).not.toBeNull();
  expect(pencil!.disabled).toBe(false);

  act(() => pencil!.click());
  const editor = host.querySelector<HTMLTextAreaElement>("[data-rubato-segno-editor] textarea");
  expect(editor?.value).toBe("폴라리스 빼고");
  act(() => {
    editor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(host.querySelector("[data-rubato-segno-editor]")).toBeNull();

  act(() => {
    row("고마워").querySelector("[data-rubato-segno-bubble]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  act(() => host.querySelector<HTMLButtonElement>("[data-rubato-segno-edit-item]")!.click());
  expect(host.querySelector<HTMLTextAreaElement>("[data-rubato-segno-editor] textarea")?.value).toBe("고마워");
});

it("leaves the pencil out when the room has no edit host to answer it", () => {
  act(() => root.render(<RubatoSegnoChat entries={entries} working={false} cwd={undefined} bottomInset={80} threadId="segno-thread" />));
  expect(host.querySelector("[data-rubato-segno-edit]")).toBeNull();
});
