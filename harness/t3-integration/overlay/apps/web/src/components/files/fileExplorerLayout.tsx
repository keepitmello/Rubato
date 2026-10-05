import { type RefObject, useState } from "react";

/** The explorer's width beside a file, dragged by its right edge and kept across sessions. */
const WIDTH_STORAGE_KEY = "rubato:file-explorer-width";
export const EXPLORER_MIN_WIDTH = 160;
/** Room the preview keeps however wide the explorer is dragged. */
export const PREVIEW_MIN_WIDTH = 240;

export function clampExplorerWidth(width: number, containerWidth: number): number {
  const max = Math.max(EXPLORER_MIN_WIDTH, containerWidth - PREVIEW_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, EXPLORER_MIN_WIDTH), max));
}

function readWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(value) && value >= EXPLORER_MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

/** null means the default width. `persist` stores it; a drag persists once, on release. */
export function useExplorerWidth() {
  const [width, setWidth] = useState<number | null>(readWidth);
  const update = (next: number | null, persist: boolean) => {
    setWidth(next);
    if (!persist) return;
    try {
      if (next === null) localStorage.removeItem(WIDTH_STORAGE_KEY);
      else localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable; the width then lasts for this session.
    }
  };
  return [width, update] as const;
}

export function ExplorerResizeHandle(props: {
  explorerRef: RefObject<HTMLElement | null>;
  onResize: (width: number | null, persist: boolean) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file explorer"
      title="Drag to resize, double-click to reset"
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/25 active:bg-primary/40"
      onDoubleClick={() => props.onResize(null, true)}
      onPointerDown={(event) => {
        const explorer = props.explorerRef.current;
        const container = explorer?.parentElement;
        if (!explorer || !container || event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = explorer.getBoundingClientRect().width;
        const containerWidth = container.getBoundingClientRect().width;
        let width = startWidth;
        handle.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          width = clampExplorerWidth(startWidth + moveEvent.clientX - startX, containerWidth);
          props.onResize(width, false);
        };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          props.onResize(width, true);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      }}
    />
  );
}
