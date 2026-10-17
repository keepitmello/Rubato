// Section sizes (section-scale-edits.mjs): seven parts of the sidebar, the home
// screen and the conversation each carry their own scale on top of the
// interface font size. A part is zoomed as a whole (rubatoSectionScale.css), so
// its text, icons and row heights keep their proportions.
//
// Scales are whole percents, 80–150 in steps of 10; 100 is the interface font
// size as it is. Only parts off 100 are stored, so a reset is a removal.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const SECTION_SCALE_MIN = 80;
export const SECTION_SCALE_MAX = 150;
export const SECTION_SCALE_STEP = 10;
export const SECTION_SCALE_DEFAULT = 100;

export const SECTION_SCALE_STORAGE_KEY = "rubato:section-scale:v1";

export type SectionPartId =
  | "rail"
  | "title"
  | "recent"
  | "cards"
  | "homeTabs"
  | "homeThreads"
  | "messages";

export interface SectionPart {
  readonly id: SectionPartId;
  /** What the notice and the Settings row call it. */
  readonly label: string;
  /** The part's root element; the pointer over it picks the part for the shortcut. */
  readonly selector: string;
}

/** In the order the window reads, left to right, top to bottom. */
export const SECTION_PARTS: readonly SectionPart[] = [
  { id: "rail", label: "Rail", selector: "[data-rubato-rail]" },
  { id: "title", label: "Project title", selector: "[data-rubato-scope-label]" },
  { id: "recent", label: "Recent", selector: "[data-rubato-recent]" },
  { id: "cards", label: "Thread cards", selector: '[data-rubato-section="cards"]' },
  { id: "homeTabs", label: "Home tabs", selector: '[data-rubato-section="home-tabs"]' },
  { id: "homeThreads", label: "Home threads", selector: '[data-rubato-section="home-threads"]' },
  { id: "messages", label: "Messages", selector: '[data-rubato-section="messages"]' },
];

export type SectionScales = Readonly<Record<SectionPartId, number>>;

export const DEFAULT_SECTION_SCALES: SectionScales = Object.fromEntries(
  SECTION_PARTS.map((part) => [part.id, SECTION_SCALE_DEFAULT]),
) as Record<SectionPartId, number>;

/** The nearest allowed scale: snapped to the step, held inside the range. */
export function clampSectionScale(percent: number): number {
  if (!Number.isFinite(percent)) return SECTION_SCALE_DEFAULT;
  const snapped = Math.round(percent / SECTION_SCALE_STEP) * SECTION_SCALE_STEP;
  return Math.min(SECTION_SCALE_MAX, Math.max(SECTION_SCALE_MIN, snapped));
}

export type SectionScaleCommand = "grow" | "shrink" | "reset";

export function applySectionScaleCommand(
  scales: SectionScales,
  part: SectionPartId,
  command: SectionScaleCommand,
): SectionScales {
  const current = scales[part];
  const next =
    command === "reset"
      ? SECTION_SCALE_DEFAULT
      : clampSectionScale(current + (command === "grow" ? 1 : -1) * SECTION_SCALE_STEP);
  return next === current ? scales : { ...scales, [part]: next };
}

export function setSectionScale(
  scales: SectionScales,
  part: SectionPartId,
  percent: number,
): SectionScales {
  const next = clampSectionScale(percent);
  return next === scales[part] ? scales : { ...scales, [part]: next };
}

/** What is stored: the parts off their default, by id. */
export const StoredSectionScales = Schema.Record(Schema.String, Schema.Number);
export type StoredSectionScales = typeof StoredSectionScales.Type;

/** Every part's scale from what was stored; unknown ids drop, odd values snap into range. */
export function sectionScalesFromStored(stored: StoredSectionScales | null): SectionScales {
  const scales: Record<SectionPartId, number> = { ...DEFAULT_SECTION_SCALES };
  if (stored === null) return scales;
  for (const part of SECTION_PARTS) {
    const value = stored[part.id];
    if (typeof value === "number") scales[part.id] = clampSectionScale(value);
  }
  return scales;
}

/** Only the parts off 100, or null when every part is at its default (nothing to keep). */
export function sectionScalesToStored(scales: SectionScales): StoredSectionScales | null {
  const stored: Record<string, number> = {};
  for (const part of SECTION_PARTS) {
    const value = clampSectionScale(scales[part.id]);
    if (value !== SECTION_SCALE_DEFAULT) stored[part.id] = value;
  }
  return Object.keys(stored).length === 0 ? null : stored;
}

const StoredSectionScalesJson = Schema.fromJsonString(StoredSectionScales);
const decodeStoredSectionScales = Schema.decodeUnknownOption(StoredSectionScalesJson);
const encodeStoredSectionScales = Schema.encodeSync(StoredSectionScalesJson);

/** The saved scales; a missing or unreadable entry reads as every part at 100. */
export function readSectionScales(storage: Pick<Storage, "getItem">): SectionScales {
  const raw = storage.getItem(SECTION_SCALE_STORAGE_KEY);
  if (raw === null) return DEFAULT_SECTION_SCALES;
  return sectionScalesFromStored(Option.getOrNull(decodeStoredSectionScales(raw)));
}

/** Saves the scales in the shape `readSectionScales` (and useLocalStorage) reads. */
export function writeSectionScales(
  storage: Pick<Storage, "setItem" | "removeItem">,
  scales: SectionScales,
): void {
  const stored = sectionScalesToStored(scales);
  if (stored === null) storage.removeItem(SECTION_SCALE_STORAGE_KEY);
  else storage.setItem(SECTION_SCALE_STORAGE_KEY, encodeStoredSectionScales(stored));
}

/** The custom property rubatoSectionScale.css reads for a part. */
export function sectionScaleVariable(part: SectionPartId): `--rubato-scale-${string}` {
  return `--rubato-scale-${part.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

export function sectionScaleVariables(scales: SectionScales): Record<string, string> {
  return Object.fromEntries(
    SECTION_PARTS.map((part) => [sectionScaleVariable(part.id), String(scales[part.id] / 100)]),
  );
}

export interface SectionScaleKey {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * Ctrl + / Ctrl − / Ctrl 0 on the Mac, where ⌘ +/- stays the window zoom.
 * Elsewhere Ctrl +/- is that window zoom, so the part shortcut adds Alt.
 * Shift is ignored: Ctrl + is Shift+= on most layouts.
 */
export function resolveSectionScaleCommand(
  event: SectionScaleKey,
  isMac: boolean,
): SectionScaleCommand | null {
  if (!event.ctrlKey || event.metaKey) return null;
  if (event.altKey !== !isMac) return null;
  // With Alt held, macOS-style layouts change `key`; the physical key still tells.
  if (
    event.key === "=" ||
    event.key === "+" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return "grow";
  }
  if (event.key === "-" || event.code === "Minus" || event.code === "NumpadSubtract")
    return "shrink";
  if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") return "reset";
  return null;
}

/** The part under the pointer: `isHovered` answers for one part's selector. */
export function resolveHoveredSectionPart(
  isHovered: (selector: string) => boolean,
): SectionPart | null {
  return SECTION_PARTS.find((part) => isHovered(part.selector)) ?? null;
}

export function sectionScaleNotice(part: SectionPart, percent: number): string {
  return `${part.label} ${percent}%`;
}
