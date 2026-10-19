// Rubato's Settings layout (settings-layout-edits.mjs): which page each setting
// lives on. T3's panels stay as they are; a Rubato page renders them inside a
// block, and the block decides which of their rows and sections show
// (rubatoSettingsBlock.tsx). Moving a setting is a change to this table only.
import type { SettingsPath, SettingsSearchItem } from "./settingsSearch";

/**
 * Components a block can draw from; RubatoSettingsPage.tsx maps them. General
 * already holds the project defaults (model, permissions, workspace, submodules).
 */
export type RubatoSettingsSource =
  | "general"
  | "storage"
  | "sourceControl"
  | "integrations"
  | "connections"
  | "phone"
  | "about"
  | "homeProjects"
  | "sidebarSections"
  | "titleModels"
  | "voice"
  | "permissionsLink";

export interface RubatoSettingsBlock {
  readonly key: string;
  /** Our own section heading. Without one, the sources keep their own sections. */
  readonly title?: string;
  /** DOM id of our section, for search results that point at the block. */
  readonly anchor?: string;
  /**
   * Pick only these rows (row id, or a settings key for rows without an id).
   * The sources' own sections then give up their heading and card.
   */
  readonly rows?: readonly string[];
  /** With whole sources: show only these top-level sections. */
  readonly sections?: readonly string[];
  /** Rows inside those sections that search can land on. */
  readonly sectionRows?: readonly string[];
  readonly sources: readonly RubatoSettingsSource[];
}

export type RubatoSettingsGroup = "App" | "Work" | "Tools" | "More";

export interface RubatoSettingsPage {
  readonly path: SettingsPath;
  readonly label: string;
  readonly group: RubatoSettingsGroup;
  /** Absent: T3's own page for this path, unchanged. */
  readonly blocks?: readonly RubatoSettingsBlock[];
}

