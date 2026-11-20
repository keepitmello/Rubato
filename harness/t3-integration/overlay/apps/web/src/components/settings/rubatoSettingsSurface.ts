// What Rubato changes about T3's settings pages, beyond the pages and sections
// it adds (settings-layout-edits.mjs): rows that configure something Rubato does
// not run show nowhere, and search results for them land where Rubato keeps
// that setting instead.
import type { SettingsSearchItem } from "./settingsSearch";

/**
 * Rows and sections no page shows (settingsLayout.tsx's SettingsRow and
 * SettingsSection return nothing for these ids).
 *
 * - T3's text generation for commits, PRs and review guides: the Rubato driver
 *   declines those requests and the main session writes commits and PRs. Rubato
 *   titles sessions with its own models (Threads > Titles and summaries).
 *   Source control's "Commits & pull requests" section holds only these rows.
 * - T3's project sort select: the project list on Settings > Projects is the
 *   order every surface uses (project-order-edits.mjs).
 * - T3's CLI command row: it sat in T3's version section, which Rubato's About
 *   section replaces (about-edits.mjs).
 */
export const RUBATO_HIDDEN_SETTINGS: ReadonlySet<string> = new Set([
  "source-control-text-generation",
  "text-generation-model",
  "source-control-writer-model",
  "source-control-writing-style",
  "follow-change-request-templates",
  "review-guides",
  "review-guide-model",
  "review-guide-instructions",
  "project-order",
  "cli-command",
]);

/** Section id of the project list (RubatoProjectListSettings.tsx). */
export const RUBATO_PROJECT_LIST_ANCHOR = "rubato-project-list";

/**
 * Search results left out though their row still shows: T3's own Scheduled
 * tasks page keeps its route, but the sidebar and search offer only Rubato's
 * Scheduled Tasks (schedule-edits.mjs).
 */
const RUBATO_UNLISTED_SEARCH_RESULTS: ReadonlySet<string> = new Set(["scheduled-tasks"]);

/**
 * Search results whose row Rubato draws elsewhere, kept in search even when
 * T3's row is hidden: the project order is the project list, and T3's version
 * rows are Rubato's About section (about-edits.mjs).
 */
const RUBATO_SEARCH_TARGETS: Readonly<
  Record<string, Pick<SettingsSearchItem, "to" | "targetId">>
> = {
  "project-order": { to: "/settings/projects", targetId: RUBATO_PROJECT_LIST_ANCHOR },
  "app-version": { to: "/settings/about", targetId: "rubato-about" },
  "update-track": { to: "/settings/about", targetId: "rubato-about" },
};

function rubatoSearchItem<Item extends SettingsSearchItem>(item: Item): Item {
  const target = RUBATO_SEARCH_TARGETS[item.id];
  return target ? { ...item, ...target } : item;
}

const cache = new WeakMap<ReadonlyArray<SettingsSearchItem>, ReadonlyArray<SettingsSearchItem>>();

/**
 * Search without the hidden rows, sent to where Rubato keeps a setting. T3
 * caches the filtered list, so the result is cached per list to keep its identity.
 */
export function rubatoSettingsSearchItems(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const cached = cache.get(items);
  if (cached) return cached;
  const result = items
    .filter(
      (item) =>
        item.id in RUBATO_SEARCH_TARGETS ||
        (!RUBATO_HIDDEN_SETTINGS.has(item.id) &&
          !RUBATO_HIDDEN_SETTINGS.has(item.targetId ?? item.id) &&
          !RUBATO_UNLISTED_SEARCH_RESULTS.has(item.id)),
    )
    .map(rubatoSearchItem);
  cache.set(items, result);
  return result;
}

/** Results that live on the project list page: the order and the new-thread screen's project row. */
const PROJECT_LIST_RESULTS: ReadonlySet<string> = new Set(["project-order", "rubato-home-projects"]);

/**
 * A result that lands on the project list. The list shows only while no
 * project is chosen, so the navigation leaves the chosen project behind.
 */
export function rubatoOpensProjectList(item: SettingsSearchItem): boolean {
  return item.to === "/settings/projects" && PROJECT_LIST_RESULTS.has(item.id);
}
