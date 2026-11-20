import { describe, expect, it } from "vite-plus/test";

import {
  RUBATO_HIDDEN_SETTINGS,
  RUBATO_PROJECT_LIST_ANCHOR,
  rubatoOpensProjectList,
  rubatoSettingsSearchItems,
} from "./rubatoSettingsSurface";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
const byId = (items: readonly SettingsSearchItem[], id: string) =>
  items.find((item) => item.id === id);
const navPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
const groupOf = (path: SettingsPath) =>
  SETTINGS_NAV_GROUPS.find((group) => group.paths.includes(path))?.paths;

describe("Rubato on T3's settings", () => {
  it("hides rows T3 still has", () => {
    // A pin bump that renames one of these rows fails here, and the row would show again.
    const rows = [...RUBATO_HIDDEN_SETTINGS].filter((id) => id !== "source-control-text-generation");
    expect(rows.filter((id) => byId(ITEMS, id) === undefined)).toEqual([]);
  });

  it("leaves hidden rows out of search", () => {
    const results = rubatoSettingsSearchItems(ITEMS);
    // The project order stays: its result opens the project list instead.
    expect(results.filter((item) => RUBATO_HIDDEN_SETTINGS.has(item.id)).map((item) => item.id)).toEqual([
      "project-order",
    ]);
    // T3's own Scheduled tasks page is left out of search too; Rubato's is the one offered.
    expect(byId(ITEMS, "scheduled-tasks")).toBeDefined();
    expect(byId(results, "scheduled-tasks")).toBeUndefined();
    expect(byId(results, "rubato-scheduled-tasks")).toBeDefined();
    expect(results.length).toBe(
      ITEMS.length -
        [...RUBATO_HIDDEN_SETTINGS, "scheduled-tasks"].filter((id) => id !== "project-order" && byId(ITEMS, id))
          .length,
    );
  });

  it("keeps the list's identity for the same input", () => {
    expect(rubatoSettingsSearchItems(ITEMS)).toBe(rubatoSettingsSearchItems(ITEMS));
  });

  it("sends version results to Rubato's About section", () => {
    const results = rubatoSettingsSearchItems([
      { id: "app-version", title: "Version", to: "/settings/about" },
      { id: "update-track", title: "Update track", to: "/settings/maintenance" },
    ]);
    expect(results.map((item) => [item.to, item.targetId])).toEqual([
      ["/settings/about", "rubato-about"],
      ["/settings/about", "rubato-about"],
    ]);
  });

  it("opens the project list for the project order and the new-thread screen's projects", () => {
    const order: SettingsSearchItem = { id: "project-order", title: "Project order", to: "/settings/general" };
    const [moved] = rubatoSettingsSearchItems([order]);
    expect(moved).toMatchObject({ to: "/settings/projects", targetId: RUBATO_PROJECT_LIST_ANCHOR });
    expect(rubatoOpensProjectList(moved!)).toBe(true);
    expect(rubatoOpensProjectList(byId(ITEMS, "rubato-home-projects")!)).toBe(true);
    // A project's own settings keep the chosen project.
    expect(rubatoOpensProjectList({ id: "project-actions", title: "Actions", to: "/settings/projects" })).toBe(
      false,
    );
  });

  it("puts Rubato's pages in T3's sidebar groups", () => {
    expect(groupOf("/settings/companion")).toContain("/settings/providers");
    expect(groupOf("/settings/phone")).toContain("/settings/connections");
    expect(groupOf("/settings/stats")).toContain("/settings/archived");
    // Opened from the rail or from General, not from the settings sidebar.
    for (const path of [
      "/settings/memory",
      "/settings/scheduled",
      "/settings/permissions",
      // T3's own page: the rail's Scheduled Tasks is Rubato's.
      "/settings/scheduled-tasks",
    ] as const) {
      expect(navPaths).not.toContain(path);
    }
  });

  it("lands each Rubato search result on a page that has its section", () => {
    const expected: Record<string, SettingsPath> = {
      "rubato-title-models": "/settings/threads",
      "rubato-voice": "/settings/voice",
      "rubato-recent-limit": "/settings/general",
      "rubato-sidebar-blocks": "/settings/general",
      "rubato-home-projects": "/settings/projects",
      "rubato-companion": "/settings/companion",
      "rubato-phone": "/settings/phone",
      "rubato-permissions": "/settings/permissions",
    };
    expect(Object.fromEntries(Object.keys(expected).map((id) => [id, byId(ITEMS, id)?.to]))).toEqual(expected);
  });
});
