/**
 * Rubato: what the sidebar and the right panel's frame are made of
 * (harness/t3-integration/window-material-edits.mjs).
 *
 * - "opaque": T3's own look, a solid sheet in the theme's sidebar color.
 * - "vibrancy": macOS's built-in material (Electron `vibrancy`), the desktop
 *   shows through blurred. Electron switches it on a running window.
 * - "liquid-glass": macOS 26's NSGlassEffectView (electron-liquid-glass). It
 *   needs a transparent window, which Electron only makes at creation, so
 *   entering or leaving it applies after a restart.
 *
 * The chat canvas and the right panel's content card stay opaque in every mode.
 * No imports: the desktop main process, its preload, the web app and the
 * overlay's node tests all load this file as is.
 */

export const SIDEBAR_MATERIALS = ["opaque", "vibrancy", "liquid-glass"] as const;
export type SidebarMaterial = (typeof SIDEBAR_MATERIALS)[number];

export interface WindowMaterialPlatform {
  readonly platform: string;
  /** macOS major version (26 for Tahoe), null off macOS or when unknown. */
  readonly macosMajor: number | null;
}

/** The first macOS with NSGlassEffectView. */
export const LIQUID_GLASS_MIN_MACOS = 26;

/**
 * Whether a Mac that has Liquid Glass starts with it. False until a person has
 * dragged a transparent window's edges on macOS 26+ and seen it resize: on
 * macOS 27 synthetic mouse drags resize no window (not even an opaque one), so
 * the automated check could confirm shadow and traffic lights but not that.
 */
export const LIQUID_GLASS_IS_DEFAULT = false;

export function isSidebarMaterial(value: unknown): value is SidebarMaterial {
  return typeof value === "string" && (SIDEBAR_MATERIALS as readonly string[]).includes(value);
}

/** Darwin's process.getSystemVersion() is the macOS version, "27.0" or "26.1.2". */
export function macosMajorVersion(platform: string, systemVersion: string): number | null {
  if (platform !== "darwin") return null;
  const major = Number.parseInt(systemVersion, 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/** The materials this machine can show, in the order the setting lists them. */
export function availableSidebarMaterials(
  host: WindowMaterialPlatform,
): ReadonlyArray<SidebarMaterial> {
  if (host.platform !== "darwin") return ["opaque"];
  if (host.macosMajor !== null && host.macosMajor >= LIQUID_GLASS_MIN_MACOS) {
    return ["opaque", "vibrancy", "liquid-glass"];
  }
  return ["opaque", "vibrancy"];
}

export function defaultSidebarMaterial(host: WindowMaterialPlatform): SidebarMaterial {
  const available = availableSidebarMaterials(host);
  if (LIQUID_GLASS_IS_DEFAULT && available.includes("liquid-glass")) return "liquid-glass";
  return available.includes("vibrancy") ? "vibrancy" : "opaque";
}

/**
 * The material a saved setting means on this machine. No saved value means the
 * default; a value this machine cannot show (settings copied from a newer Mac)
 * falls back to the closest one it can.
 */
export function resolveSidebarMaterial(
  saved: SidebarMaterial | undefined,
  host: WindowMaterialPlatform,
): SidebarMaterial {
  return pickSidebarMaterial(saved, {
    available: availableSidebarMaterials(host),
    fallback: defaultSidebarMaterial(host),
  });
}

/** resolveSidebarMaterial for the renderer, which knows the machine only through its window. */
export function pickSidebarMaterial(
  saved: SidebarMaterial | undefined,
  machine: Pick<WindowMaterialState, "available" | "fallback">,
): SidebarMaterial {
  if (saved === undefined) return machine.fallback;
  const available = machine.available;
  if (available.includes(saved)) return saved;
  return available.includes("vibrancy") ? "vibrancy" : "opaque";
}

/**
 * What a window created with `active` shows once the setting asks for
 * `wanted`: Electron moves between opaque and vibrancy on a live window, but
 * transparency is fixed at creation, so Liquid Glass stays until a restart.
 */
export function liveSidebarMaterial(
  active: SidebarMaterial,
  wanted: SidebarMaterial,
): SidebarMaterial {
  if (active === "liquid-glass" || wanted === "liquid-glass") return active;
  return wanted;
}

export function sidebarMaterialNeedsRestart(
  active: SidebarMaterial,
  wanted: SidebarMaterial,
): boolean {
  return liveSidebarMaterial(active, wanted) !== wanted;
}

/** Fully transparent: the material view behind the page shows wherever the page paints nothing. */
export const TRANSPARENT_WINDOW_BACKGROUND = "#00000000";
/** The NSVisualEffectView material Finder and Mail use for their sidebars. */
export const VIBRANCY_MATERIAL = "sidebar";

export interface WindowMaterialCreationOptions {
  readonly transparent?: true;
  readonly vibrancy?: typeof VIBRANCY_MATERIAL;
  readonly visualEffectState?: "followWindow";
  readonly backgroundColor?: string;
}

/**
 * BrowserWindow options for a window made with `material`, spread over T3's.
 * Liquid Glass must not set vibrancy too: the older blur would cover the glass.
 */
export function windowMaterialCreationOptions(
  material: SidebarMaterial,
): WindowMaterialCreationOptions {
  if (material === "liquid-glass") {
    return { transparent: true, backgroundColor: TRANSPARENT_WINDOW_BACKGROUND };
  }
  if (material === "vibrancy") {
    return {
      vibrancy: VIBRANCY_MATERIAL,
      visualEffectState: "followWindow",
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
    };
  }
  return {};
}

/** How the main process tells its preload which material the window was made with. */
export const WINDOW_MATERIAL_ARGUMENT = "--rubato-window-material=";

export interface WindowMaterialState {
  /** The material the window was created with. */
  readonly active: SidebarMaterial;
  readonly available: ReadonlyArray<SidebarMaterial>;
  /** What the window starts with when nothing is saved. */
  readonly fallback: SidebarMaterial;
}

export function formatWindowMaterialArgument(state: WindowMaterialState): string {
  return `${WINDOW_MATERIAL_ARGUMENT}${state.active};${state.available.join(",")};${state.fallback}`;
}

export function parseWindowMaterialArgument(
  argv: ReadonlyArray<string>,
): WindowMaterialState | null {
  const argument = argv.find((value) => value.startsWith(WINDOW_MATERIAL_ARGUMENT));
  if (argument === undefined) return null;
  const [active, available = "", fallback] = argument
    .slice(WINDOW_MATERIAL_ARGUMENT.length)
    .split(";");
  const materials = available.split(",").filter(isSidebarMaterial);
  if (!isSidebarMaterial(active) || !isSidebarMaterial(fallback) || materials.length === 0) {
    return null;
  }
  return { active, available: materials, fallback };
}
