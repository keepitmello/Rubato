import { ProviderDriverKind } from "@t3tools/contracts";
import type { LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { arrangePools, moveDriver, toggleCollapsed, visibleLimitWindows } from "./rubatoUsageLayout";

const pools = (...drivers: string[]) => drivers.map((driver) => ({ driver }));
const drivers = (list: ReadonlyArray<{ readonly driver: string }>) => list.map((pool) => pool.driver);

describe("rubatoUsageLayout", () => {
  it("shows Gemini's five-hour and weekly bars without restoring other session bars", () => {
    const window = (id: string, kind: LimitPoolWindow["kind"]): LimitPoolWindow => ({
      id, kind, label: id, members: [], columns: [], remainingPercent: 0, usedPercent: 100,
      pace: null, resets: [],
    });
    expect(visibleLimitWindows({
      driver: ProviderDriverKind.make("antigravity"),
      accounts: [],
      windows: [window("gemini-weekly", "weekly"), window("3p-5h", "session"), window("gemini-5h", "session")],
    }).map((entry) => entry.id)).toEqual(["gemini-5h", "gemini-weekly"]);
    expect(visibleLimitWindows({
      driver: ProviderDriverKind.make("codex"),
      accounts: [],
      windows: [window("primary", "session"), window("secondary", "weekly")],
    }).map((entry) => entry.id)).toEqual(["secondary"]);
  });

  it("puts providers in the saved order and new ones after it", () => {
    expect(drivers(arrangePools(pools("codex", "grok", "claudeAgent", "cursor"), ["claudeAgent", "codex"])))
      .toEqual(["claudeAgent", "codex", "grok", "cursor"]);
    expect(drivers(arrangePools(pools("codex", "grok"), []))).toEqual(["codex", "grok"]);
  });

  describe("on Hermes, where Array.prototype.toSorted does not exist", () => {
    const original = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    beforeEach(() => void Reflect.deleteProperty(Array.prototype, "toSorted"));
    afterEach(() => {
      if (original) Reflect.defineProperty(Array.prototype, "toSorted", original);
    });

    it("still arranges providers", () => {
      expect(drivers(arrangePools(pools("codex", "grok", "claudeAgent"), ["claudeAgent"])))
        .toEqual(["claudeAgent", "codex", "grok"]);
    });
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
