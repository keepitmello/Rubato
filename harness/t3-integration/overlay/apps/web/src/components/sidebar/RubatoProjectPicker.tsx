// The window the rail's Projects button opens. Projects are told apart here by
// name, never by a bare icon on the rail: a search field, All projects, the
// user's projects, the others, Add project and Edit projects. The same window
// edits the shared list (rubatoProjectList.ts): rows reorder by drag, − moves a
// project to the others, + brings one back, and the context menu removes one
// from Rubato (rubatoRemoveProject.ts). Edit projects opens Settings > Projects,
// where every row shows its handle and its trash. Above the projects, the user's folders
// (rubatoThreadFolders.tsx): choosing one narrows the list to the threads filed there, + New
// folder names one in place, ⌘1-9 choose the first nine, and the context menu renames or
// deletes one.
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderIcon, FolderPlusIcon, LayersIcon, MinusIcon, PencilIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { RUBATO_FOLDER_NAME_MAX, normalizeFolderName } from "@t3tools/shared/rubatoThreadFolders";
import type { RubatoFolder } from "./rubatoThreadFolders";
import {
  RUBATO_SIGNAL_DOT,
  RUBATO_SIGNAL_LABEL,
  filterProjectList,
  urgentSignal,
  type RubatoProjectList,
  type RubatoSignal,
} from "./rubatoProjectRail.logic";

/** "3m", "2d": how long since a project last moved. */
export function activityLabel(ms: number | undefined): string {
  if (!ms) return "";
  const label = formatRelativeTimeLabel(new Date(ms).toISOString());
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export interface RubatoProjectPickerProps {
  list: RubatoProjectList<SidebarProjectSnapshot>;
  signals: ReadonlyMap<string, RubatoSignal>;
  lastActivity: ReadonlyMap<string, number>;
  scopeKey: string | null;
  onChoose: (projectKey: string | null) => void;
  onRemove: (projectKey: string) => void;
  onAdd: (projectKey: string) => void;
  onMove: (projectKey: string, overKey: string) => void;
  onAddProject: () => void;
  onEditProjects: () => void;
  onProjectSettings: (group: SidebarProjectSnapshot) => void;
  onRemoveProject: (group: SidebarProjectSnapshot) => void;
  folders: ReadonlyArray<RubatoFolder>;
  folderScopeId: string | null;
  onChooseFolder: (folderId: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (folder: RubatoFolder, name: string) => void;
  onDeleteFolder: (folder: RubatoFolder) => void;
}

type Row =
  | { kind: "all" }
  | { kind: "folder"; folder: RubatoFolder }
  | { kind: "project"; group: SidebarProjectSnapshot; listed: boolean };

/** Naming a folder in place: a new one, or one being renamed. */
function FolderNameField(props: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(props.initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(value === null ? null : normalizeFolderName(value));
  };
  return (
    <div className="flex h-8 items-center gap-2.5 rounded-md bg-accent/60 px-2.5 text-sm ring-1 ring-ring/60">
      <FolderIcon aria-hidden className="size-4 shrink-0 fill-current/15 text-muted-foreground" />
      <input
        autoFocus
        value={name}
        maxLength={RUBATO_FOLDER_NAME_MAX}
        placeholder="Folder name"
        aria-label="Folder name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            finish(name);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(null);
          }
        }}
        onBlur={() => finish(name)}
        className="min-w-0 flex-1 bg-transparent outline-hidden placeholder:text-muted-foreground"
      />
    </div>
  );
}

function FolderRow(props: {
  folder: RubatoFolder;
  shortcut: number | null;
  selected: boolean;
  highlighted: boolean;
  onChoose: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={props.selected}
      data-highlighted={props.highlighted ? "" : undefined}
      data-rubato-folder-row=""
      onClick={props.onChoose}
      onContextMenu={props.onContextMenu}
      className={cn(
        "group/row flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm text-foreground/90",
        props.selected && "bg-accent text-foreground",
        props.highlighted && !props.selected && "bg-accent/60",
        !props.selected && "hover:bg-accent/60",
      )}
    >
      <FolderIcon aria-hidden className="size-4 shrink-0 fill-current/15 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{props.folder.name}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">
        {props.folder.threadCount}
      </span>
      {props.shortcut !== null ? (
        <kbd className="shrink-0 font-sans text-[10px] text-muted-foreground/60">⌘{props.shortcut}</kbd>
      ) : null}
    </div>
  );
}

