import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  RUBATO_FOLDED_SETTINGS_PATHS,
  RUBATO_HIDDEN_ROWS,
  RUBATO_PLACED_ROWS,
  RUBATO_SETTINGS_DETAIL_PAGES,
  RUBATO_SETTINGS_PAGES,
  rubatoBlockFilter,
  rubatoRowVisible,
  rubatoSearchItem,
  rubatoSearchItems,
  rubatoSectionMode,
  unplacedGeneralRows,
} from "./rubatoSettingsLayout";
import { SETTINGS_SEARCH_ITEMS, type SettingsSearchItem } from "./settingsSearch";

const ITEMS: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
const anchors = new Set(ITEMS.map((item) => item.targetId ?? item.id));
// Row ids search knows: a result's own id, and the row it lands on.
const knownRows = new Set(ITEMS.flatMap((item) => [item.id, item.targetId ?? item.id]));
const byId = (id: string) => ITEMS.find((item) => item.id === id)!;

// Pages that open from the rail or from a row rather than from the sidebar.
const OFF_SIDEBAR = new Set([
  "/settings/projects",
  "/settings/memory",
  "/settings/scheduled",
  "/settings/scheduled-tasks",
  ...Object.keys(RUBATO_SETTINGS_DETAIL_PAGES),
]);

describe("Rubato settings layout", () => {
  it("places every General row T3 has, so none falls to Advanced > Other", () => {
    // A pin bump that adds a General row fails here: give it a block in the table.
    expect(unplacedGeneralRows(ITEMS)).toEqual([]);
  });

  it("places only rows that exist", () => {
    const unknown = [...RUBATO_PLACED_ROWS.keys()].filter(
      (key) => !knownRows.has(key) && !(key in DEFAULT_SERVER_SETTINGS),
    );
    expect(unknown).toEqual([]);
  });

  it("places each row once", () => {
    const rows = RUBATO_SETTINGS_PAGES.flatMap((page) =>
      (page.blocks ?? []).flatMap((block) => block.rows ?? []),
    );
    expect(rows.filter((row, index) => rows.indexOf(row) !== index)).toEqual([]);
  });

  it("sends every search result to a page that exists", () => {
    const pages = new Set(RUBATO_SETTINGS_PAGES.map((page) => page.path));
    const lost = rubatoSearchItems(ITEMS).filter(
      (item) => !pages.has(item.to) && !OFF_SIDEBAR.has(item.to),
    );
    expect(lost.map((item) => `${item.id} → ${item.to}`)).toEqual([]);
    const folded = new Set(Object.keys(RUBATO_FOLDED_SETTINGS_PATHS));
    expect(rubatoSearchItems(ITEMS).filter((item) => folded.has(item.to))).toEqual([]);
  });

  it("sends moved settings to their new page", () => {
    expect(rubatoSearchItem(byId("default-model")).to).toBe("/settings/agents");
    expect(rubatoSearchItem(byId("send-shortcut")).to).toBe("/settings/chat");
    expect(rubatoSearchItem(byId("days-before-auto-settle")).to).toBe("/settings/threads");
    expect(rubatoSearchItem(byId("storage-worktrees-location")).to).toBe(
      "/settings/source-control",
    );
    expect(rubatoSearchItem(byId("storage-delete-now")).to).toBe("/settings/advanced");
    expect(rubatoSearchItem(byId("rubato-phone")).to).toBe("/settings/connections");
    expect(rubatoSearchItem(byId("rubato-voice")).to).toBe("/settings/chat");
    expect(rubatoSearchItem(byId("theme")).to).toBe("/settings/appearance");
    expect(rubatoSearchItem(byId("app-version"))).toMatchObject({
      to: "/settings/general",
      targetId: "about",
    });
  });

  it("drops search results with no row to land on", () => {
    expect(rubatoSearchItems(ITEMS).some((item) => item.id === "cli-command")).toBe(false);
  });

  it("hides T3's text generation rows everywhere, search included", () => {
    const shown = new Set(rubatoSearchItems(ITEMS).map((item) => item.id));
    for (const id of RUBATO_HIDDEN_ROWS) {
      expect(knownRows.has(id)).toBe(true);
      expect(shown.has(id)).toBe(false);
    }
    expect(rubatoSearchItem(byId("rubato-title-models")).to).toBe("/settings/agents");
  });
});

describe("Rubato settings blocks", () => {
  const page = (path: string) => RUBATO_SETTINGS_PAGES.find((candidate) => candidate.path === path)!;
  const block = (path: string, key: string) =>
    rubatoBlockFilter(page(path), page(path).blocks!.find((candidate) => candidate.key === key)!);

  it("picks its rows and unwraps T3's sections around them", () => {
    const composer = block("/settings/chat", "composer");
    expect(rubatoRowVisible(composer, "send-shortcut", [])).toBe(true);
    expect(rubatoRowVisible(composer, "time-format", [])).toBe(false);
    expect(rubatoRowVisible(composer, undefined, [])).toBe(false);
    expect(rubatoSectionMode(composer, "behavior")).toBe("unwrapped");
  });

  it("finds a row without an id by its setting", () => {
    const autoSettle = block("/settings/threads", "auto-settle");
    expect(rubatoRowVisible(autoSettle, undefined, ["sidebarAutoSettleKeepPullRequests"])).toBe(
      true,
    );
  });

  it("draws a whole panel without the rows another block took", () => {
    const integrations = block("/settings/integrations", "integrations");
    expect(rubatoRowVisible(integrations, "browser-link-target", [])).toBe(true);
    expect(rubatoRowVisible(integrations, "pull-request-links-open-in-app", [])).toBe(false);
    expect(rubatoSectionMode(integrations, "browser")).toEqual({ inner: integrations });
  });

  it("leaves the hidden rows out of a whole panel", () => {
    const sourceControl = block("/settings/source-control", "source-control");
    expect(rubatoRowVisible(sourceControl, "source-control-writer-model", [])).toBe(false);
    expect(rubatoRowVisible(sourceControl, "worktree-branch-naming", [])).toBe(true);
  });

  it("draws only the named sections of a split panel", () => {
    const worktrees = block("/settings/source-control", "worktrees");
    expect(rubatoSectionMode(worktrees, "storage-worktrees")).toEqual({
      inner: { block: "source-control/worktrees" },
    });
    expect(rubatoSectionMode(worktrees, "storage-artifacts")).toBe("hidden");
  });
});
