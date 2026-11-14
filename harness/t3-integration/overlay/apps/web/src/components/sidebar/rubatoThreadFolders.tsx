// Thread folders on the desktop (thread-folders-edits.mjs). The folders and what each holds
// are the server settings of the Mac that runs the threads (packages/shared/src/
// rubatoThreadFolders.ts), so the phone shows the same ones. Choosing a folder narrows the
// sidebar the way choosing a project does, and the two replace each other: the rail's
// Projects window lists folders above projects (RubatoProjectPicker.tsx), a thread's context
// menu files it, and a thread started while a folder is chosen goes into that folder.
import { useAtomValue } from "@effect/atom-react";
import type { ContextMenuItem, EnvironmentId, ServerSettings } from "@t3tools/contracts";
import {
  createThreadFolderPatch,
  deleteThreadFolderPatch,
  listThreadFolders,
  moveThreadsToFolderPatch,
  newThreadFolderId,
  normalizeFolderName,
  RUBATO_FOLDER_NAME_MAX,
  renameThreadFolderPatch,
  threadFolderId,
  type RubatoThreadFolder,
  type RubatoThreadFolderPatch,
} from "@t3tools/shared/rubatoThreadFolders";
import { FolderIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export interface RubatoFolder extends RubatoThreadFolder {
  readonly environmentId: EnvironmentId;
}

type ThreadRefLike = { readonly environmentId: EnvironmentId; readonly id: string };

// ── The chosen folder: this window's choice, kept across restarts like the project scope ──

const SCOPE_KEY = "rubato:thread-folder-scope";
const scopeListeners = new Set<() => void>();
let scopeValue: string | null | undefined;

function readScope(): string | null {
  if (scopeValue !== undefined) return scopeValue;
  try {
    scopeValue = window.localStorage.getItem(SCOPE_KEY);
  } catch {
    scopeValue = null;
  }
  return scopeValue;
}

export function setRubatoFolderScope(folderId: string | null): void {
  if (readScope() === folderId) return;
  scopeValue = folderId;
  try {
    if (folderId === null) window.localStorage.removeItem(SCOPE_KEY);
    else window.localStorage.setItem(SCOPE_KEY, folderId);
  } catch {
    // The choice still holds for this run.
  }
  for (const listener of scopeListeners) listener();
}

function subscribeScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => scopeListeners.delete(listener);
}

export function useRubatoFolderScope(): string | null {
  return useSyncExternalStore(subscribeScope, readScope, () => null);
}

// ── Folders as the servers hold them ──

export interface RubatoThreadFolders {
  /** Every connected Mac's folders, each Mac's in the order they were made. */
  readonly folders: ReadonlyArray<RubatoFolder>;
  readonly byId: ReadonlyMap<string, RubatoFolder>;
  /** False until some server's settings have arrived: an unknown folder is not yet a deleted one. */
  readonly loaded: boolean;
  readonly folderOf: (thread: ThreadRefLike) => RubatoFolder | null;
  readonly foldersOn: (environmentId: EnvironmentId) => ReadonlyArray<RubatoFolder>;
  readonly settingsOf: (environmentId: EnvironmentId) => ServerSettings | null;
}

export function useRubatoThreadFolders(): RubatoThreadFolders {
  const configs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(() => {
    const settingsOf = (environmentId: EnvironmentId) => configs.get(environmentId)?.settings ?? null;
    const folders = [...configs.entries()].flatMap(([environmentId, config]) =>
      listThreadFolders(config.settings).map((folder) => ({ ...folder, environmentId })),
    );
    const byId = new Map(folders.map((folder) => [folder.id, folder] as const));
    return {
      folders,
      byId,
      loaded: configs.size > 0,
      folderOf: (thread) => {
        const id = threadFolderId(settingsOf(thread.environmentId), thread.id);
        return id === null ? null : (byId.get(id) ?? null);
      },
      foldersOn: (environmentId) => folders.filter((folder) => folder.environmentId === environmentId),
      settingsOf,
    };
  }, [configs]);
}

export interface RubatoFolderActions {
  /** Makes a folder on that Mac and files the threads given; resolves to its id, or null. */
  readonly create: (
    environmentId: EnvironmentId,
    name: string,
    threadIds?: ReadonlyArray<string>,
  ) => Promise<string | null>;
  readonly rename: (folder: RubatoFolder, name: string) => Promise<boolean>;
  readonly remove: (folder: RubatoFolder) => Promise<boolean>;
  readonly move: (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<string>,
    folderId: string | null,
  ) => Promise<boolean>;
}

