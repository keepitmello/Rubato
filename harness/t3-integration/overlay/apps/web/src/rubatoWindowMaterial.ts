// Rubato (window-material-edits.mjs): the sidebar material as the page sees it.
// The desktop preload says which material the window was made with; the saved
// setting says which one the person wants. `html[data-window-material]` carries
// what the window shows now, and rubatoWindowMaterial.css paints for it.
import {
  liveSidebarMaterial,
  parseWindowMaterialArgument,
  pickSidebarMaterial,
  type WindowMaterialState,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettings } from "./hooks/useSettings";

declare global {
  interface Window {
    readonly rubatoWindowMaterial?: { readonly argument: string };
  }
}

function readWindowMaterialState(): WindowMaterialState | null {
  if (typeof window === "undefined") return null;
  const argument = window.rubatoWindowMaterial?.argument;
  return argument === undefined ? null : parseWindowMaterialArgument([argument]);
}

/** Null outside the desktop app: a browser tab has no window material. */
export const windowMaterialState = readWindowMaterialState();

export function useRubatoWindowMaterialSync(): void {
  const saved = useClientSettings((settings) => settings.sidebarMaterial);
  useEffect(() => {
    const root = document.documentElement;
    if (windowMaterialState === null) {
      delete root.dataset.windowMaterial;
      return;
    }
    root.dataset.windowMaterial = liveSidebarMaterial(
      windowMaterialState.active,
      pickSidebarMaterial(saved, windowMaterialState),
    );
  }, [saved]);
}
