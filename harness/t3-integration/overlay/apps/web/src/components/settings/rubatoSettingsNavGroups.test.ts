import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_GROUPS } from "./settingsSearch";
import { rubatoSettingsNavGroups, type SettingsNavGroup } from "./rubatoSettingsNavGroups";

describe("the settings menu in Rubato's groups", () => {
  it("lists App, Work and Tools, then the pages without a heading, in v0.1.0's order", () => {
    expect(SETTINGS_NAV_GROUPS.map((group) => group.paths)).toEqual([
      ["/settings/general", "/settings/appearance", "/settings/keybindings", "/settings/voice"],
      ["/settings/companion", "/settings/providers", "/settings/chat", "/settings/diffs", "/settings/threads",
        "/settings/projects", "/settings/source-control", "/settings/worktrees"],
      ["/settings/browser", "/settings/devices", "/settings/snap-shot", "/settings/connections", "/settings/phone",
        "/settings/access"],
      ["/settings/maintenance", "/settings/labs", "/settings/stats", "/settings/about", "/settings/archived"],
    ]);
    expect(SETTINGS_NAV_GROUPS.at(-1)?.headingHidden).toBe(true);
  });

  it("puts a page T3 adds later in the last group and leaves out one it drops", () => {
    const upstream = [
      { heading: "A", paths: ["/settings/general", "/settings/new-page"] },
      { heading: "B", paths: ["/settings/archived"] },
    ] as unknown as ReadonlyArray<SettingsNavGroup>;
    expect(rubatoSettingsNavGroups(upstream).map((group) => group.paths)).toEqual([
      ["/settings/general"],
      ["/settings/archived", "/settings/new-page"],
    ]);
  });
});
