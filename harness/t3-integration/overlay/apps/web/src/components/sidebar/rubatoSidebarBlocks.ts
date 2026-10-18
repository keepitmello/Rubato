// The sidebar's sections in the user's order (sidebar-blocks-edits.mjs). The
// thread list is five blocks: Recent (all projects), the narrowed project's
// threads (its title, pins and inbox), Working, Snoozed and Settled. Dragging a
// block's header moves the block (RubatoSidebarBlockDrag.tsx); the order is a
// client setting, so each device keeps its own.
//
// T3's list is one sortable list whose markers split it into sections, and its
// drag code read those sections top-down in one fixed order. These helpers read
// the order off the markers instead, so dragging a thread still lands where the
// gap opens whatever order the blocks are in. Pure functions only.
import type { SidebarListItem, SidebarListMarker, SidebarSection } from "../Sidebar.logic";

export type RubatoSidebarBlock = "recent" | "threads" | "working" | "snoozed" | "settled";

/** The order before the user moves anything: everything across projects first, then this project. */
export const DEFAULT_SIDEBAR_BLOCK_ORDER: readonly RubatoSidebarBlock[] = [
  "recent",
  "threads",
  "working",
  "snoozed",
  "settled",
];

/** Recent rows when the user has not picked a number, and the range they can pick from. */
export const RECENT_LIMIT_DEFAULT = 5;
export const RECENT_LIMIT_MIN = 1;
export const RECENT_LIMIT_MAX = 15;

export function clampRecentLimit(value: number): number {
  if (!Number.isFinite(value)) return RECENT_LIMIT_DEFAULT;
  return Math.min(RECENT_LIMIT_MAX, Math.max(RECENT_LIMIT_MIN, Math.round(value)));
}

const isBlock = (value: string): value is RubatoSidebarBlock =>
  (DEFAULT_SIDEBAR_BLOCK_ORDER as readonly string[]).includes(value);

/**
 * The order to show from what was stored: unknown ids and repeats drop, and a
 * block the stored order lacks (an empty setting, or a block added later)
 * takes its default place after the block it follows by default.
 */
export function resolveSidebarBlockOrder(
  stored: readonly string[] | null | undefined,
): RubatoSidebarBlock[] {
  const order: RubatoSidebarBlock[] = [];
  for (const id of stored ?? []) if (isBlock(id) && !order.includes(id)) order.push(id);
  for (const [index, block] of DEFAULT_SIDEBAR_BLOCK_ORDER.entries()) {
    if (order.includes(block)) continue;
    const before = DEFAULT_SIDEBAR_BLOCK_ORDER.slice(0, index).findLast((id) => order.includes(id));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, block);
  }
  return order;
}

export function isDefaultSidebarBlockOrder(order: readonly RubatoSidebarBlock[]): boolean {
  return order.every((block, index) => block === DEFAULT_SIDEBAR_BLOCK_ORDER[index]);
}

/** `block` moved to just before `before`, or to the end when `before` is null. */
export function moveSidebarBlock(
  order: readonly RubatoSidebarBlock[],
  block: RubatoSidebarBlock,
  before: RubatoSidebarBlock | null,
): RubatoSidebarBlock[] {
  if (block === before) return [...order];
  const next = order.filter((id) => id !== block);
  const at = before === null ? -1 : next.indexOf(before);
  next.splice(at === -1 ? next.length : at, 0, block);
  return next;
}

/** The block a marker opens, or null for a marker inside a block (the pinned divider, placeholders). */
export function blockOfMarker(marker: SidebarListMarker): RubatoSidebarBlock | null {
  switch (marker) {
    case "rubato-recent":
      return "recent";
    case "rubato-title":
    case "pinned-header":
      return "threads";
    case "working-header":
      return "working";
    case "snoozed-header":
      return "snoozed";
    case "settled-header":
      return "settled";
    default:
      return null;
  }
}

export interface SidebarBlockHead {
  readonly block: RubatoSidebarBlock;
  /** The block's first marker: the one its rows sit under. */
  readonly marker: SidebarListMarker;
}

