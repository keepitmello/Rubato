import { describe, expect, it } from "vite-plus/test";
import { isCompanionLaunchThread, toggleProjectVisibility, visibleProjects } from "./threadListVisibilityModel";

describe("thread list visibility", () => {
  it("hides scoped projects without hiding the same project identifier on another Mac", () => {
    const a = { environmentId: "mac-a", projectId: "p1" };
    const b = { environmentId: "mac-b", projectId: "p1" };
    expect(visibleProjects([a, b], new Set(["mac-a:p1"]))).toEqual([b]);
  });

  it("toggles an entire project group without losing other hidden projects", () => {
    const hidden = toggleProjectVisibility(["c", "a"], ["a", "b"]);
    expect(hidden).toEqual(["c", "a", "b"]);
    expect(toggleProjectVisibility(hidden, ["a", "b"])).toEqual(["c"]);
  });

  it("matches Rubato imported lead threads only when the companion launched that session", () => {
    const launched = new Set(["lead"]);
    expect(isCompanionLaunchThread("import:rubato-pi:mac:lead", launched)).toBe(true);
    expect(isCompanionLaunchThread("import:rubato-pi:mac:personal", launched)).toBe(false);
    expect(isCompanionLaunchThread("mock:lead", launched)).toBe(false);
  });
});