/** The sidebar, in order. */
export const RUBATO_SETTINGS_PAGES: readonly RubatoSettingsPage[] = [
  {
    path: "/settings/general",
    label: "General",
    group: "App",
    blocks: [
      {
        key: "app",
        title: "App",
        rows: [
          "time-format",
          "continue-threads-after-server-update",
          "background-activity",
          "quit-confirmation",
        ],
        sources: ["general"],
      },
      { key: "permissions", title: "macOS permissions", sources: ["permissionsLink"] },
      { key: "updates", title: "Updates", anchor: "about", sources: ["about"] },
    ],
  },
  { path: "/settings/appearance", label: "Appearance", group: "App" },
  {
    path: "/settings/notifications",
    label: "Notifications & Sounds",
    group: "App",
    blocks: [
      {
        key: "notifications",
        title: "Notifications",
        rows: ["thread-notifications", "in-app-notifications"],
        sources: ["general"],
      },
      {
        key: "sounds",
        title: "Sounds",
        rows: ["notification-completion-sound", "notification-input-sound"],
        sources: ["general"],
      },
    ],
  },
  { path: "/settings/keybindings", label: "Keybindings", group: "App" },
  {
    path: "/settings/agents",
    label: "Agents",
    group: "Work",
    blocks: [
      {
        key: "defaults",
        title: "New threads",
        anchor: "project-defaults",
        rows: ["default-model", "default-permissions"],
        sources: ["general"],
      },
      // Rubato's own section: the models that write session titles and summaries.
      { key: "titles", sources: ["titleModels"] },
      {
        key: "usage-limits",
        title: "Usage limits",
        rows: ["auto-resume-limited-threads", "snooze-limited-threads"],
        sources: ["general"],
      },
      {
        key: "provider-clis",
        title: "Provider CLIs",
        rows: ["provider-update-checks"],
        sources: ["general"],
      },
    ],
  },
  { path: "/settings/providers", label: "Providers", group: "Work" },
  {
    path: "/settings/chat",
    label: "Chat",
    group: "Work",
    blocks: [
      {
        key: "composer",
        title: "Composer",
        rows: [
          "skills-in-slash-menu",
          "composer-rich-text",
          "composer-collapse",
          "send-shortcut",
          "follow-up-behavior",
        ],
        sources: ["general"],
      },
      {
        key: "conversation",
        title: "Conversation",
        rows: ["response-streaming", "proactive-panels"],
        sources: ["general"],
      },
      {
        key: "diffs",
        title: "Diffs",
        rows: ["hide-whitespace-changes", "default-diff-file-state", "diff-layout"],
        sources: ["general"],
      },
      // Rubato's own section: the composer microphone's key and model (voice-edits.mjs).
      { key: "voice", sources: ["voice"] },
    ],
  },
  {
    path: "/settings/threads",
    label: "Threads & Projects",
    group: "Work",
    blocks: [
      {
        key: "starting",
        title: "Starting work",
        rows: ["new-threads", "add-project-starts-in", "rubato-home-projects"],
        sources: ["general", "homeProjects"],
      },
      {
        key: "sidebar",
        title: "Sidebar",
        rows: [
          "project-grouping",
          "project-order",
          "working-shelf",
          "rubato-recent-limit",
          "rubato-sidebar-blocks",
        ],
        sources: ["general", "sidebarSections"],
      },
      {
        key: "auto-settle",
        title: "Auto-settle",
        rows: [
          "auto-settle-merged-threads",
          "auto-settle-inactive-threads",
          // These two rows have no id.
          "sidebarAutoSettleAfterDays",
          "sidebarAutoSettleKeepPullRequests",
        ],
        sources: ["general"],
      },
      {
        key: "confirmations",
        title: "Confirmations",
        anchor: "confirmations",
        rows: ["unpin-confirmation", "archive-confirmation", "delete-confirmation"],
        sources: ["general"],
      },
    ],
  },
  {
    path: "/settings/source-control",
    label: "Git & Worktrees",
    group: "Work",
    blocks: [
      {
        key: "new-worktrees",
        title: "New worktrees",
        rows: ["start-from-origin", "worktree-submodules"],
        sources: ["general"],
      },
      {
        key: "worktrees",
        sections: ["storage-worktrees"],
        sectionRows: ["storage-worktrees-location"],
        sources: ["storage"],
      },
      { key: "source-control", sources: ["sourceControl"] },
      {
        key: "links",
        title: "Pull request links",
        rows: ["pull-request-links-open-in-app"],
        sources: ["integrations"],
      },
    ],
  },
  {
    path: "/settings/integrations",
    label: "Browser & Devices",
    group: "Tools",
    blocks: [{ key: "integrations", sources: ["integrations"] }],
  },
  { path: "/settings/snap-shot", label: "SnapShots", group: "Tools" },
  {
    path: "/settings/connections",
    label: "Connections",
    group: "Tools",
    blocks: [
      { key: "connections", sources: ["connections"] },
      { key: "phone", sources: ["phone"] },
    ],
  },
  {
    path: "/settings/advanced",
    label: "Advanced",
    group: "More",
    blocks: [
      { key: "storage", sections: ["storage-artifacts", "storage-cleanup"], sources: ["storage"] },
      {
        key: "diagnostics",
        title: "Diagnostics",
        rows: ["diagnostics"],
        sources: ["general"],
      },
      // General's own fold, whole.
      {
        key: "legacy",
        sections: ["legacy-features"],
        sectionRows: ["legacy-plan-mode", "legacy-context-window-indicator", "legacy-sidebar"],
        sources: ["general"],
      },
      {
        key: "legal",
        title: "Legal",
        rows: ["privacy-policy", "open-source-licenses"],
        sources: ["general"],
      },
      // Rows T3 adds to General before this table places them (RUBATO_FALLBACK_BLOCK).
      { key: "other", title: "Other", rows: [], sources: ["general"] },
    ],
  },
  // Opens the rail's Stats page (routes/settings.stats.tsx).
  { path: "/settings/stats", label: "Stats", group: "More" },
  { path: "/settings/archived", label: "Archive", group: "More" },
];

