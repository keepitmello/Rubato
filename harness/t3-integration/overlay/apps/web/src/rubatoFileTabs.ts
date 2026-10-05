import type { RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

/**
 * File tabs as an IDE explorer keeps them. A file opened from the explorer is a
 * preview: it takes the place of the current preview tab instead of adding a
 * tab per click, and stays once pinned (double-click, edit, or an open from
 * anywhere else). Renames and deletes in the explorer follow into the tabs.
 */
export type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

const isWorkspaceFile = (surface: RightPanelSurface): surface is FileSurface =>
  surface.kind === "file" && surface.attachment === undefined;

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function withoutPreview(surface: FileSurface): FileSurface {
  const { preview: _preview, ...pinned } = surface;
  return pinned;
}

/** The tab list after opening `surface`. An existing tab stays where it is. */
export function placeFileSurface(
  surfaces: readonly RightPanelSurface[],
  surface: FileSurface,
  preview: boolean,
): RightPanelSurface[] {
  const existing = surfaces.find((entry) => entry.id === surface.id);
  if (existing) {
    // Opening a preview tab from anywhere but the explorer pins it.
    const next =
      existing.kind === "file" && existing.preview === true && preview
        ? { ...surface, preview: true }
        : withoutPreview(surface);
    return surfaces.map((entry) => (entry.id === surface.id ? next : entry));
  }
  if (!preview) return [...surfaces, withoutPreview(surface)];
  const next: FileSurface = { ...surface, preview: true };
  const index = surfaces.findIndex((entry) => entry.kind === "file" && entry.preview === true);
  return index < 0
    ? [...surfaces, next]
    : surfaces.map((entry, position) => (position === index ? next : entry));
}

export function pinFileSurface(
  state: ThreadRightPanelState,
  relativePath: string,
): ThreadRightPanelState {
  const id = `file:${relativePath}`;
  if (!state.surfaces.some((entry) => entry.id === id && entry.kind === "file" && entry.preview)) {
    return state;
  }
  return {
    ...state,
    surfaces: state.surfaces.map((entry) =>
      entry.id === id && entry.kind === "file" ? withoutPreview(entry) : entry,
    ),
  };
}

/** Moves the tabs of `from` (a file, or a folder and everything in it) to `to`. */
export function renameFileSurfaces(
  state: ThreadRightPanelState,
  from: string,
  to: string,
): ThreadRightPanelState {
  const renamedIds = new Map<string, string>();
  const surfaces = state.surfaces.map((entry): RightPanelSurface => {
    if (!isWorkspaceFile(entry) || !within(entry.relativePath, from)) return entry;
    const relativePath = `${to}${entry.relativePath.slice(from.length)}`;
    const id = `file:${relativePath}` as const;
    renamedIds.set(entry.id, id);
    return { ...entry, id, relativePath };
  });
  if (renamedIds.size === 0) return state;
  return {
    ...state,
    surfaces,
    activeSurfaceId:
      state.activeSurfaceId === null
        ? null
        : (renamedIds.get(state.activeSurfaceId) ?? state.activeSurfaceId),
  };
}

/** Closes the tabs of a deleted file, or of a deleted folder and everything in it. */
export function closeFileSurfaces(
  state: ThreadRightPanelState,
  relativePath: string,
): ThreadRightPanelState {
  const closes = (entry: RightPanelSurface) =>
    isWorkspaceFile(entry) && within(entry.relativePath, relativePath);
  const surfaces = state.surfaces.filter((entry) => !closes(entry));
  if (surfaces.length === state.surfaces.length) return state;
  const activeIndex = state.surfaces.findIndex((entry) => entry.id === state.activeSurfaceId);
  const active = state.surfaces[activeIndex];
  let activeSurfaceId = state.activeSurfaceId;
  if (active !== undefined && closes(active)) {
    // The nearest tab that stays, looking right first, as closing one tab does.
    const after = state.surfaces.slice(activeIndex + 1).find((entry) => !closes(entry));
    const before = state.surfaces
      .slice(0, activeIndex)
      .toReversed()
      .find((entry) => !closes(entry));
    activeSurfaceId = (after ?? before)?.id ?? null;
  }
  return {
    ...state,
    isOpen: surfaces.length > 0 && state.isOpen,
    surfaces,
    activeSurfaceId,
  };
}
