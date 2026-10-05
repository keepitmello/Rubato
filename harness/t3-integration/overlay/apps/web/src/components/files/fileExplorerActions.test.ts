import { describe, expect, it } from "vite-plus/test";

import {
  isHiddenExplorerEntry,
  joinPath,
  parentDirectory,
  remapTreePaths,
  uniqueChildName,
} from "./fileExplorerActions";
import { clampExplorerWidth, EXPLORER_MIN_WIDTH, PREVIEW_MIN_WIDTH } from "./fileExplorerLayout";

describe("file explorer", () => {
  it("hides the files the OS leaves behind, nothing else", () => {
    expect(isHiddenExplorerEntry(".DS_Store")).toBe(true);
    expect(isHiddenExplorerEntry("docs/.DS_Store")).toBe(true);
    expect(isHiddenExplorerEntry("docs/Thumbs.db")).toBe(true);
    expect(isHiddenExplorerEntry(".gitignore")).toBe(false);
    expect(isHiddenExplorerEntry("docs/DS_Store.md")).toBe(false);
  });

  it("names a new entry after the ones already there", () => {
    const taken = new Set(["docs/untitled", "docs/untitled 2"]);
    expect(uniqueChildName((path) => taken.has(path), "docs", "untitled")).toBe("untitled 3");
    expect(uniqueChildName(() => false, "", "untitled folder")).toBe("untitled folder");
  });

  it("splits and joins workspace paths", () => {
    expect(parentDirectory("a/b/c.md")).toBe("a/b");
    expect(parentDirectory("c.md")).toBe("");
    expect(joinPath("", "c.md")).toBe("c.md");
    expect(joinPath("a", "c.md")).toBe("a/c.md");
  });

  it("moves a folder's rows with it and leaves look-alike names alone", () => {
    expect(
      remapTreePaths(["docs/", "docs/a.md", "docs/sub/", "docsx/", "b.md"], "docs", "notes"),
    ).toEqual(["notes/", "notes/a.md", "notes/sub/", "docsx/", "b.md"]);
    expect(remapTreePaths(["a.md", "a.mdx"], "a.md", "b.md")).toEqual(["b.md", "a.mdx"]);
  });

  it("keeps the explorer and the preview usable at any drag width", () => {
    expect(clampExplorerWidth(10, 1000)).toBe(EXPLORER_MIN_WIDTH);
    expect(clampExplorerWidth(5000, 1000)).toBe(1000 - PREVIEW_MIN_WIDTH);
    expect(clampExplorerWidth(300.4, 1000)).toBe(300);
    expect(clampExplorerWidth(300, 300)).toBe(EXPLORER_MIN_WIDTH);
  });
});
