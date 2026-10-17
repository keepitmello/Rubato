import { useLayoutEffect, useState } from "react";

/** The toolbar button the thread details hang from (PanelLayoutControls). */
const TOGGLE_SELECTOR = '[aria-label="Toggle thread details panel"]';
/** Keep the caret clear of the card's rounded corners. */
const CORNER_CLEARANCE = 18;

/**
 * Horizontal center of the thread-details toggle, measured from the card's left
 * edge, so the card can point a caret at the button it opened from. Null while the
 * button is not above the card (Rubato polish, polish-edits.mjs).
 */
export function useDetailsCaretOffset(card: HTMLElement | null): number | null {
  const [offset, setOffset] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!card) return;
    const measure = () => {
      const button = document.querySelector<HTMLElement>(TOGGLE_SELECTOR);
      if (!button) {
        setOffset(null);
        return;
      }
      const buttonBox = button.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const x = Math.round(buttonBox.left + buttonBox.width / 2 - cardBox.left);
      setOffset(x >= CORNER_CLEARANCE && x <= cardBox.width - CORNER_CLEARANCE ? x : null);
    };
    measure();
    // The card moves when the canvas beside it resizes (right panel, sidebar, window).
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    if (card.offsetParent) observer.observe(card.offsetParent);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [card]);
  return offset;
}
