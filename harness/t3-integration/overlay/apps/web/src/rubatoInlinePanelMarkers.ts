// Rubato (window-material-edits.mjs): the inline right panel marks the
// workspace and the row it sits in, for rubatoWindowMaterial.css. Its own file
// so PreviewPanelShell imports nothing but React through it.
import { type RefObject, useLayoutEffect } from "react";

// How many inline panels mark an element; two panels in one workspace keep the
// mark until both are gone.
const inlinePanelMarks = new WeakMap<Element, number>();
function markElement(element: Element, attribute: string): () => void {
  inlinePanelMarks.set(element, (inlinePanelMarks.get(element) ?? 0) + 1);
  element.setAttribute(attribute, "");
  return () => {
    const remaining = (inlinePanelMarks.get(element) ?? 1) - 1;
    if (remaining > 0) {
      inlinePanelMarks.set(element, remaining);
      return;
    }
    inlinePanelMarks.delete(element);
    element.removeAttribute(attribute);
  };
}

/**
 * Marks the workspace and the row that hold an inline right panel, so
 * rubatoWindowMaterial.css can clear their sheet without `:has()`, which made
 * the browser recheck style on every DOM change (streamed messages included).
 */
export function useRubatoInlinePanelMarkers(
  hostRef: RefObject<HTMLElement | null>,
  inline: boolean,
): void {
  useLayoutEffect(() => {
    const host = hostRef.current;
    const row = host?.parentElement;
    if (!inline || !host || !row) return;
    const workspace = host.closest('[data-slot="sidebar-inset"]');
    const unmarkRow = markElement(row, "data-rubato-inline-panel-row");
    const unmarkWorkspace = workspace ? markElement(workspace, "data-rubato-inline-panel-workspace") : null;
    return () => {
      unmarkRow();
      unmarkWorkspace?.();
    };
  }, [hostRef, inline]);
}
