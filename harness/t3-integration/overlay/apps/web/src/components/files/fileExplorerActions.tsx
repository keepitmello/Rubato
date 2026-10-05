import type { FileTreeRenameEvent, FileTreeRenamingConfig } from "@pierre/trees";
import type { useFileTree } from "@pierre/trees/react";
import type { ContextMenuItem, EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FilePlusIcon, FolderPlusIcon } from "lucide-react";
import { type RefObject, useCallback, useMemo, useRef } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { resolvePathLinkTarget } from "~/terminal-links";

/**
 * The explorer's IDE-style actions: new file and folder, rename, move to trash,
 * copy path, double-click to keep a preview tab. Names are typed in the tree
 * row itself (the tree's inline rename), as in VS Code and Zed.
 */

type TreeModel = ReturnType<typeof useFileTree>["model"];
type EntryKind = ProjectEntry["kind"];

/** Files the OS leaves in folders. They are never what anyone browses for. */
const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "Icon\r"]);

export function isHiddenExplorerEntry(path: string): boolean {
  return OS_JUNK.has(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * The tree splits a long name into segments to truncate its middle, and a
 * segment that starts with a space ("untitled| folder") lost that space to
 * whitespace collapsing, so the row read "untitledfolder".
 */
export const EXPLORER_TREE_CSS = "\n[data-truncate-content] { white-space: pre; }\n";

export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function joinPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

/** `untitled`, then `untitled 2`, … — the first name not taken in `directory`. */
export function uniqueChildName(
  taken: (path: string) => boolean,
  directory: string,
  base: string,
): string {
  for (let index = 1; ; index++) {
    const name = index === 1 ? base : `${base} ${index}`;
    if (!taken(joinPath(directory, name))) return name;
  }
}

/** Tree paths after `from` moved to `to`. Folder rows end in "/" and move with their contents. */
export function remapTreePaths(paths: readonly string[], from: string, to: string): string[] {
  return paths.map((path) => {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}/${path.slice(from.length + 1)}`;
    return path;
  });
}

const treePathOf = (path: string, kind: EntryKind) => (kind === "directory" ? `${path}/` : path);
const stripSlash = (path: string) => path.replace(/\/$/, "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const MENU = {
  newFile: "rubato:new-file",
  newFolder: "rubato:new-folder",
  copyPath: "rubato:copy-path",
  copyRelativePath: "rubato:copy-relative-path",
  rename: "rubato:rename",
  trash: "rubato:trash",
} as const;
type MenuAction = (typeof MENU)[keyof typeof MENU];
const MENU_ACTIONS = new Set<string>(Object.values(MENU));

export const EXPLORER_MENU_ITEMS: readonly ContextMenuItem[] = [
  { id: MENU.newFile, label: "New File…", separatorBefore: true },
  { id: MENU.newFolder, label: "New Folder…" },
  { id: MENU.copyPath, label: "Copy Path", separatorBefore: true },
  { id: MENU.copyRelativePath, label: "Copy Relative Path" },
  { id: MENU.rename, label: "Rename…", separatorBefore: true },
  { id: MENU.trash, label: "Move to Trash", destructive: true },
];

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

function isTextInput(event: Event): boolean {
  const target = event.composedPath()[0];
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function rowPathOf(event: Event): string | null {
  for (const node of event.composedPath()) {
    if (node instanceof Element) {
      const path = node.getAttribute("data-item-path");
      if (path !== null) return path;
    }
  }
  return null;
}

export interface FileExplorerActionsInput {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly modelRef: RefObject<TreeModel | null>;
  readonly entryKinds: ReadonlyMap<string, EntryKind>;
  /** What the tree model holds; local moves are mirrored here so a refresh does not replay them. */
  readonly previousTreePathsRef: RefObject<readonly string[] | null>;
  readonly refresh: () => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPinFile?: ((relativePath: string) => void) | undefined;
  readonly onEntryRenamed?: ((from: string, to: string) => void) | undefined;
  readonly onEntryRemoved?: ((relativePath: string) => void) | undefined;
}

export function useFileExplorerActions(input: FileExplorerActionsInput) {
  const createFile = useAtomCommand(projectEnvironment.createFile, { reportFailure: false });
  const manageEntry = useAtomCommand(projectEnvironment.manageEntry, { reportFailure: false });
  const latest = useRef({ input, createFile, manageEntry });
  latest.current = { input, createFile, manageEntry };
  // A new entry is a placeholder row being named. The tree reports a rename
  // only when the name changed, so an unchanged commit is resolved here.
  const pendingCreate = useRef<{ treePath: string; path: string; kind: EntryKind } | null>(null);

  const mirror = (update: (paths: readonly string[]) => readonly string[]) => {
    const ref = latest.current.input.previousTreePathsRef;
    if (ref.current !== null) ref.current = update(ref.current);
  };

  const create = async (kind: EntryKind, path: string) => {
    const { input: current, createFile, manageEntry } = latest.current;
    const { environmentId, cwd } = current;
    const result =
      kind === "file"
        ? await createFile({ environmentId, input: { cwd, relativePath: path, contents: "" } })
        : await manageEntry({
            environmentId,
            input: { cwd, operation: "create-directory", relativePath: path },
          });
    const treePath = treePathOf(path, kind);
    if (result._tag !== "Success") {
      current.modelRef.current?.remove(treePath, kind === "directory" ? { recursive: true } : {});
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: kind === "file" ? "Could not create the file" : "Could not create the folder",
          description: failureMessage(result),
        });
      }
      return;
    }
    mirror((paths) => [...paths, treePath]);
    current.refresh();
    if (kind === "file") {
      current.onOpenFile(path);
      current.onPinFile?.(path);
    }
  };

  const rename = async (from: string, to: string, kind: EntryKind) => {
    const { input: current, manageEntry } = latest.current;
    const result = await manageEntry({
      environmentId: current.environmentId,
      input: { cwd: current.cwd, operation: "rename", relativePath: from, nextRelativePath: to },
    });
    if (result._tag !== "Success") {
      // The tree already shows the new name; put the row back.
      current.modelRef.current?.move(treePathOf(to, kind), treePathOf(from, kind));
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not rename '${nameOf(from)}'`,
          description: failureMessage(result),
        });
      }
      return;
    }
    mirror((paths) => remapTreePaths(paths, from, to));
    current.refresh();
    current.onEntryRenamed?.(from, to);
  };

  const trash = async (path: string, kind: EntryKind) => {
    const { input: current, manageEntry } = latest.current;
    const what = kind === "directory" ? "folder" : "file";
    const message = `Move the ${what} '${nameOf(path)}' to the Trash?\n\nYou can restore it from the Trash.`;
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(message, { variant: "destructive" })
      : window.confirm(message);
    if (!confirmed) return;
    const result = await manageEntry({
      environmentId: current.environmentId,
      input: { cwd: current.cwd, operation: "trash", relativePath: path },
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not move '${nameOf(path)}' to the Trash`,
          description: failureMessage(result),
        });
      }
      return;
    }
    current.refresh();
    current.onEntryRemoved?.(path);
  };

  const copy = async (text: string, title: string) => {
    try {
      await writeTextToClipboard(text);
      toastManager.add({ type: "success", title, description: text });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  /** The folder a new entry goes in: the folder itself, or a file's folder. */
  const targetDirectory = (path: string | null): string => {
    if (path === null) return "";
    const relative = stripSlash(path);
    return latest.current.input.entryKinds.get(relative) === "directory"
      ? relative
      : parentDirectory(relative);
  };

  const startCreate = (kind: EntryKind, at: string | null) => {
    const { input: current } = latest.current;
    const model = current.modelRef.current;
    if (!model) return;
    const directory = targetDirectory(at ?? model.getFocusedPath());
    const folder = directory ? model.getItem(`${directory}/`) : null;
    if (folder && "expand" in folder) folder.expand();
    const name = uniqueChildName(
      (path) => current.entryKinds.has(path) || model.getItem(path) !== null || model.getItem(`${path}/`) !== null,
      directory,
      kind === "file" ? "untitled" : "untitled folder",
    );
    const path = joinPath(directory, name);
    const treePath = treePathOf(path, kind);
    model.add(treePath);
    pendingCreate.current = { treePath, path, kind };
    if (!model.startRenaming(treePath, { removeIfCanceled: true })) {
      model.remove(treePath, kind === "directory" ? { recursive: true } : {});
      pendingCreate.current = null;
    }
  };

  /** After the name input closes: create under the unchanged name if no rename came. */
  const settlePendingCreate = () => {
    setTimeout(() => {
      const pending = pendingCreate.current;
      if (pending === null) return;
      pendingCreate.current = null;
      // Escape and an emptied name remove the placeholder row.
      if (latest.current.input.modelRef.current?.getItem(pending.treePath) == null) return;
      void create(pending.kind, pending.path);
    }, 0);
  };

  const renaming = useMemo<FileTreeRenamingConfig>(
    () => ({
      onRename: (event: FileTreeRenameEvent) => {
        const from = stripSlash(event.sourcePath);
        const to = stripSlash(event.destinationPath);
        const kind: EntryKind = event.isFolder ? "directory" : "file";
        const pending = pendingCreate.current;
        if (pending !== null && pending.path === from) {
          pendingCreate.current = null;
          void create(pending.kind, to);
          return;
        }
        void rename(from, to, kind);
      },
      onError: (error: string) => {
        toastManager.add({ type: "error", title: "Could not rename", description: error });
      },
    }),
    // The callbacks read `latest`, so the tree keeps one config for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handlesMenuItem = (id: string): id is MenuAction => MENU_ACTIONS.has(id);

  const activateMenuItem = (id: MenuAction, path: string, kind: EntryKind) => {
    const { input: current } = latest.current;
    switch (id) {
      case MENU.newFile:
      case MENU.newFolder:
        // After the native menu has closed and handed focus back to the row.
        setTimeout(() => startCreate(id === MENU.newFile ? "file" : "directory", treePathOf(path, kind)), 0);
        return;
      case MENU.rename:
        setTimeout(() => current.modelRef.current?.startRenaming(treePathOf(path, kind)), 0);
        return;
      case MENU.trash:
        void trash(path, kind);
        return;
      case MENU.copyPath:
        void copy(resolvePathLinkTarget(path, current.cwd), "Path copied");
        return;
      case MENU.copyRelativePath:
        void copy(path, "Relative path copied");
        return;
    }
  };

  /** Keyboard, double-click and name-input listeners on the explorer panel. */
  const attach = useCallback((panel: HTMLElement) => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInput(event)) {
        if (event.key === "Enter" || event.key === "Escape") settlePendingCreate();
        return;
      }
      const deletes = event.key === "Delete" || (event.key === "Backspace" && event.metaKey);
      if (!deletes) return;
      // Only from a focused row, never from the toolbar or the search field.
      const row = rowPathOf(event);
      if (row === null) return;
      event.preventDefault();
      const path = stripSlash(row);
      void trash(path, latest.current.input.entryKinds.get(path) ?? "file");
    };
    const onFocusOut = (event: FocusEvent) => {
      if (isTextInput(event)) settlePendingCreate();
    };
    const onDoubleClick = (event: MouseEvent) => {
      const row = rowPathOf(event);
      if (row === null || row.endsWith("/")) return;
      if (latest.current.input.entryKinds.get(row) === "file") latest.current.input.onPinFile?.(row);
    };
    panel.addEventListener("keydown", onKeyDown);
    panel.addEventListener("focusout", onFocusOut);
    panel.addEventListener("dblclick", onDoubleClick);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
      panel.removeEventListener("focusout", onFocusOut);
      panel.removeEventListener("dblclick", onDoubleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    renaming,
    attach,
    startCreate,
    handlesMenuItem,
    activateMenuItem,
  };
}

function ToolbarButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** New file and new folder, created in the focused folder (or the focused file's). */
export function NewEntryButtons(props: { onCreate: (kind: EntryKind) => void }) {
  return (
    <>
      <ToolbarButton label="New File…" onClick={() => props.onCreate("file")}>
        <FilePlusIcon className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label="New Folder…" onClick={() => props.onCreate("directory")}>
        <FolderPlusIcon className="size-3.5" />
      </ToolbarButton>
    </>
  );
}
