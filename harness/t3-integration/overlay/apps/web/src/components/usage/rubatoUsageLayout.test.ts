import { describe, expect, it } from "vite-plus/test";

import { arrangePools, moveDriver, toggleCollapsed } from "./rubatoUsageLayout";

const pools = (...drivers: string[]) => drivers.map((driver) => ({ driver }));
const drivers = (list: ReadonlyArray<{ readonly driver: string }>) => list.map((pool) => pool.driver);

describe("rubatoUsageLayout", () => {
  it("puts providers in the saved order and new ones after it", () => {
    expect(drivers(arrangePools(pools("codex", "grok", "claudeAgent", "cursor"), ["claudeAgent", "codex"])))
      .toEqual(["claudeAgent", "codex", "grok", "cursor"]);
    expect(drivers(arrangePools(pools("codex", "grok"), []))).toEqual(["codex", "grok"]);
  });

  it("moves a provider one place among those on screen and keeps the hidden ones", () => {
    expect(moveDriver(["codex", "grok", "claudeAgent"], ["antigravity"], "claudeAgent", -1))
      .toEqual(["codex", "claudeAgent", "grok", "antigravity"]);
    expect(moveDriver(["codex", "grok"], ["grok", "codex"], "codex", -1)).toEqual(["grok", "codex"]);
  });

  it("folds and unfolds a provider", () => {
    expect(toggleCollapsed([], "grok")).toEqual(["grok"]);
    expect(toggleCollapsed(["grok", "cursor"], "grok")).toEqual(["cursor"]);
  });
});