function ProjectRow(props: {
  group: SidebarProjectSnapshot;
  listed: boolean;
  selected: boolean;
  highlighted: boolean;
  sortable: boolean;
  signal: RubatoSignal | null;
  activity: string;
  onChoose: () => void;
  onToggleListed: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const sortable = useSortable({ id: props.group.projectKey, disabled: !props.sortable });
  return (
    <div
      ref={sortable.setNodeRef}
      role="option"
      aria-selected={props.selected}
      data-highlighted={props.highlighted ? "" : undefined}
      onContextMenu={props.onContextMenu}
      className={cn(
        "group/row relative flex h-8 items-center gap-2.5 rounded-md pr-1.5 pl-2.5 text-sm outline-hidden",
        props.listed ? "text-foreground/90" : "text-muted-foreground",
        props.selected && "bg-accent text-foreground",
        props.highlighted && !props.selected && "bg-accent/60",
        !props.selected && "hover:bg-accent/60",
        sortable.isDragging && "z-10 bg-accent shadow-md",
      )}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
    >
      <button
        type="button"
        {...(props.sortable ? sortable.attributes : {})}
        {...(props.sortable ? sortable.listeners : {})}
        tabIndex={-1}
        onClick={props.onChoose}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left outline-hidden",
          props.sortable && "cursor-default active:cursor-grabbing",
        )}
      >
        <span className={cn("flex shrink-0", !props.listed && "opacity-60")}>
          <ProjectFavicon project={props.group} className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{props.group.displayName}</span>
        {props.signal ? (
          <span
            aria-label={RUBATO_SIGNAL_LABEL[props.signal]}
            className={cn("size-1.5 shrink-0 rounded-full", RUBATO_SIGNAL_DOT[props.signal])}
          />
        ) : null}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80 group-hover/row:hidden">
          {props.activity}
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={
          props.listed
            ? `Move ${props.group.displayName} to other projects`
            : `Add ${props.group.displayName} to my projects`
        }
        title={props.listed ? "Move to other projects" : "Add to my projects"}
        onClick={props.onToggleListed}
        className="hidden size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground group-hover/row:flex"
      >
        {props.listed ? <MinusIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
      </button>
    </div>
  );
}