export function useRubatoFolderActions(folders: RubatoThreadFolders): RubatoFolderActions {
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "thread folders update",
    reportFailure: true,
  });
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const write = useCallback(
    async (environmentId: EnvironmentId, patch: RubatoThreadFolderPatch | null) => {
      if (patch === null) return false;
      const result = await update({ environmentId, input: { patch } });
      return result._tag === "Success";
    },
    [update],
  );
  return useMemo(
    () => ({
      create: async (environmentId, name, threadIds) => {
        const id = newThreadFolderId(Date.now());
        const patch = createThreadFolderPatch({
          id,
          name,
          now: new Date().toISOString(),
          ...(threadIds ? { threadIds } : {}),
        });
        return (await write(environmentId, patch)) ? id : null;
      },
      rename: (folder, name) =>
        write(
          folder.environmentId,
          renameThreadFolderPatch(foldersRef.current.settingsOf(folder.environmentId), folder.id, name),
        ),
      remove: (folder) =>
        write(
          folder.environmentId,
          deleteThreadFolderPatch(foldersRef.current.settingsOf(folder.environmentId), folder.id),
        ),
      move: (environmentId, threadIds, folderId) =>
        write(environmentId, moveThreadsToFolderPatch(threadIds, folderId)),
    }),
    [write],
  );
}

/**
 * The folder the sidebar is narrowed to. A project chosen anywhere (the rail, the home row,
 * a thread's "filter by project") replaces it, and a folder another device deleted lets go.
 */
export function useRubatoFolderScopeState(
  folders: RubatoThreadFolders,
  projectScopeKey: string | null,
): RubatoFolder | null {
  const folderId = useRubatoFolderScope();
  const folder = folderId === null ? null : (folders.byId.get(folderId) ?? null);
  useEffect(() => {
    if (folderId === null) return;
    if (projectScopeKey !== null || (folders.loaded && folder === null)) setRubatoFolderScope(null);
  }, [folder, folderId, folders.loaded, projectScopeKey]);
  return projectScopeKey === null ? folder : null;
}

/**
 * A thread started while a folder is chosen goes into that folder: a draft that appears then
 * is remembered, and filed once it becomes a thread on that folder's Mac.
 */
const pendingDrafts = new Map<string, RubatoFolder>();

export function useRubatoFolderDraftCapture(folder: RubatoFolder | null, actions: RubatoFolderActions) {
  const folderRef = useRef(folder);
  folderRef.current = folder;
  useEffect(
    () =>
      useComposerDraftStore.subscribe((state, previous) => {
        if (state.draftThreadsByThreadKey === previous.draftThreadsByThreadKey) return;
        for (const [key, draft] of Object.entries(state.draftThreadsByThreadKey)) {
          const pending = pendingDrafts.get(key);
          if (pending !== undefined) {
            const promotedTo = draft.promotedTo;
            if (promotedTo != null) {
              pendingDrafts.delete(key);
              if (promotedTo.environmentId === pending.environmentId) {
                void actions.move(pending.environmentId, [promotedTo.threadId], pending.id);
              }
            }
            continue;
          }
          const current = folderRef.current;
          if (
            current !== null &&
            previous.draftThreadsByThreadKey[key] === undefined &&
            draft.promotedTo == null &&
            draft.environmentId === current.environmentId
          ) {
            pendingDrafts.set(key, current);
          }
        }
        for (const key of pendingDrafts.keys()) {
          if (state.draftThreadsByThreadKey[key] === undefined) pendingDrafts.delete(key);
        }
      }),
    [actions],
  );
}

// ── A thread's context menu ──

export type RubatoFolderMenuId =
  | `rubato-folder:move:${string}`
  | "rubato-folder:menu"
  | "rubato-folder:new"
  | "rubato-folder:out";

export function isRubatoFolderMenuId(id: string): id is RubatoFolderMenuId {
  return id.startsWith("rubato-folder:");
}

