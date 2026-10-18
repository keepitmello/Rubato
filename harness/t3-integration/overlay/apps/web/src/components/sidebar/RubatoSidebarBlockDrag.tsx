// Moving a sidebar section by its header (sidebar-blocks-edits.mjs): press a
// header (Recent, the project title, Working, Snoozed, Settled) and drag; a
// line shows where the section lands and letting go saves the order. A short
// press stays the header's click (collapse). This is its own gesture, not
// dnd-kit's: the thread drag keeps the list's sortable context, and dropping a
// thread on a header still moves the thread into that section.
//
// Touch keeps scrolling: on a phone the order is set from Settings.
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  SIDEBAR_BLOCK_HEAD_TEST_IDS,
  moveSidebarBlock,
  nearestSidebarBlockGap,
  resolveSidebarBlockOrder,
  type RubatoSidebarBlock,
} from "./rubatoSidebarBlocks";

const DRAG_DISTANCE = 6;

interface BlockDrag {
  readonly block: RubatoSidebarBlock;
  /** The header's own text, as the sidebar shows it (translated, with its count). */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  /** The drop line, in window coordinates. */
  readonly line: { readonly top: number; readonly left: number; readonly width: number } | null;
}

/** Each block's extent in the list, top to bottom, from the list items the blocks open with. */
function measureBlocks(list: HTMLElement) {
  const heads: Array<{ block: RubatoSidebarBlock; element: Element }> = [];
  const byTestId = new Map(SIDEBAR_BLOCK_HEAD_TEST_IDS);
  for (const element of list.querySelectorAll("[data-testid]")) {
    if (element.parentElement !== list) continue;
    const block = byTestId.get(element.getAttribute("data-testid") ?? "");
    if (block !== undefined && !heads.some((head) => head.block === block)) heads.push({ block, element });
  }
  const end = list.lastElementChild?.getBoundingClientRect().bottom ?? list.getBoundingClientRect().bottom;
  return heads.map((head, index) => ({
    block: head.block,
    top: head.element.getBoundingClientRect().top,
    bottom: heads[index + 1]?.element.getBoundingClientRect().top ?? end,
  }));
}

export function useRubatoSidebarBlocks(listRef: RefObject<HTMLElement | null>) {
  const stored = useClientSettings((settings) => settings.rubatoSidebarBlocks);
  const updateClientSettings = useUpdateClientSettings();
  const order = resolveSidebarBlockOrder(stored);
  const orderRef = useRef(order);
  orderRef.current = order;
  const [drag, setDrag] = useState<BlockDrag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      const handle =
        event.target instanceof Element ? event.target.closest("[data-rubato-block-handle]") : null;
      const list = listRef.current;
      if (handle === null || list === null) return;
      const block = handle.getAttribute("data-rubato-block-handle") as RubatoSidebarBlock;
      const label = handle.textContent?.trim() ?? "";
      const start = { x: event.clientX, y: event.clientY };
      let started = false;
      let target: RubatoSidebarBlock | null | undefined;
      const previousUserSelect = document.body.style.userSelect;

      const move = (moveEvent: globalThis.PointerEvent) => {
        if (!started) {
          if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_DISTANCE) return;
          started = true;
          document.body.style.userSelect = "none";
        }
        moveEvent.preventDefault();
        const listRect = list.getBoundingClientRect();
        const gap = nearestSidebarBlockGap(measureBlocks(list), block, moveEvent.clientY);
        target = gap?.before;
        setDrag({
          block,
          label,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          line:
            gap === null
              ? null
              : { top: gap.y, left: listRect.left + 8, width: Math.max(0, listRect.width - 16) },
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("keydown", key, true);
        document.body.style.userSelect = previousUserSelect;
        cleanupRef.current = null;
        setDrag(null);
      };
      const up = () => {
        cleanup();
        if (!started) return;
        // The press was a drag: the header's own click must not collapse it.
        const swallow = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        if (target === undefined) return;
        const next = moveSidebarBlock(orderRef.current, block, target);
        if (next.join() !== orderRef.current.join()) {
          void updateClientSettings({ rubatoSidebarBlocks: next });
        }
      };
      const cancel = () => cleanup();
      const key = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape") {
          started = false;
          cleanup();
        }
      };
      cleanupRef.current?.();
      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("keydown", key, true);
    },
    [listRef, updateClientSettings],
  );

  const overlay =
    drag === null
      ? null
      : createPortal(
          <div aria-hidden className="pointer-events-none fixed inset-0 z-50 cursor-grabbing">
            {drag.line ? (
              <div
                className="absolute h-0.5 -translate-y-1/2 rounded-full bg-primary"
                style={{ top: drag.line.top, left: drag.line.left, width: drag.line.width }}
              />
            ) : null}
            <div
              className="absolute rounded-md border border-sidebar-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md"
              style={{ top: drag.y + 10, left: drag.x + 12 }}
            >
              {drag.label}
            </div>
          </div>,
          document.body,
        );

  return { order, onPointerDownCapture, overlay, draggingBlock: drag?.block ?? null };
}
