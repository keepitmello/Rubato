// Section sizes (section-scale-edits.mjs): the saved scales, the custom
// properties rubatoSectionScale.css zooms each part by, and the shortcut that
// changes the part under the pointer (Ctrl + / Ctrl − / Ctrl 0 on the Mac,
// Ctrl+Alt elsewhere) with a brief notice such as "Recent 110%".
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isMacPlatform } from "../../lib/utils";
import "../../rubatoSectionScale.css";
import {
  SECTION_SCALE_STORAGE_KEY,
  StoredSectionScales,
  applySectionScaleCommand,
  readSectionScales,
  resolveHoveredSectionPart,
  resolveSectionScaleCommand,
  sectionScaleNotice,
  sectionScaleVariables,
  sectionScalesFromStored,
  sectionScalesToStored,
  type SectionPartId,
  type SectionScales,
} from "./rubatoSectionScale.logic";

const StoredOrNone = Schema.NullOr(StoredSectionScales);
const NOTICE_MS = 1_200;
const NOTICE_GAP_PX = 8;
const NOTICE_HEIGHT_PX = 36;

function applySectionScaleVariables(scales: SectionScales) {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(sectionScaleVariables(scales))) {
    style.setProperty(name, value);
  }
}

// The first paint already has the saved sizes, before any component mounts.
if (typeof window !== "undefined") {
  try {
    applySectionScaleVariables(readSectionScales(window.localStorage));
  } catch {
    // No storage: every part stays at 100%.
  }
}

/** Every part's scale, and a setter that saves them (and so every reader follows). */
export function useSectionScales(): readonly [SectionScales, (next: SectionScales) => void] {
  const [stored, setStored] = useLocalStorage(SECTION_SCALE_STORAGE_KEY, null, StoredOrNone);
  const scales = useMemo(() => sectionScalesFromStored(stored), [stored]);
  useLayoutEffect(() => applySectionScaleVariables(scales), [scales]);
  const setScales = useCallback(
    (next: SectionScales) => setStored(sectionScalesToStored(next)),
    [setStored],
  );
  return [scales, setScales] as const;
}

/** One part's scale as a factor (1 = 100%), for code that converts pointer distances. */
export function useSectionScaleFactor(part: SectionPartId): number {
  return useSectionScales()[0][part] / 100;
}

interface Notice {
  readonly id: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Where the notice sits, so it covers a neighbor instead of the change it
 * reports: under the part, over it when the window ends first, and along its
 * top edge only when the part fills the window's height.
 */
function noticePoint(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const x = Math.min(Math.max((rect.left + rect.right) / 2, 72), window.innerWidth - 72);
  const below = rect.bottom + NOTICE_GAP_PX;
  if (below + NOTICE_HEIGHT_PX <= window.innerHeight) return { x, y: below };
  const above = rect.top - NOTICE_GAP_PX - NOTICE_HEIGHT_PX;
  return { x, y: above >= 0 ? above : Math.max(rect.top, 0) + NOTICE_GAP_PX };
}

/** Mounted once beside the app's sidebar: the shortcut and its notice. */
export function RubatoSectionScaleHost() {
  const [, setScales] = useSectionScales();
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const isMac = isMacPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveSectionScaleCommand(event, isMac);
      if (command === null) return;
      const hoveredRoot = (selector: string) => document.querySelector(`${selector}:hover`);
      const part = resolveHoveredSectionPart((selector) => hoveredRoot(selector) !== null);
      const root = part === null ? null : hoveredRoot(part.selector);
      if (part === null || root === null) return;
      event.preventDefault();
      event.stopPropagation();
      // Read the saved value, not a render's copy: a held key repeats faster than renders.
      const next = applySectionScaleCommand(
        readSectionScales(window.localStorage),
        part.id,
        command,
      );
      setScales(next);
      // Placed against the part's new size, once the zoom has been laid out.
      window.requestAnimationFrame(() =>
        setNotice((current) => ({
          id: (current?.id ?? 0) + 1,
          text: sectionScaleNotice(part, next[part.id]),
          ...noticePoint(root),
        })),
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [setScales]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (notice === null) return null;
  return createPortal(
    <div
      key={notice.id}
      role="status"
      data-rubato-section-notice=""
      className="pointer-events-none fixed z-[1000] -translate-x-1/2 rounded-md border border-border/60 bg-popover px-2.5 py-1 text-sm font-medium text-popover-foreground tabular-nums shadow-lg"
      style={{ left: notice.x, top: notice.y }}
    >
      {notice.text}
    </div>,
    document.body,
  );
}