/** "Move to folder" with the thread's folder checked, after Pin/Unpin (or first). */
export function withRubatoFolderMenu<T extends string>(
  folders: RubatoThreadFolders,
  thread: ThreadRefLike,
  items: ReadonlyArray<ContextMenuItem<T>>,
): ContextMenuItem<T | RubatoFolderMenuId>[] {
  if (folders.settingsOf(thread.environmentId) === null) return [...items];
  const current = folders.folderOf(thread);
  const children: ContextMenuItem<RubatoFolderMenuId>[] = [
    ...folders.foldersOn(thread.environmentId).map((folder) => ({
      id: `rubato-folder:move:${folder.id}` as const,
      label: folder.name,
      checked: current?.id === folder.id,
    })),
    { id: "rubato-folder:new", label: "New folder…", separatorBefore: true },
    ...(current !== null
      ? [{ id: "rubato-folder:out" as const, label: `Remove from ${current.name}` }]
      : []),
  ];
  const menu: ContextMenuItem<RubatoFolderMenuId> = {
    id: "rubato-folder:menu",
    label: "Move to folder",
    icon: "folder",
    children,
  };
  const pinIndex = items.findIndex((item) => item.id === "pin" || item.id === "unpin");
  const at = pinIndex === -1 ? 0 : pinIndex + 1;
  return [...items.slice(0, at), menu, ...items.slice(at)];
}

/** Carries out a folder choice from a thread's menu. */
export async function runRubatoFolderMenu(
  id: RubatoFolderMenuId,
  thread: ThreadRefLike,
  actions: RubatoFolderActions,
): Promise<void> {
  if (id === "rubato-folder:menu") return;
  if (id === "rubato-folder:out") {
    await actions.move(thread.environmentId, [thread.id], null);
    return;
  }
  if (id === "rubato-folder:new") {
    const name = await promptFolderName("New folder", "");
    if (name !== null) await actions.create(thread.environmentId, name, [thread.id]);
    return;
  }
  await actions.move(thread.environmentId, [thread.id], id.slice("rubato-folder:move:".length));
}

// ── Naming a folder from a menu: one dialog the rail hosts ──

type NameRequest = {
  readonly title: string;
  readonly initial: string;
  readonly resolve: (name: string | null) => void;
};
let nameRequest: NameRequest | null = null;
let nameHosts = 0;
const nameListeners = new Set<() => void>();
const publishName = (next: NameRequest | null) => {
  nameRequest = next;
  for (const listener of nameListeners) listener();
};

/** Asks for a folder name; null when cancelled, or when no window can ask (no rail). */
export function promptFolderName(title: string, initial: string): Promise<string | null> {
  if (nameHosts === 0) return Promise.resolve(null);
  nameRequest?.resolve(null);
  return new Promise((resolve) => publishName({ title, initial, resolve }));
}

export function RubatoFolderNameDialogHost() {
  const request = useSyncExternalStore(
    (listener) => {
      nameListeners.add(listener);
      return () => nameListeners.delete(listener);
    },
    () => nameRequest,
    () => null,
  );
  useEffect(() => {
    nameHosts += 1;
    return () => {
      nameHosts -= 1;
    };
  }, []);
  if (request === null) return null;
  return <FolderNameDialog key={request.title + request.initial} request={request} />;
}

function FolderNameDialog(props: { request: NameRequest }) {
  const [name, setName] = useState(props.request.initial);
  const finish = (value: string | null) => {
    if (nameRequest !== props.request) return;
    publishName(null);
    props.request.resolve(value === null ? null : normalizeFolderName(value));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (normalizeFolderName(name) !== null) finish(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              value={name}
              placeholder="Folder name"
              aria-label="Folder name"
              maxLength={RUBATO_FOLDER_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={normalizeFolderName(name) === null}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// ── The list's title while a folder is chosen ──

export function RubatoFolderScopeLabel(props: { folder: RubatoFolder; count: number }) {
  return (
    <h2
      data-rubato-scope-label=""
      data-rubato-block-handle="threads"
      className="group/folder-title flex min-w-0 items-center gap-2 px-2 pt-2 pb-1 text-base font-semibold text-sidebar-foreground"
    >
      <FolderIcon aria-hidden className="size-5 shrink-0 fill-current/15 text-muted-foreground" />
      <span className="min-w-0 truncate">{props.folder.name}</span>
      <span className="shrink-0 text-xs font-normal tabular-nums text-sidebar-muted-foreground/70">
        {props.count}
      </span>
      <button
        type="button"
        aria-label="Show all threads"
        title="Show all threads"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setRubatoFolderScope(null)}
        className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground/70 opacity-0 transition-opacity group-hover/folder-title:opacity-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </h2>
  );
}
