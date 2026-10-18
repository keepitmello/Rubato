// The one project order (project-order-edits.mjs). Every surface that lists
// projects reads it from here: the rail's Projects window and the home tabs
// (through rubatoProjectList.ts), the command palette's "New thread in...",
// the headline's picker on the new-thread screen, the sidebar's project groups
// (the phone filter, Pull Requests), the default project for a new thread and
// the legacy sidebar. One place edits it: Settings > Projects
// (settings/RubatoProjectListSettings.tsx); the Projects window and the home
// tabs edit the same state in place. T3's own manual order and its project
// sort setting no longer decide anything.
import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadShells } from "../../state/entities";
import {
  EMPTY_PROJECT_LIST_STATE,
  lastActivityByGroup,
  projectListInOrder,
  resolveProjectList,
  type RubatoGroupLike,
  type RubatoProjectList,
  type RubatoProjectListState,
} from "./rubatoProjectRail.logic";

export const RUBATO_PROJECT_LIST_KEY = "rubato:project-list:v1";

const ProjectListStateSchema = Schema.Struct({
  order: Schema.NullOr(Schema.Array(Schema.String)),
  hidden: Schema.Array(Schema.String),
});

/** The stored list. useLocalStorage tells every reader in the window when it changes. */
export function useRubatoProjectListState() {
  return useLocalStorage<RubatoProjectListState, unknown>(
    RUBATO_PROJECT_LIST_KEY,
    EMPTY_PROJECT_LIST_STATE,
    ProjectListStateSchema as unknown as Schema.Codec<RubatoProjectListState, unknown>,
  );
}

export interface RubatoProjectOrder<G> {
  /** The groups in the shared order: the user's projects, then the others. */
  readonly ordered: readonly G[];
  readonly list: RubatoProjectList<G>;
  readonly lastActivity: ReadonlyMap<string, number>;
  readonly state: RubatoProjectListState;
  readonly setState: (state: RubatoProjectListState) => void;
}

/** Puts any set of project groups in the shared order. */
export function useRubatoProjectOrder<G extends RubatoGroupLike>(
  groups: readonly G[],
): RubatoProjectOrder<G> {
  const threads = useThreadShells();
  const [state, setStoredState] = useRubatoProjectListState();
  const lastActivity = useMemo(() => lastActivityByGroup(groups, threads), [groups, threads]);
  const list = useMemo(
    () => resolveProjectList({ groups, state, lastActivity, now: Date.now() }),
    [groups, lastActivity, state],
  );
  const ordered = useMemo(() => projectListInOrder(list), [list]);
  const setState = useCallback(
    (next: RubatoProjectListState) => setStoredState(next),
    [setStoredState],
  );
  return { ordered, list, lastActivity, state, setState };
}

/** Picker entries back in the shared order; T3 lifts the current project to the top. */
export function inProjectOrder<E extends { readonly group: { readonly projectKey: string } }>(
  entries: readonly E[],
  ordered: readonly RubatoGroupLike[],
): E[] {
  const index = new Map(ordered.map((group, position) => [group.projectKey, position] as const));
  const at = (entry: E) => index.get(entry.group.projectKey) ?? Number.MAX_SAFE_INTEGER;
  return entries.toSorted((a, b) => at(a) - at(b));
}