export function RubatoProjectPicker(props: RubatoProjectPickerProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [naming, setNaming] = useState<{ folderId: string | null } | null>(null);
  const visible = useMemo(() => filterProjectList(props.list, query), [props.list, query]);
  const searching = query.trim().length > 0;
  const visibleFolders = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle.length === 0
      ? props.folders
      : props.folders.filter((folder) => folder.name.toLocaleLowerCase().includes(needle));
  }, [props.folders, query]);
  const rows = useMemo<Row[]>(
    () => [
      ...(searching ? [] : [{ kind: "all" } as const]),
      ...visibleFolders.map((folder) => ({ kind: "folder", folder }) as const),
      ...visible.listed.map((group) => ({ kind: "project", group, listed: true }) as const),
      ...visible.quiet.map((group) => ({ kind: "project", group, listed: false }) as const),
    ],
    [searching, visible, visibleFolders],
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "folder") props.onChooseFolder(row.folder.id);
    else props.onChoose(row.kind === "all" ? null : row.group.projectKey);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      const folder = props.folders[Number(event.key) - 1];
      if (folder) {
        event.preventDefault();
        props.onChooseFolder(folder.id);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => Math.min(rows.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[highlight]);
    }
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      props.onMove(String(event.active.id), String(event.over.id));
    }
  };
  const showMenu = async (
    event: MouseEvent<HTMLDivElement>,
    group: SidebarProjectSnapshot,
    listed: boolean,
  ) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        listed
          ? { id: "unlist", label: "Move to other projects" }
          : { id: "list", label: "Add to my projects" },
        { id: "settings", label: "Project settings…" },
        { id: "remove", label: "Remove project from Rubato…", destructive: true },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "unlist") props.onRemove(group.projectKey);
    else if (clicked === "list") props.onAdd(group.projectKey);
    else if (clicked === "settings") props.onProjectSettings(group);
    else if (clicked === "remove") props.onRemoveProject(group);
  };

  const showFolderMenu = async (event: MouseEvent<HTMLDivElement>, folder: RubatoFolder) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "rename", label: "Rename folder" },
        { id: "delete", label: "Delete folder…", destructive: true },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === "rename") setNaming({ folderId: folder.id });
    else if (clicked === "delete") props.onDeleteFolder(folder);
  };
  const finishNaming = (name: string | null) => {
    const current = naming;
    setNaming(null);
    if (current === null || name === null) return;
    if (current.folderId === null) {
      props.onCreateFolder(name);
      return;
    }
    const folder = props.folders.find((candidate) => candidate.id === current.folderId);
    if (folder) props.onRenameFolder(folder, name);
  };
  const rowIndex = (key: string) =>
    rows.findIndex((row) => row.kind === "project" && row.group.projectKey === key);
  const folderRowIndex = (folderId: string) =>
    rows.findIndex((row) => row.kind === "folder" && row.folder.id === folderId);
  const renderRow = (group: SidebarProjectSnapshot, listed: boolean) => (
    <ProjectRow
      key={group.projectKey}
      group={group}
      listed={listed}
      selected={props.scopeKey === group.projectKey}
      highlighted={highlight === rowIndex(group.projectKey)}
      sortable={listed && !searching}
      signal={urgentSignal(props.signals.get(group.projectKey))}
      activity={activityLabel(props.lastActivity.get(group.projectKey))}
      onChoose={() => props.onChoose(group.projectKey)}
      onToggleListed={() =>
        listed ? props.onRemove(group.projectKey) : props.onAdd(group.projectKey)
      }
      onContextMenu={(event) => void showMenu(event, group, listed)}
    />
  );

  return (
    <div className="flex w-[17rem] flex-col p-1.5" data-rubato-project-picker="">
      <label className="mb-1 flex h-8 items-center gap-2 rounded-md bg-black/15 px-2.5 text-sm dark:bg-black/20">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Find a folder or project"
          aria-label="Find a folder or project"
          className="min-w-0 flex-1 bg-transparent outline-hidden placeholder:text-muted-foreground"
        />
      </label>
      <div role="listbox" aria-label="Projects" className="max-h-[min(28rem,70vh)] overflow-y-auto overscroll-contain">
        {searching ? null : (
          <div
            role="option"
            aria-selected={props.scopeKey === null && props.folderScopeId === null}
            onClick={() => props.onChoose(null)}
            className={cn(
              "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-sm text-foreground/90",
              props.scopeKey === null && props.folderScopeId === null
                ? "bg-accent text-foreground"
                : "hover:bg-accent/60",
              highlight === 0 && (props.scopeKey !== null || props.folderScopeId !== null) && "bg-accent/60",
            )}
          >
            <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">All projects</span>
          </div>
        )}
        {!searching || visibleFolders.length > 0 ? (
          <>
            <div className="flex items-center justify-between pt-2.5 pr-1 pb-1 pl-2.5 text-xs font-medium text-muted-foreground">
              Folders
              {searching ? null : (
                <button
                  type="button"
                  aria-label="New folder"
                  title="New folder"
                  onClick={() => setNaming({ folderId: null })}
                  className="flex h-5 items-center gap-1 rounded-md px-1.5 text-xs font-normal text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground"
                >
                  <FolderPlusIcon className="size-3.5" />
                  New
                </button>
              )}
            </div>
            {visibleFolders.map((folder, index) =>
              naming?.folderId === folder.id ? (
                <FolderNameField key={folder.id} initial={folder.name} onDone={finishNaming} />
              ) : (
                <FolderRow
                  key={folder.id}
                  folder={folder}
                  shortcut={!searching && index < 9 ? index + 1 : null}
                  selected={props.folderScopeId === folder.id}
                  highlighted={highlight === folderRowIndex(folder.id)}
                  onChoose={() => props.onChooseFolder(folder.id)}
                  onContextMenu={(event) => void showFolderMenu(event, folder)}
                />
              ),
            )}
            {naming?.folderId === null ? <FolderNameField initial="" onDone={finishNaming} /> : null}
            {!searching && props.folders.length === 0 && naming === null ? (
              <p className="px-2.5 py-1 text-xs text-muted-foreground/70">
                Group threads from any project. Right-click a thread to file it.
              </p>
            ) : null}
          </>
        ) : null}
        {visible.listed.length > 0 ? (
          <>
            <div className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
              My projects
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={visible.listed.map((group) => group.projectKey)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col">{visible.listed.map((group) => renderRow(group, true))}</div>
              </SortableContext>
            </DndContext>
          </>
        ) : null}
        {visible.quiet.length > 0 ? (
          <>
            <div className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
              Other projects
            </div>
            {visible.quiet.map((group) => renderRow(group, false))}
          </>
        ) : null}
        {searching && rows.length === 0 ? (
          <p className="px-2.5 py-3 text-sm text-muted-foreground">No matching projects.</p>
        ) : null}
      </div>
      <div aria-hidden="true" className="mx-1 my-1 h-px bg-border" />
      <button
        type="button"
        onClick={props.onAddProject}
        className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground outline-hidden hover:bg-accent/60 hover:text-foreground"
      >
        <PlusIcon className="size-4 shrink-0" />
        Add project
      </button>
      <button
        type="button"
        onClick={props.onEditProjects}
        className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground outline-hidden hover:bg-accent/60 hover:text-foreground"
      >
        <PencilIcon className="size-4 shrink-0" />
        Edit projects
      </button>
    </div>
  );
}
