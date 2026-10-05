import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";
import {
  closeFileSurfaces,
  type FileSurface,
  pinFileSurface,
  placeFileSurface,
  renameFileSurfaces,
} from "./rubatoFileTabs";

const file = (relativePath: string, preview?: boolean): FileSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine: null,
  revealRequestId: 1,
  ...(preview ? { preview: true } : {}),
});
const terminal: RightPanelSurface = {
  id: "terminal:t",
  kind: "terminal",
  resourceId: "t",
  terminalIds: ["t"],
  activeTerminalId: "t",
};
const ids = (surfaces: readonly RightPanelSurface[]) => surfaces.map((entry) => entry.id);
const state = (surfaces: RightPanelSurface[], active: string | null): ThreadRightPanelState => ({
  isOpen: true,
  activeSurfaceId: active,
  surfaces,
});

describe("file tabs", () => {
  it("replaces the preview tab in place instead of adding one per click", () => {
    const surfaces = [file("a.md"), file("b.md", true), terminal];
    const next = placeFileSurface(surfaces, file("c.md"), true);
    expect(ids(next)).toEqual(["file:a.md", "file:c.md", "terminal:t"]);
    expect((next[1] as FileSurface).preview).toBe(true);
  });

  it("adds a preview tab when there is none", () => {
    const next = placeFileSurface([file("a.md")], file("b.md"), true);
    expect(ids(next)).toEqual(["file:a.md", "file:b.md"]);
    expect((next[1] as FileSurface).preview).toBe(true);
  });

  it("keeps a pinned tab pinned when the explorer opens it again", () => {
    const next = placeFileSurface([file("a.md"), file("b.md", true)], file("a.md"), true);
    expect(ids(next)).toEqual(["file:a.md", "file:b.md"]);
    expect((next[0] as FileSurface).preview).toBeUndefined();
  });

  it("pins a preview tab opened from elsewhere, like a chat link", () => {
    const next = placeFileSurface([file("a.md", true)], file("a.md"), false);
    expect((next[0] as FileSurface).preview).toBeUndefined();
  });

  it("never replaces a pinned tab", () => {
    const next = placeFileSurface([file("a.md")], file("b.md"), false);
    expect(ids(next)).toEqual(["file:a.md", "file:b.md"]);
  });

  it("pins only the named preview tab", () => {
    const current = state([file("a.md", true)], "file:a.md");
    const next = pinFileSurface(current, "a.md");
    expect((next.surfaces[0] as FileSurface).preview).toBeUndefined();
    expect(pinFileSurface(next, "a.md")).toBe(next);
  });

  it("follows a folder rename into its open tabs and the active tab", () => {
    const current = state(
      [file("docs/a.md"), file("docs/sub/b.md"), file("docsx/c.md"), terminal],
      "file:docs/sub/b.md",
    );
    const next = renameFileSurfaces(current, "docs", "notes");
    expect(ids(next.surfaces)).toEqual([
      "file:notes/a.md",
      "file:notes/sub/b.md",
      "file:docsx/c.md",
      "terminal:t",
    ]);
    expect(next.activeSurfaceId).toBe("file:notes/sub/b.md");
  });

  it("closes the tabs of a deleted folder and activates the next remaining tab", () => {
    const current = state(
      [file("x.md"), file("docs/a.md"), file("docs/b.md"), terminal],
      "file:docs/a.md",
    );
    const next = closeFileSurfaces(current, "docs");
    expect(ids(next.surfaces)).toEqual(["file:x.md", "terminal:t"]);
    expect(next.activeSurfaceId).toBe("terminal:t");
    expect(closeFileSurfaces(next, "docs")).toBe(next);
  });
});