/**
 * Rows no page shows. They configure T3's text generation (commit messages,
 * PR text, generated branch names, thread titles, review guides), which the
 * Rubato driver declines: the main session writes commits and PRs, and Rubato
 * titles sessions with its own models (Agents > Titles and summaries).
 */
export const RUBATO_HIDDEN_ROWS: readonly string[] = [
  "text-generation-model",
  "source-control-writer-model",
  "source-control-writing-style",
  "follow-change-request-templates",
  "review-guides",
  "review-guide-model",
  "review-guide-instructions",
];

/** T3 section headings renamed on a Rubato page, by section id. */
export const RUBATO_SECTION_TITLES: Readonly<Record<string, string>> = {
  // With the writer rows hidden, only branch naming is left in it.
  "source-control-text-generation": "Branch names",
};

/** Pages Rubato adds; each has a route file of its own. */
export const RUBATO_ADDED_SETTINGS_PATHS = [
  "/settings/notifications",
  "/settings/agents",
  "/settings/chat",
  "/settings/threads",
  "/settings/advanced",
] as const satisfies readonly SettingsPath[];

/** T3 pages folded into another one; their routes forward there. */
export const RUBATO_FOLDED_SETTINGS_PATHS: Readonly<Partial<Record<SettingsPath, SettingsPath>>> = {
  "/settings/storage": "/settings/advanced",
  "/settings/phone": "/settings/connections",
};

/** Pages off the sidebar that open from a row; the sidebar marks this page while they are open. */
export const RUBATO_SETTINGS_DETAIL_PAGES: Readonly<Partial<Record<string, SettingsPath>>> = {
  "/settings/permissions": "/settings/general",
  "/settings/open-source-licenses": "/settings/advanced",
  "/settings/diagnostics": "/settings/advanced",
};

/**
 * Search results without a row of their own: they land on a block's anchor.
 * The version and update rows are Rubato's update section, which has no row ids.
 */
const SEARCH_ALIASES: Readonly<Record<string, string>> = {
  "app-version": "general/updates",
  "update-track": "general/updates",
  "project-defaults": "agents/defaults",
};

/** Search results with no row in Rubato: T3's version section is replaced by Rubato's. */
export const RUBATO_UNRENDERED_SEARCH_IDS: ReadonlySet<string> = new Set(["cli-command"]);

/** Where a General row with no place in the table shows until it gets one. */
export const RUBATO_FALLBACK_BLOCK = "advanced/other";

export function rubatoBlockId(page: RubatoSettingsPage, block: RubatoSettingsBlock): string {
  return `${page.path.replace("/settings/", "")}/${block.key}`;
}

const HIDDEN_BLOCK = "hidden";

/** Row id or settings key → the block that picks it, or HIDDEN_BLOCK. */
export const RUBATO_PLACED_ROWS: ReadonlyMap<string, string> = new Map([
  ...RUBATO_SETTINGS_PAGES.flatMap((page) =>
    (page.blocks ?? []).flatMap((block) =>
      (block.rows ?? []).map((row) => [row, rubatoBlockId(page, block)] as const),
    ),
  ),
  ...RUBATO_HIDDEN_ROWS.map((row) => [row, HIDDEN_BLOCK] as const),
]);

/** Section id, or a row inside it → the block that shows it. */
const PLACED_SECTIONS: ReadonlyMap<string, string> = new Map(
  RUBATO_SETTINGS_PAGES.flatMap((page) =>
    (page.blocks ?? []).flatMap((block) =>
      [...(block.sections ?? []), ...(block.sectionRows ?? [])].map(
        (anchor) => [anchor, rubatoBlockId(page, block)] as const,
      ),
    ),
  ),
);

const BLOCKS_BY_ID: ReadonlyMap<string, { page: RubatoSettingsPage; block: RubatoSettingsBlock }> =
  new Map(
    RUBATO_SETTINGS_PAGES.flatMap((page) =>
      (page.blocks ?? []).map((block) => [rubatoBlockId(page, block), { page, block }] as const),
    ),
  );

