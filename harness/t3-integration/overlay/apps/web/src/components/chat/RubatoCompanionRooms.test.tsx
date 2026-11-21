// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const fake = vi.hoisted(() => ({
  selectedId: "segno",
  pathname: "/local/segno-thread",
  navigate: vi.fn(),
  artCalls: [] as string[],
  avatars: {} as Record<string, string>,
  avatarListeners: new Set<() => void>(),
  choices: [] as Array<{ id: string; pictureSet: boolean }>,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fake.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) => select({ pathname: fake.pathname }),
}));
vi.mock("../../state/rubatoCompanion", async () => {
  const { useSyncExternalStore } = await import("react");
  const choices = ["segno", "roo"].map(id => ({
    id, title: id === "segno" ? "Segno" : "Roo", threadId: `${id}-thread`,
    settings: { enabled: true }, pictureSet: false,
  }));
  fake.choices = choices;
  return {
    useReadyEnvironmentId: () => "local",
    useRubatoCompanion: () => ({ companions: [...choices] }),
    // Subscribed like the real store, so a picture set later reaches a memoized face.
    useCompanionAvatar: (id: string | undefined) => useSyncExternalStore(
      (listener: () => void) => { fake.avatarListeners.add(listener); return () => fake.avatarListeners.delete(listener); },
      () => (id ? fake.avatars[id] ?? null : null),
    ),
    selectCompanion: (id: string) => { fake.selectedId = id; },
    acceptCompanionStatus: vi.fn(),
    rubatoCompanion: {
      panel: async () => ({ leads: [], finished: [], held: [] }),
      art: async (_env: string, _state: string, id: string) => {
        fake.artCalls.push(id);
        if (id !== "segno") throw new Error("No character art supplied");
        return { art: { url: "data:image/png;base64,SEGNO_ONLY", version: 1 } };
      },
    },
  };
});
vi.mock("../../state/environments", () => ({
  usePullRequestsSupported: () => false,
  usePrimaryEnvironmentId: () => "environment-local",
}));
vi.mock("../../state/rubatoSchedule", () => ({
  rubatoSchedule: { revision: async () => ({ revision: 0 }), list: async () => ({ tasks: [] }) },
}));
vi.mock("../../state/rubatoStats", () => ({ useStatsWarmup() {} }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) => select({
    sidebarProjectScopeKeys: [], setSidebarProjectScopeKeys() {},
  }),
}));
vi.mock("../sidebar/rubatoProjectList", () => ({
  useRubatoProjectList: () => ({
    list: { listed: [], quiet: [] }, signals: [], lastActivity: {}, remove() {}, add() {}, move() {},
  }),
}));
vi.mock("../sidebar/RubatoProjectPicker", () => ({ RubatoProjectPicker: () => null }));
vi.mock("../pullRequest/pullRequestListPreferences", () => ({ readPullRequestListPreferences: () => ({}) }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ open: false, isMobile: false, setOpen() {} }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactNode }) => render,
  PopoverPopup: () => null,
}));

import { RubatoProjectRail } from "../sidebar/RubatoProjectRail";
import { RubatoSegnoSpace } from "./RubatoSegnoSpace";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("distinct sidebar icons open their own room; Roo stays art-free after visiting Segno and returning", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const right = this.classList.contains("chat-content-lane") ? 600 : 1200;
    return { x: 0, y: 0, left: 0, top: 0, right, bottom: 800, width: right, height: 800, toJSON() {} };
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => { act(() => root.unmount()); host.remove(); };
  const render = () => root.render(<>
    <RubatoProjectRail />
    <RubatoSegnoSpace companionId={fake.selectedId}><div className="chat-content-lane">Conversation</div></RubatoSegnoSpace>
  </>);
  fake.navigate.mockImplementation(({ params }: { params: { threadId: string } }) => {
    fake.pathname = `/local/${params.threadId}`;
  });
  await act(async () => render());
  await vi.waitFor(() => expect(host.querySelectorAll("[data-rubato-segno-art]")).toHaveLength(1));
  const segno = host.querySelector<HTMLButtonElement>("button[aria-label=Segno]")!;
  const roo = host.querySelector<HTMLButtonElement>("button[aria-label=Roo]")!;
  expect(segno).not.toBeNull();
  expect(roo).not.toBeNull();
  expect(segno.querySelector("svg")).not.toBeNull();
  expect(roo.textContent).toBe("R");
  expect(roo.querySelector("img")).toBeNull();
  await act(async () => { roo.click(); render(); });
  expect(fake.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId", params: { environmentId: "local", threadId: "roo-thread" },
  });
  await vi.waitFor(() => expect(fake.artCalls).toContain("roo"));
  expect(host.querySelectorAll("[data-rubato-segno-art], aside img")).toHaveLength(0);
  expect(host.querySelector("aside[aria-label=Roo]")).not.toBeNull();
  await act(async () => { segno.click(); render(); });
  expect(fake.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId", params: { environmentId: "local", threadId: "segno-thread" },
  });
  await vi.waitFor(() => expect(host.querySelector("[data-rubato-segno-art]")?.getAttribute("src")).toContain("SEGNO_ONLY"));
  await act(async () => { roo.click(); render(); });
  expect(host.querySelectorAll("[data-rubato-segno-art], aside img")).toHaveLength(0);
  // A picture set for Roo (intent companion-manage) shows on its rail button; its space still draws no stage art.
  fake.avatars.roo = "data:image/png;base64,ROO_PICTURE";
  await act(async () => { for (const listener of fake.avatarListeners) listener(); });
  expect(roo.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,ROO_PICTURE");
  // Segno's own art is its avatar too, but the rail keeps the drawn glyph until a picture is set in the app.
  fake.avatars.segno = "data:image/png;base64,SEGNO_ART";
  await act(async () => { for (const listener of fake.avatarListeners) listener(); render(); });
  expect(segno.querySelector("svg")).not.toBeNull();
  expect(segno.querySelector("img")).toBeNull();
  fake.choices.find(item => item.id === "segno")!.pictureSet = true;
  fake.avatars.segno = "data:image/png;base64,SEGNO_SET";
  await act(async () => { for (const listener of fake.avatarListeners) listener(); render(); });
  expect(host.querySelector("button[aria-label=Segno] img")?.getAttribute("src")).toBe("data:image/png;base64,SEGNO_SET");
  expect(host.querySelectorAll("[data-rubato-segno-art], aside img")).toHaveLength(0);
});