/** The blocks present in the list, in the order the list shows them. */
export function sidebarBlockHeads(items: readonly SidebarListItem[]): SidebarBlockHead[] {
  const heads: SidebarBlockHead[] = [];
  for (const item of items) {
    if (item.kind !== "marker") continue;
    const block = blockOfMarker(item.marker);
    if (block !== null && !heads.some((head) => head.block === block)) {
      heads.push({ block, marker: item.marker });
    }
  }
  return heads;
}

/**
 * The list T3 builds, block by block in `order`. A shelf with no threads is
 * left out, as T3 leaves it out; Settled always has its header, the drop
 * target for settling.
 */
export function buildSidebarBlockItems(input: {
  readonly order: readonly RubatoSidebarBlock[];
  readonly recent: boolean;
  readonly title: boolean;
  readonly pinned: readonly SidebarListItem[];
  readonly active: readonly SidebarListItem[];
  /** Null when the shelf has no threads. */
  readonly working: readonly SidebarListItem[] | null;
  readonly snoozed: readonly SidebarListItem[] | null;
  readonly settled: readonly SidebarListItem[];
  readonly settledMore: boolean;
}): SidebarListItem[] {
  const items: SidebarListItem[] = [];
  const marker = (name: SidebarListMarker) => items.push({ kind: "marker", marker: name });
  for (const block of input.order) {
    switch (block) {
      case "recent":
        if (input.recent) marker("rubato-recent");
        break;
      case "threads":
        if (input.title) marker("rubato-title");
        marker("pinned-header");
        items.push(...input.pinned);
        marker("pinned-divider");
        marker("active-placeholder");
        items.push(...input.active);
        break;
      case "working":
        if (input.working !== null) {
          marker("working-header");
          items.push(...input.working);
        }
        break;
      case "snoozed":
        if (input.snoozed !== null) {
          marker("snoozed-header");
          items.push(...input.snoozed);
        }
        break;
      case "settled":
        marker("settled-header");
        marker("settled-placeholder");
        items.push(...input.settled);
        if (input.settledMore) marker("rubato-settled-more");
        break;
    }
  }
  return items;
}

/** The section a marker starts, null for Recent (no thread lands there), undefined when it starts none. */
function sectionOpenedBy(marker: SidebarListMarker): SidebarSection | null | undefined {
  switch (marker) {
    case "rubato-recent":
      return null;
    // The title heads the pins: a gap between the two is the top of the pins.
    case "rubato-title":
    case "pinned-header":
      return "pinned";
    case "pinned-divider":
      return "active";
    case "working-header":
      return "working";
    case "snoozed-header":
      return "snoozed";
    case "settled-header":
      return "settled";
    default:
      return undefined;
  }
}

/** Above the first block: the section that block opens, as the top of T3's list is the pins. */
function leadingSection(items: readonly SidebarListItem[]): SidebarSection | null {
  const first = items.find((item) => item.kind === "marker" && sectionOpenedBy(item.marker) !== undefined);
  if (first?.kind !== "marker") return "pinned";
  return sectionOpenedBy(first.marker) as SidebarSection | null;
}

/**
 * The section a slot belongs to, read off the markers above it: each marker
 * that opens a section rules until the next one. Null inside Recent.
 */
export function sectionAtSidebarBlockSlot(
  items: readonly SidebarListItem[],
  index: number,
): SidebarSection | null {
  let section = leadingSection(items);
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    const opened = sectionOpenedBy(item.marker);
    if (opened !== undefined) section = opened;
  }
  return section;
}

/** The pinned and inbox rows in list order, wherever the project's block sits. */
export function collectSidebarInboxOrders(items: readonly SidebarListItem[]): {
  pinnedOrder: string[];
  activeOrder: string[];
} {
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let section = leadingSection(items);
  for (const item of items) {
    if (item.kind === "marker") {
      const opened = sectionOpenedBy(item.marker);
      if (opened !== undefined) section = opened;
    } else if (section === "pinned") pinnedOrder.push(item.key);
    else if (section === "active") activeOrder.push(item.key);
  }
  return { pinnedOrder, activeOrder };
}

