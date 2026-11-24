import { ProviderDriverKind } from "@t3tools/contracts";
import type { LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  EMPTY_USAGE_LAYOUT,
  hasWindowChoices,
  limitWindowChoices,
  moveWindow,
  parseUsageLayout,
  setWindowShown,
  visibleLimitWindows,
} from "@t3tools/shared/rubatoUsageLayout";
import { arrangePools, moveDriver, toggleCollapsed } from "./rubatoUsageLayout";

const pools = (...drivers: string[]) => drivers.map((driver) => ({ driver }));
const drivers = (list: ReadonlyArray<{ readonly driver: string }>) => list.map((pool) => pool.driver);

const window = (id: string, kind: LimitPoolWindow["kind"]): LimitPoolWindow => ({
  id, kind, label: id, members: [], columns: [], remainingPercent: 0, usedPercent: 100,
  pace: null, resets: [],
});
const ids = (list: ReadonlyArray<{ readonly id: string }>) => list.map((entry) => entry.id);

describe("rubatoUsageLayout", () => {
  it("shows Gemini's five-hour and weekly bars without restoring other session bars", () => {
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

  describe("a provider's windows", () => {
    const antigravity = {
      driver: ProviderDriverKind.make("antigravity"),
      accounts: [],
      windows: [window("gemini-5h", "session"), window("gemini-weekly", "weekly"), window("3p-weekly", "weekly")],
    };

    it("switches a window off and a hidden-by-default one on", () => {
      let layout = setWindowShown(EMPTY_USAGE_LAYOUT, "antigravity", "3p-weekly", false);
      layout = setWindowShown(layout, "antigravity", "gemini-5h", false);
      expect(ids(visibleLimitWindows(antigravity, layout))).toEqual(["gemini-weekly"]);
      expect(limitWindowChoices(antigravity, layout).map((choice) => [choice.window.id, choice.shown]))
        .toEqual([["gemini-5h", false], ["gemini-weekly", true], ["3p-weekly", false]]);

      const codex = {
        driver: ProviderDriverKind.make("codex"),
        accounts: [],
        windows: [window("primary", "session"), window("secondary", "weekly")],
      };
      expect(ids(visibleLimitWindows(codex, setWindowShown(layout, "codex", "primary", true))))
        .toEqual(["primary", "secondary"]);
    });

    it("keeps a provider whose windows were all switched off, so they can be switched back on", () => {
      expect(hasWindowChoices(EMPTY_USAGE_LAYOUT, "antigravity")).toBe(false);
      expect(hasWindowChoices(setWindowShown(EMPTY_USAGE_LAYOUT, "antigravity", "3p-weekly", false), "antigravity"))
        .toBe(true);
    });

    it("moves a window one place among those on screen and keeps a hidden one's place behind them", () => {
      const hidden = setWindowShown(EMPTY_USAGE_LAYOUT, "antigravity", "gemini-5h", false);
      const moved = moveWindow(hidden, "antigravity", ["gemini-weekly", "3p-weekly"], "3p-weekly", -1);
      expect(ids(visibleLimitWindows(antigravity, moved))).toEqual(["3p-weekly", "gemini-weekly"]);
      const shownAgain = setWindowShown(moved, "antigravity", "gemini-5h", true);
      expect(ids(visibleLimitWindows(antigravity, shownAgain))).toEqual(["3p-weekly", "gemini-weekly", "gemini-5h"]);
      expect(moveWindow(moved, "antigravity", ["3p-weekly", "gemini-weekly"], "3p-weekly", -1)).toEqual(moved);
    });
  });

  it("reads a stored arrangement, keeping what it can read", () => {
    expect(parseUsageLayout(undefined)).toBeUndefined();
    expect(parseUsageLayout({ order: ["codex"] })).toBeUndefined();
    expect(parseUsageLayout({ order: ["codex", 3], collapsed: [] })).toEqual({ order: ["codex"], collapsed: [] });
    expect(
      parseUsageLayout({
        order: [],
        collapsed: ["grok"],
        windows: { antigravity: { "gemini-5h": false, broken: "yes" }, bad: 1 },
        windowOrder: { antigravity: ["3p-weekly", 2], bad: "x" },
      }),
    ).toEqual({
      order: [],
      collapsed: ["grok"],
      windows: { antigravity: { "gemini-5h": false } },
      windowOrder: { antigravity: ["3p-weekly"] },
    });
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
