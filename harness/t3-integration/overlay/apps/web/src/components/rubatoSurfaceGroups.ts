/**
 * Rubato's order for the surface launcher and the tab bar's "+" menu: kinds of
 * surfaces sit together, and a thin rule separates one kind from the next.
 * Labels not listed keep their upstream order after the known groups.
 */
export const RUBATO_SURFACE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["Agents"],
  ["Files", "Markdown note", "Terminal", "Side chat"],
  ["Browser", "Device"],
  ["Diff", "Pull request", "Linked pull requests"],
];

const UNGROUPED = RUBATO_SURFACE_GROUPS.length;

function groupOf(label: string): number {
  const index = RUBATO_SURFACE_GROUPS.findIndex((group) => group.includes(label));
  return index === -1 ? UNGROUPED : index;
}

function rankOf(label: string): number {
  const group = groupOf(label);
  return group === UNGROUPED ? Number.MAX_SAFE_INTEGER : group * 100 + RUBATO_SURFACE_GROUPS[group]!.indexOf(label);
}

export function orderSurfaceActions<T extends { readonly label: string }>(actions: ReadonlyArray<T>): T[] {
  return actions
    .map((action, index) => ({ action, index }))
    .toSorted((left, right) => rankOf(left.action.label) - rankOf(right.action.label) || left.index - right.index)
    .map(({ action }) => action);
}

/** True when the action at index opens a new group in an ordered list. */
export function startsSurfaceGroup(
  actions: ReadonlyArray<{ readonly label: string }>,
  index: number,
): boolean {
  const previous = actions[index - 1];
  const current = actions[index];
  return previous !== undefined && current !== undefined && groupOf(previous.label) !== groupOf(current.label);
}

/**
 * The rule is drawn in the gap above the row rather than as a sibling element, so
 * hover, highlight and keyboard navigation still see only surface rows.
 */
export function surfaceGroupStartClass(
  actions: ReadonlyArray<{ readonly label: string }>,
  index: number,
): string | undefined {
  return startsSurfaceGroup(actions, index)
    ? "relative mt-[9px] before:pointer-events-none before:absolute before:inset-x-2 before:-top-[5px] before:h-px before:bg-border/50"
    : undefined;
}
