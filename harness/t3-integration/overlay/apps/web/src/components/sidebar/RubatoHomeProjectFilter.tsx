// The header button beside Add project while no project is selected: a
// checklist of the projects in the all-projects list. Unchecking one keeps its
// threads out of that list and out of the Recent box; pinned threads and
// search still show them. The choice stays on this device.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Schema from "effect/Schema";
import { ListFilterIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { homeFilterProjects } from "./rubatoProjectRail.logic";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const HIDDEN_PROJECTS_KEY = "rubato:home-hidden-projects:v1";
const HiddenProjects = Schema.Array(Schema.String);
const NONE: readonly string[] = [];

/** The project keys the user unchecked; every reader in the window sees a change at once. */
export function useRubatoHomeHiddenProjects() {
  const [stored, setStored] = useLocalStorage(HIDDEN_PROJECTS_KEY, NONE, HiddenProjects);
  const hidden = useMemo(() => new Set(stored), [stored]);
  return { hidden, setHidden: setStored };
}

export function RubatoHomeProjectFilter(props: {
  groups: readonly SidebarProjectSnapshot[];
  threads: readonly EnvironmentThreadShell[];
}) {
  const { hidden, setHidden } = useRubatoHomeHiddenProjects();
  const rows = useMemo(
    () => homeFilterProjects(props.groups, props.threads),
    [props.groups, props.threads],
  );
  const narrowed = rows.some((group) => hidden.has(group.projectKey));
  const setShown = useCallback(
    (key: string, shown: boolean) =>
      setHidden((current) => {
        const rest = current.filter((candidate) => candidate !== key);
        return shown ? rest : [...rest, key];
      }),
    [setHidden],
  );
  if (rows.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={narrowed ? "Projects in the list: some hidden" : "Projects in the list"}
          />
        }
      >
        <ListFilterIcon />
        {narrowed ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Show in the list</MenuGroupLabel>
          {rows.map((group) => (
            <MenuCheckboxItem
              key={group.projectKey}
              checked={!hidden.has(group.projectKey)}
              closeOnClick={false}
              onCheckedChange={(shown) => setShown(group.projectKey, shown)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex shrink-0">
                  <ProjectFavicon project={group} className="size-4" />
                </span>
                <span className="min-w-0 truncate">{group.displayName}</span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        {narrowed ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => setHidden(NONE)}>Show all projects</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
