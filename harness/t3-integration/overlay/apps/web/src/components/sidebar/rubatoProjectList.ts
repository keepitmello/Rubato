// The shared project list as React state: the rail and the home tabs both read
// it through useRubatoProjectList, so a remove, add or move in one shows in
// the other at once (useLocalStorage notifies every reader in the window).
import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";

import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import {
  EMPTY_PROJECT_LIST_STATE,
  addToProjectList,
  lastActivityByGroup,
  moveInProjectList,
  removeFromProjectList,
  resolveProjectList,
  signalByGroup,
  type RubatoProjectListState,
} from "./rubatoProjectRail.logic";

export const RUBATO_PROJECT_LIST_KEY = "rubato:project-list:v1";

const ProjectListStateSchema = Schema.Struct({
  order: Schema.NullOr(Schema.Array(Schema.String)),
  hidden: Schema.Array(Schema.String),
});

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
  const [state, setState] = useLocalStorage<RubatoProjectListState, unknown>(
    RUBATO_PROJECT_LIST_KEY,
    EMPTY_PROJECT_LIST_STATE,
    ProjectListStateSchema as unknown as Schema.Codec<RubatoProjectListState, unknown>,
  );
  const lastActivity = useMemo(() => lastActivityByGroup(groups, threads), [groups, threads]);
  const list = useMemo(
    () => resolveProjectList({ groups, state, lastActivity, now: Date.now() }),
    [groups, lastActivity, state],
  );
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
  return { groups, threads, list, signals, remove, add, move };
}
