// Rubato: the main window's sidebar material (window-material-edits.mjs). The
// window is made with the saved material; the preload hands it to the web app,
// which paints the sidebar and the right panel's frame see-through when the
// window has a material behind them.
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import {
  availableSidebarMaterials,
  defaultSidebarMaterial,
  formatWindowMaterialArgument,
  liveSidebarMaterial,
  macosMajorVersion,
  resolveSidebarMaterial,
  type SidebarMaterial,
  TRANSPARENT_WINDOW_BACKGROUND,
  VIBRANCY_MATERIAL,
  type WindowMaterialCreationOptions,
  type WindowMaterialPlatform,
  windowMaterialCreationOptions,
} from "@t3tools/contracts";

// Loaded by name at runtime: it ships macOS binaries only, so it is an optional
// dependency that Linux and Windows installs do not have, and the bundler must
// not try to inline its native loader.
const LIQUID_GLASS_MODULE: string = "electron-liquid-glass";
interface LiquidGlass {
  addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string }): number;
}

interface MaterialWindow {
  /** What the window was made with; transparency cannot change after that. */
  readonly created: SidebarMaterial;
  /** What it shows now. */
  readonly live: SidebarMaterial;
  readonly opaqueBackground: () => string;
}
const materialWindows = new Map<Electron.BrowserWindow, MaterialWindow>();

export function rubatoWindowMaterialHost(): WindowMaterialPlatform {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Electron's main process reports the OS version.
  return { platform: process.platform, macosMajor: macosMajorVersion(process.platform, process.getSystemVersion()) };
}

export interface RubatoWindowMaterialPlan {
  readonly active: SidebarMaterial;
  readonly options: WindowMaterialCreationOptions;
  /** Goes into webPreferences.additionalArguments; the preload reads it. */
  readonly argument: string;
}

export function planRubatoWindowMaterial(
  saved: SidebarMaterial | undefined,
  host: WindowMaterialPlatform = rubatoWindowMaterialHost(),
): RubatoWindowMaterialPlan {
  const active = resolveSidebarMaterial(saved, host);
  return {
    active,
    options: windowMaterialCreationOptions(active),
    argument: formatWindowMaterialArgument({
      active,
      available: availableSidebarMaterials(host),
      fallback: defaultSidebarMaterial(host),
    }),
  };
}

export function attachRubatoWindowMaterial(
  window: Electron.BrowserWindow,
  active: SidebarMaterial,
  opaqueBackground: () => string,
): void {
  materialWindows.set(window, { created: active, live: active, opaqueBackground });
  window.once("closed", () => materialWindows.delete(window));
  if (active !== "liquid-glass") return;
  // A transparent window hides its traffic lights until asked.
  window.setWindowButtonVisibility(true);
  window.webContents.once("did-finish-load", () => {
    void addLiquidGlass(window);
  });
}

async function addLiquidGlass(window: Electron.BrowserWindow): Promise<void> {
  try {
    const loaded = (await import(LIQUID_GLASS_MODULE)) as { default: LiquidGlass };
    if (window.isDestroyed()) return;
    // One glass view behind the whole page; the page paints over all but the
    // sidebar and the right panel's frame. Calling it again replaces the view.
    const glassId = loaded.default.addView(window.getNativeWindowHandle(), { cornerRadius: 0 });
    // -1: the package loaded, but its native addon did not.
    if (glassId < 0) throw new Error("electron-liquid-glass has no native addon for this Mac");
    window.setWindowButtonVisibility(true);
  } catch (cause) {
    // The window is already transparent: blur it with macOS material instead of
    // showing the desktop through the sidebar unblurred.
    if (!window.isDestroyed()) window.setVibrancy(VIBRANCY_MATERIAL);
    void Effect.runPromise(
      Effect.logWarning("Rubato could not load Liquid Glass; using macOS material instead.", cause),
    );
  }
}

/** The window color behind the page: clear wherever a material must show through. */
export function rubatoWindowBackgroundColor(
  window: Electron.BrowserWindow,
  opaque: string,
): string {
  const record = materialWindows.get(window);
  return record === undefined || record.live === "opaque" ? opaque : TRANSPARENT_WINDOW_BACKGROUND;
}

/**
 * Follows a changed setting on every open main window: opaque and vibrancy
 * switch in place; a change into or out of Liquid Glass keeps the material the
 * window was made with until a restart. The web app applies the same rule
 * (liveSidebarMaterial), so the page and the window agree.
 */
export function applyRubatoSidebarMaterial(saved: SidebarMaterial | undefined): void {
  const wanted = resolveSidebarMaterial(saved, rubatoWindowMaterialHost());
  for (const [window, record] of materialWindows) {
    if (window.isDestroyed()) continue;
    const live = liveSidebarMaterial(record.created, wanted);
    if (live === record.live) continue;
    materialWindows.set(window, { ...record, live });
    if (live === "vibrancy") {
      window.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND);
      window.setVibrancy(VIBRANCY_MATERIAL);
    } else {
      window.setVibrancy(null);
      window.setBackgroundColor(record.opaqueBackground());
    }
  }
}
