import { describe, expect, it } from "vite-plus/test";

import { rubatoReadOpenTarget } from "./RubatoReadOpenButton";

describe("rubatoReadOpenTarget", () => {
  it("opens an image outside the workspace in the expanded preview", () => {
    expect(rubatoReadOpenTarget("/tmp/rubato-look/switcher-check.png", "/Users/wy/repo")).toEqual({
      kind: "media",
      path: "/tmp/rubato-look/switcher-check.png",
    });
  });

  it("opens an image inside the workspace in the expanded preview too", () => {
    expect(rubatoReadOpenTarget("/Users/wy/repo/docs/shot.JPG", "/Users/wy/repo")).toEqual({
      kind: "media",
      path: "/Users/wy/repo/docs/shot.JPG",
    });
  });

  it("opens a workspace file in the files panel by its workspace path", () => {
    expect(rubatoReadOpenTarget("/Users/wy/repo/src/a.ts", "/Users/wy/repo/")).toEqual({
      kind: "file",
      path: "src/a.ts",
    });
  });

  it("opens a host file outside the workspace by its absolute path", () => {
    expect(rubatoReadOpenTarget("/tmp/report.md", "/Users/wy/repo")).toEqual({
      kind: "file",
      path: "/tmp/report.md",
    });
  });

  it("does not take a sibling folder that shares the workspace prefix for the workspace", () => {
    expect(rubatoReadOpenTarget("/Users/wy/repo-other/a.ts", "/Users/wy/repo")).toEqual({
      kind: "file",
      path: "/Users/wy/repo-other/a.ts",
    });
  });

  it("opens the first of several read paths", () => {
    expect(rubatoReadOpenTarget("\n/tmp/a.txt\n/tmp/b.txt", undefined)).toEqual({
      kind: "file",
      path: "/tmp/a.txt",
    });
  });

  it("offers nothing when the row has no read path", () => {
    expect(rubatoReadOpenTarget(null, "/Users/wy/repo")).toBeNull();
    expect(rubatoReadOpenTarget("  \n ", "/Users/wy/repo")).toBeNull();
  });

  it("does not take a dotfile name for an image extension", () => {
    expect(rubatoReadOpenTarget("/tmp/.png", undefined)).toEqual({ kind: "file", path: "/tmp/.png" });
  });
});
