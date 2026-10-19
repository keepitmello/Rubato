// Settings > Projects before a project is chosen: the one place that adds,
// orders and puts away projects for every surface that lists them
// (sidebar/rubatoProjectOrder.ts, project-order-edits.mjs). Rows reorder by
// drag (or the keyboard), − moves a project to the others, + brings one back,
// Add project opens the command palette's add flow, and a name opens that
// project's own settings, where removing it from Rubato spells out what is deleted.
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon, GripVerticalIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { activityLabel } from "../sidebar/RubatoProjectPicker";
import { useRubatoProjectList } from "../sidebar/rubatoProjectList";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Search that leaves the chosen project, which is what shows the list instead of one project's settings. */
export function rubatoProjectListSearch<Search extends object>(previous: Search) {
  return { ...previous, project: undefined, checkout: undefined };
}

/** Opens the list from anywhere: the command palette, the legacy sidebar's menu. */
export function useOpenRubatoProjectList() {
  const navigate = useNavigate();
  return useCallback(
    () => navigate({ to: "/settings/projects", search: rubatoProjectListSearch }),
    [navigate],
  );
}

function ProjectListRow(props: {
  group: SidebarProjectSnapshot;
  listed: boolean;
  activity: string;
  onOpen: () => void;
  onToggleListed: () => void;
}) {
  const sortable = useSortable({ id: props.group.projectKey, disabled: !props.listed });
  const name = props.group.displayName;
  return (
    <div
      ref={sortable.setNodeRef}
      data-rubato-project-row=""
      className={cn(
        "group/row relative flex items-center gap-2 py-2 pr-3 pl-1.5 sm:pr-4",
        sortable.isDragging && "z-10 rounded-lg bg-popover shadow-md",
      )}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
    >
      {props.listed ? (
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label={`Reorder ${name}`}
          className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      ) : (
        <span aria-hidden="true" className="size-6 shrink-0" />
      )}
      <button
        type="button"
        onClick={props.onOpen}
        title="Project settings"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("flex shrink-0", !props.listed && "opacity-60")}>
          <ProjectFavicon project={props.group} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate text-sm",
              props.listed ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {name}
          </span>
          {props.group.workspaceRoot ? (
            <span className="truncate text-xs text-muted-foreground/70" translate="no">
              {props.group.workspaceRoot}
            </span>
          ) : null}
        </span>
      </button>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{props.activity}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={props.listed ? `Move ${name} to other projects` : `Add ${name} to my projects`}
        title={props.listed ? "Move to other projects" : "Add to my projects"}
        onClick={props.onToggleListed}
      >
        {props.listed ? <MinusIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

export function RubatoProjectListSettings() {
  const { list, lastActivity, remove, add, move, reset, edited } = useRubatoProjectList();
  const { selectScope } = useSettingsScope();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      move(String(event.active.id), String(event.over.id));
    }
  };
  const row = (group: SidebarProjectSnapshot, listed: boolean) => (
    <ProjectListRow
      key={group.projectKey}
      group={group}
      listed={listed}
      activity={activityLabel(lastActivity.get(group.projectKey))}
      onOpen={() => selectScope({ project: group.projectKey })}
      onToggleListed={() => (listed ? remove(group.projectKey) : add(group.projectKey))}
    />
  );

  return (
    <SettingsPageContainer>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        One order for every place that lists projects: the Projects window, the home tabs and the
        new-thread pickers. Drag to reorder, and choose a project to open its settings, where you
        can remove it.
      </p>
      <SettingsSection
        id="rubato-project-list"
        title="My projects"
        headerAction={
          <div className="flex items-center gap-1">
            {edited ? (
              <Button size="xs" variant="ghost" onClick={reset}>
                <RotateCcwIcon className="size-3.5" />
                Sort by recent activity
              </Button>
            ) : null}
            <Button size="xs" variant="outline" onClick={() => openCommandPalette({ open: "add-project" })}>
              <FolderPlusIcon className="size-3.5" />
              Add project
            </Button>
          </div>
        }
      >
        {list.listed.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={list.listed.map((group) => group.projectKey)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50">
                {list.listed.map((group) => row(group, true))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            No projects here. Add one from other projects with +.
          </p>
        )}
      </SettingsSection>
      {list.quiet.length > 0 ? (
        <SettingsSection title="Other projects">
          <div className="flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50">
            {list.quiet.map((group) => row(group, false))}
          </div>
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
