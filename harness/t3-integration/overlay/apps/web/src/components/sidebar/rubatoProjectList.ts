// The shared project list as React state for the surfaces that edit it in
// place: the rail's Projects window, the home tabs and Settings > Projects
// read it through useRubatoProjectList, so a remove, add or move in one shows
// in the others at once. The order itself, and the surfaces that only read
// it, are in rubatoProjectOrder.ts.
import { useCallback, useMemo } from "react";

import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { useScratchProject } from "../../hooks/useScratchProject";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { useRubatoProjectOrder } from "./rubatoProjectOrder";
import {
  EMPTY_PROJECT_LIST_STATE,
  addToProjectList,
  moveInProjectList,
  removeFromProjectList,
  signalByGroup,
} from "./rubatoProjectRail.logic";

export function useRubatoProjectList() {
  const allGroups = useSidebarProjectGroups();
  // The folder that hosts threads without a project ("No project") is not a
  // project to pick, as in the headline's picker; its threads stay in the list
  // under "All projects". The server marks it, and its path is the fallback.
  const { scratchWorkspaceRootFor } = useScratchProject();
  const groups = useMemo(
    () =>
      allGroups.filter(
        (group) =>
          group.isScratch !== true &&
          !isScratchProject(group, scratchWorkspaceRootFor(group.environmentId)),
      ),
    [allGroups, scratchWorkspaceRootFor],
  );
  const threads = useThreadShells();
  const localLastVisitedAt = useUiStateStore((store) => store.threadLastVisitedAtById);
  const { list, lastActivity, state, setState } = useRubatoProjectOrder(groups);
  const signals = useMemo(
    () => signalByGroup(groups, threads, localLastVisitedAt),
    [groups, localLastVisitedAt, threads],
  );
  const remove = useCallback((key: string) => setState(removeFromProjectList(list, key)), [list, setState]);
  const add = useCallback((key: string) => setState(addToProjectList(list, key)), [list, setState]);
  const move = useCallback(
    (key: string, overKey: string) => setState(moveInProjectList(list, key, overKey)),
    [list, setState],
  );
  /** Back to following activity, as before the first edit. */
  const reset = useCallback(() => setState(EMPTY_PROJECT_LIST_STATE), [setState]);
  const edited = state.order !== null || state.hidden.length > 0;
  return { groups, threads, list, signals, lastActivity, remove, add, move, reset, edited };
}