/**
 * The marker that takes the free space: the head of the first block after the
 * project's threads, so the blocks above them sit at the top and the blocks
 * below them at the bottom, as T3's shelves do. Null when the threads come last.
 */
export function sidebarSpacerMarker(items: readonly SidebarListItem[]): SidebarListMarker | null {
  const heads = sidebarBlockHeads(items);
  const threads = heads.findIndex((head) => head.block === "threads");
  return threads === -1 ? null : (heads[threads + 1]?.marker ?? null);
}

/**
 * For the drag preview, which may drop a shelf the lifted row empties: true
 * for each block head after the project's threads, so the first one the
 * preview still draws takes the free space.
 */
export function createSidebarSpacerTest(): (item: SidebarListItem) => boolean {
  let afterThreads = false;
  return (item) => {
    if (item.kind !== "marker") return false;
    const block = blockOfMarker(item.marker);
    if (block === null) return false;
    if (block === "threads") {
      afterThreads = true;
      return false;
    }
    return afterThreads;
  };
}

/** The heads of the blocks below the project's threads, nearest first: where the inbox ends. */
export function sidebarHeadsAfterThreads(items: readonly SidebarListItem[]): SidebarListMarker[] {
  const heads = sidebarBlockHeads(items);
  const threads = heads.findIndex((head) => head.block === "threads");
  return threads === -1 ? [] : heads.slice(threads + 1).map((head) => head.marker);
}

/** The marker that opens the project's threads: its title when shown, else the pins' top boundary. */
export function sidebarThreadsHead(items: readonly SidebarListItem[]): SidebarListMarker | null {
  return sidebarBlockHeads(items).find((head) => head.block === "threads")?.marker ?? null;
}

/**
 * The drag preview's blocks in list order. `emit` draws one block from the
 * preview's own groups; Recent and the title are drawn here, as they hold no rows.
 */
export function emitSidebarBlocks(
  items: readonly SidebarListItem[],
  emit: {
    readonly marker: (marker: SidebarListMarker) => void;
    readonly threads: () => void;
    readonly working: () => void;
    readonly snoozed: () => void;
    readonly settled: () => void;
  },
): void {
  const has = (marker: SidebarListMarker) =>
    items.some((item) => item.kind === "marker" && item.marker === marker);
  for (const head of sidebarBlockHeads(items)) {
    switch (head.block) {
      case "recent":
        emit.marker("rubato-recent");
        break;
      case "threads":
        if (has("rubato-title")) emit.marker("rubato-title");
        emit.threads();
        break;
      case "working":
        emit.working();
        break;
      case "snoozed":
        emit.snoozed();
        break;
      case "settled":
        emit.settled();
        if (has("rubato-settled-more")) emit.marker("rubato-settled-more");
        break;
    }
  }
}

/** Where the drop indicator goes: the gap nearest the pointer, as the block to insert before (null: the end). */
export function nearestSidebarBlockGap(
  blocks: ReadonlyArray<{ readonly block: RubatoSidebarBlock; readonly top: number; readonly bottom: number }>,
  dragged: RubatoSidebarBlock,
  pointerY: number,
): { before: RubatoSidebarBlock | null; y: number } | null {
  const others = blocks.filter((entry) => entry.block !== dragged);
  if (others.length === 0) return null;
  const gaps = [
    ...others.map((entry) => ({ before: entry.block as RubatoSidebarBlock | null, y: entry.top })),
    { before: null, y: others.at(-1)!.bottom },
  ];
  return gaps.reduce((best, gap) =>
    Math.abs(gap.y - pointerY) < Math.abs(best.y - pointerY) ? gap : best,
  );
}

/** The blocks, by the data-testid each block's first list item carries (`sidebar-<marker>`). */
export const SIDEBAR_BLOCK_HEAD_TEST_IDS: ReadonlyArray<readonly [string, RubatoSidebarBlock]> = [
  ["sidebar-rubato-recent", "recent"],
  ["sidebar-rubato-title", "threads"],
  ["sidebar-pinned-header", "threads"],
  ["sidebar-working-header", "working"],
  ["sidebar-snoozed-header", "snoozed"],
  ["sidebar-settled-header", "settled"],
];
