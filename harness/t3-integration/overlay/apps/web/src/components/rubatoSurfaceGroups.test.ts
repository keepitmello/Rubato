import { describe, expect, it } from "vite-plus/test";

import { orderSurfaceActions, startsSurfaceGroup } from "./rubatoSurfaceGroups";

const upstreamOrder = [
  "Browser",
  "Terminal",
  "Files",
  "Markdown note",
  "Diff",
  "Pull request",
  "Linked pull requests",
  "Agents",
  "Device",
].map((label) => ({ label }));

describe("surface groups", () => {
  it("puts Agents first, then files, previews and source control", () => {
    const ordered = orderSurfaceActions(upstreamOrder);
    expect(ordered.map((action) => action.label)).toEqual([
      "Agents",
      "Files",
      "Markdown note",
      "Terminal",
      "Browser",
      "Device",
      "Diff",
      "Pull request",
      "Linked pull requests",
    ]);
    expect(ordered.flatMap((action, index) => (startsSurfaceGroup(ordered, index) ? [action.label] : []))).toEqual([
      "Files",
      "Browser",
      "Diff",
    ]);
  });

  it("keeps a surface it does not know after the groups, in upstream order", () => {
    const ordered = orderSurfaceActions([{ label: "Canvas" }, { label: "Diff" }, { label: "Zoo" }, { label: "Agents" }]);
    expect(ordered.map((action) => action.label)).toEqual(["Agents", "Diff", "Canvas", "Zoo"]);
    expect(startsSurfaceGroup(ordered, 2)).toBe(true);
    expect(startsSurfaceGroup(ordered, 3)).toBe(false);
  });
});
