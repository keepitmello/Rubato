// Cursor Grok 4.6 is presented to pickers as `cursor/cursor-grok-4.6`, but the
// live catalog and `--list-models` expose only the Fast variant ids. Isolated
// children look those catalogs up exactly, so the presented id was
// model_not_visible even when Fast was sitting right there.
export const CURSOR_GROK_PRESENTED_ID = "cursor/cursor-grok-4.6"
export const CURSOR_GROK_DEFAULT_FAST_ID = "cursor/cursor-grok-4.6-high-fast"

export const CURSOR_GROK_LIVE_IDS = Object.freeze([
  CURSOR_GROK_DEFAULT_FAST_ID,
  "cursor/cursor-grok-4.6-medium-fast",
  "cursor/cursor-grok-4.6-low-fast",
  "cursor/cursor-grok-4.6-xhigh-fast",
  "cursor/cursor-grok-4.6-fast",
])

const CURSOR_GROK_FAMILY = new Set<string>([CURSOR_GROK_PRESENTED_ID, ...CURSOR_GROK_LIVE_IDS])

/** Expand a child `--list-models` set so the presented id and Fast ids count as one identity. */
export function expandCursorGrokVisibility(visible: ReadonlySet<string>): ReadonlySet<string> {
  if (![...CURSOR_GROK_FAMILY].some((id) => visible.has(id))) return visible
  const next = new Set(visible)
  next.add(CURSOR_GROK_PRESENTED_ID)
  for (const id of CURSOR_GROK_LIVE_IDS) next.add(id)
  return next
}

/** Isolated `--model` must be a live catalog row, not the picker identity. */
export function cursorGrokLaunchModel(model: string): string {
  return model === CURSOR_GROK_PRESENTED_ID ? CURSOR_GROK_DEFAULT_FAST_ID : model
}