const pathOfBlock = (blockId: string): SettingsPath =>
  blockId === RUBATO_FALLBACK_BLOCK
    ? "/settings/advanced"
    : (BLOCKS_BY_ID.get(blockId)?.page.path ?? "/settings/advanced");

/** General rows search knows about that the table has not placed yet. */
export function unplacedGeneralRows(items: readonly SettingsSearchItem[]): string[] {
  return items.flatMap((item) => {
    if (item.to !== "/settings/general") return [];
    const anchor = item.targetId ?? item.id;
    if (RUBATO_PLACED_ROWS.has(anchor) || PLACED_SECTIONS.has(anchor) || anchor in SEARCH_ALIASES) {
      return [];
    }
    if (RUBATO_UNRENDERED_SEARCH_IDS.has(item.id)) return [];
    return [anchor];
  });
}

/** A search result, sent to the page and anchor its setting has in Rubato's layout. */
export function rubatoSearchItem<Item extends SettingsSearchItem>(item: Item): Item {
  const anchor = item.targetId ?? item.id;
  const alias = SEARCH_ALIASES[item.id];
  if (alias !== undefined) {
    const target = BLOCKS_BY_ID.get(alias);
    return {
      ...item,
      to: pathOfBlock(alias),
      ...(target?.block.anchor ? { targetId: target.block.anchor } : {}),
    };
  }
  const block = RUBATO_PLACED_ROWS.get(anchor) ?? PLACED_SECTIONS.get(anchor);
  if (block !== undefined) return { ...item, to: pathOfBlock(block) };
  if (item.to === "/settings/general") return { ...item, to: pathOfBlock(RUBATO_FALLBACK_BLOCK) };
  const folded = RUBATO_FOLDED_SETTINGS_PATHS[item.to];
  return folded ? { ...item, to: folded } : item;
}

/** Search, minus results that have no row to land on. */
export function rubatoSearchItems<Item extends SettingsSearchItem>(items: readonly Item[]): Item[] {
  return items
    .filter(
      (item) =>
        !RUBATO_UNRENDERED_SEARCH_IDS.has(item.id) &&
        RUBATO_PLACED_ROWS.get(item.id) !== HIDDEN_BLOCK &&
        RUBATO_PLACED_ROWS.get(item.targetId ?? item.id) !== HIDDEN_BLOCK,
    )
    .map(rubatoSearchItem);
}

/** What a block shows of the panels inside it. */
export interface RubatoSettingsFilter {
  readonly block: string;
  /** Pick mode: these rows only. */
  readonly rows?: ReadonlySet<string>;
  /** Whole mode: these top-level sections only. */
  readonly sections?: ReadonlySet<string>;
}

export type RubatoSectionMode = "hidden" | "unwrapped" | { readonly inner: RubatoSettingsFilter };

export function rubatoSectionMode(
  filter: RubatoSettingsFilter,
  sectionId: string | undefined,
): RubatoSectionMode {
  if (filter.rows) return "unwrapped";
  if (!filter.sections) return { inner: filter };
  if (sectionId !== undefined && filter.sections.has(sectionId)) return { inner: { block: filter.block } };
  return "hidden";
}

export function rubatoRowVisible(
  filter: RubatoSettingsFilter,
  rowId: string | undefined,
  settingKeys: readonly string[],
): boolean {
  const keys = rowId === undefined ? settingKeys : [rowId, ...settingKeys];
  if (filter.rows) return keys.some((key) => filter.rows!.has(key));
  // A whole panel leaves out the rows another block picks.
  return !keys.some((key) => RUBATO_PLACED_ROWS.has(key));
}

export function rubatoBlockFilter(
  page: RubatoSettingsPage,
  block: RubatoSettingsBlock,
  fallbackRows: readonly string[] = [],
): RubatoSettingsFilter {
  const id = rubatoBlockId(page, block);
  return {
    block: id,
    ...(block.rows ? { rows: new Set(id === RUBATO_FALLBACK_BLOCK ? fallbackRows : block.rows) } : {}),
    ...(block.sections ? { sections: new Set(block.sections) } : {}),
  };
}
