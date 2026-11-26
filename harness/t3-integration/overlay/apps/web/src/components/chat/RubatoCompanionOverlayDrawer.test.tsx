// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: React.ReactElement; children?: React.ReactNode }) =>
    children ? <span data-trigger="">{render}{children}</span> : render,
  TooltipPopup: () => null,
}));

const hostRef = vi.hoisted(() => ({ current: null as HTMLDivElement | null }));
vi.mock("./RubatoSegnoSpace", () => ({
  useCompanionOverlayHost: () => hostRef.current,
}));

const {
  CompanionOverlayControls,
  RubatoCompanionOverlayDrawer,
  resolveCompanionDrawerWidth,
} = await import("./RubatoCompanionOverlayDrawer");

let container: HTMLDivElement;
let portalHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  portalHost = document.createElement("div");
  Object.defineProperty(portalHost, "clientWidth", { configurable: true, value: 1200 });
  hostRef.current = portalHost;
  document.body.append(container, portalHost);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  portalHost.remove();
  hostRef.current = null;
});

describe("resolveCompanionDrawerWidth", () => {
  it("sizes the right drawer to ~56% on wide hosts and falls back to full width on narrow hosts", () => {
    expect(resolveCompanionDrawerWidth(1200, null)).toBe(672);
    expect(resolveCompanionDrawerWidth(2000, null)).toBe(920);
    expect(resolveCompanionDrawerWidth(760, null)).toBeNull();
    expect(resolveCompanionDrawerWidth(1200, 500)).toBe(500);
    expect(resolveCompanionDrawerWidth(1200, 1400)).toBe(1020);
  });
});

describe("RubatoCompanionOverlayDrawer", () => {
  it("portals into the companion space host without a backdrop when non-maximized, and closes on Escape", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    act(() =>
      root.render(
        <RubatoCompanionOverlayDrawer
          open
          maximized={false}
          onToggleMaximized={onToggle}
          onClose={onClose}
        >
          <div>
            <CompanionOverlayControls
              maximized={false}
              onToggleMaximized={onToggle}
              onClose={onClose}
            />
            <p>Viewer content</p>
          </div>
        </RubatoCompanionOverlayDrawer>,
      ),
    );
    const overlay = portalHost.querySelector<HTMLElement>("[data-rubato-companion-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay!.dataset.maximized).toBe("false");
    expect(overlay!.style.width).toBe("672px");
    expect(portalHost.querySelector("[data-rubato-companion-overlay-backdrop]")).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a backdrop when expanded and restores size when clicking the backdrop", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    act(() =>
      root.render(
        <RubatoCompanionOverlayDrawer
          open
          maximized
          onToggleMaximized={onToggle}
          onClose={onClose}
        >
          <p>Expanded content</p>
        </RubatoCompanionOverlayDrawer>,
      ),
    );
    const backdrop = portalHost.querySelector<HTMLElement>("[data-rubato-companion-overlay-backdrop]");
    expect(backdrop).not.toBeNull();
    act(() => backdrop!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
