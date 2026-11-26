// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const openFileMock = vi.fn();
const assetState = vi.hoisted(() => ({
  current: { _tag: "Success", url: "https://asset.local/report.html", waiting: false } as
    | { _tag: "Success"; url: string; waiting: boolean }
    | { _tag: "Failure"; message: string }
    | { _tag: "Initial" },
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => assetState.current,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openFile: openFileMock }),
  },
}));

const { RubatoCompanionHtmlCard } = await import("./RubatoCompanionHtmlCard");

const envId = EnvironmentId.make("env-1");
const threadRef = scopeThreadRef(envId, ThreadId.make("companion-thread"));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  openFileMock.mockReset();
  assetState.current = { _tag: "Success", url: "https://asset.local/report.html", waiting: false };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("RubatoCompanionHtmlCard", () => {
  it("renders the attached HTML inline in a sandboxed iframe and opens the overlay on click", () => {
    act(() =>
      root.render(
        <RubatoCompanionHtmlCard
          label="weekly-report.html"
          path="/tmp/weekly-report.html"
          cwd="/work/project"
          environmentId={envId}
          threadRef={threadRef}
        />,
      ),
    );
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src")).toBe("https://asset.local/report.html");
    expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(iframe!.className).toContain("pointer-events-none");

    const card = host.querySelector<HTMLElement>("[data-rubato-segno-html-card]");
    expect(card).not.toBeNull();
    act(() => card!.click());
    expect(openFileMock).toHaveBeenCalledWith(threadRef, "/tmp/weekly-report.html");
  });

  it("shows a fallback message when loading fails while still opening the overlay on click", () => {
    assetState.current = { _tag: "Failure", message: "missing" };
    act(() =>
      root.render(
        <RubatoCompanionHtmlCard
          label="missing.html"
          path="/tmp/missing.html"
          cwd={undefined}
          environmentId={envId}
          threadRef={threadRef}
        />,
      ),
    );
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("HTML preview unavailable");

    const card = host.querySelector<HTMLElement>("[data-rubato-segno-html-card]")!;
    act(() => card.click());
    expect(openFileMock).toHaveBeenCalledWith(threadRef, "/tmp/missing.html");
  });
});
