// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider, useSidebar } from "../ui/sidebar";
import { useThreadListFoldedHere } from "./RubatoSegnoSpace";

let sidebar: ReturnType<typeof useSidebar>;
function Reader() {
  sidebar = useSidebar();
  return null;
}
function SegnoSpace() {
  useThreadListFoldedHere();
  return null;
}
function App({ inSegno, defaultOpen }: { inSegno: boolean; defaultOpen: boolean }) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Reader />
      {inSegno ? <SegnoSpace /> : null}
    </SidebarProvider>
  );
}

let root: Root;
let host: HTMLDivElement;
const render = (props: { inSegno: boolean; defaultOpen: boolean }) =>
  act(() => root.render(<App {...props} />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("cookieStore", { set: async () => {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the thread list in Segno's space", () => {
  it("folds on the way in and opens again on the way out", async () => {
    await render({ inSegno: false, defaultOpen: true });
    expect(sidebar.open).toBe(true);
    await render({ inSegno: true, defaultOpen: true });
    expect(sidebar.open).toBe(false);
    await render({ inSegno: false, defaultOpen: true });
    expect(sidebar.open).toBe(true);
  });

  it("lets the person open it in Segno's space, and still restores their choice on leaving", async () => {
    await render({ inSegno: false, defaultOpen: false });
    await render({ inSegno: true, defaultOpen: false });
    expect(sidebar.open).toBe(false);
    await act(() => sidebar.setOpen(true));
    expect(sidebar.open).toBe(true);
    await render({ inSegno: false, defaultOpen: false });
    expect(sidebar.open).toBe(false);
  });
});
