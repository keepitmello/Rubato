// Rubato: thread folders in the Threads tab (thread-folders-edits.mjs). The folders are the
// paired Mac's server settings (packages/shared/src/rubatoThreadFolders.ts), so they are the
// same as on the Mac and change here as soon as either side changes them. A Folder filter sits
// beside Project, and a thread's long-press menu files it.
import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import {
  createThreadFolderPatch,
  listThreadFolders,
  moveThreadsToFolderPatch,
  newThreadFolderId,
  threadFolderId,
  type RubatoThreadFolder,
  type RubatoThreadFolderPatch,
} from "@t3tools/shared/rubatoThreadFolders";
import { useCallback, useEffect, useMemo } from "react";
import { Alert } from "react-native";

import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useHomeListFolder } from "../home/home-list-options";
import { ListFilterMenu } from "../workspace/ListFilterMenu";

export interface RubatoMobileFolder extends RubatoThreadFolder {
  readonly environmentId: EnvironmentId;
}

type ThreadRefLike = { readonly environmentId: EnvironmentId; readonly id: string };

function useFolders() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(() => {
    const folders: RubatoMobileFolder[] = [...configs.entries()].flatMap(([environmentId, config]) =>
      listThreadFolders(config.settings).map((folder) => ({ ...folder, environmentId })),
    );
    return {
      folders,
      loaded: configs.size > 0,
      folderIdOf: (thread: ThreadRefLike) =>
        threadFolderId(configs.get(thread.environmentId)?.settings, thread.id),
      hasSettings: (environmentId: EnvironmentId) => configs.get(environmentId) !== undefined,
    };
  }, [configs]);
}

/** The list's threads in the chosen folder; every thread while none is chosen. */
export function useInRubatoFolder<T extends ThreadRefLike>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const [folderId, setFolderId] = useHomeListFolder();
  const { folders, loaded, folderIdOf } = useFolders();
  const exists = folderId !== null && folders.some((folder) => folder.id === folderId);
  // A folder deleted on the Mac lets go of the filter.
  useEffect(() => {
    if (folderId !== null && loaded && !exists) setFolderId(null);
  }, [exists, folderId, loaded, setFolderId]);
  return useMemo(
    () => (folderId === null || !exists ? threads : threads.filter((thread) => folderIdOf(thread) === folderId)),
    [exists, folderId, folderIdOf, threads],
  );
}

export function useRubatoFolderFilterActive(): readonly [boolean, () => void] {
  const [folderId, setFolderId] = useHomeListFolder();
  const clear = useCallback(() => setFolderId(null), [setFolderId]);
  return [folderId !== null, clear] as const;
}

/** The Folder filter beside Project; shown once there is a folder to choose. */
export function RubatoFolderFilter() {
  const [folderId, setFolderId] = useHomeListFolder();
  const { folders } = useFolders();
  if (folders.length === 0) return null;
  const selected = folders.find((folder) => folder.id === folderId);
  return (
    <ListFilterMenu
      label={selected?.name ?? "All folders"}
      accessibilityLabel="Filter threads by folder"
      active={selected !== undefined}
      actions={[
        { id: "all", title: "All folders", state: folderId === null ? "on" : "off" },
        ...folders.map((folder) => ({
          id: `folder:${folder.id}`,
          title: folder.name,
          subtitle: folder.threadCount === 1 ? "1 thread" : `${folder.threadCount} threads`,
          state: folder.id === folderId ? ("on" as const) : ("off" as const),
        })),
      ]}
      onSelect={(id) => setFolderId(id === "all" ? null : id.slice("folder:".length))}
    />
  );
}

const MENU_PREFIX = "rubato-folder:";

/** "Move to Folder" for a thread's long-press menu, and what its choices do. */
export function useRubatoThreadFolderMenu(thread: ThreadRefLike): {
  readonly items: MenuAction[];
  readonly handle: (event: string) => boolean;
} {
  const { folders, folderIdOf, hasSettings } = useFolders();
  const canWrite = useEnvironmentScope(thread.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "thread folders update",
    reportFailure: true,
  });
  const environmentId = thread.environmentId;
  const threadId = thread.id;
  const current = folderIdOf(thread);
  const write = useCallback(
    (patch: RubatoThreadFolderPatch | null) => {
      if (patch !== null) void update({ environmentId, input: { patch } });
    },
    [environmentId, update],
  );
  const items = useMemo<MenuAction[]>(() => {
    if (!canWrite || !hasSettings(environmentId)) return [];
    const here = folders.filter((folder) => folder.environmentId === environmentId);
    const currentFolder = here.find((folder) => folder.id === current);
    return [
      {
        id: `${MENU_PREFIX}menu`,
        title: "Move to Folder",
        image: "folder",
        subactions: [
          ...here.map((folder) => ({
            id: `${MENU_PREFIX}move:${folder.id}`,
            title: folder.name,
            image: "folder",
            state: folder.id === current ? ("on" as const) : ("off" as const),
          })),
          { id: `${MENU_PREFIX}new`, title: "New Folder…", image: "folder.badge.plus" },
          ...(currentFolder
            ? [
                {
                  id: `${MENU_PREFIX}out`,
                  title: `Remove from ${currentFolder.name}`,
                  image: "folder.badge.minus",
                },
              ]
            : []),
        ],
      },
    ];
  }, [canWrite, current, environmentId, folders, hasSettings]);
  const handle = useCallback(
    (event: string) => {
      if (!event.startsWith(MENU_PREFIX)) return false;
      const choice = event.slice(MENU_PREFIX.length);
      if (choice === "out") write(moveThreadsToFolderPatch([threadId], null));
      else if (choice.startsWith("move:"))
        write(moveThreadsToFolderPatch([threadId], choice.slice("move:".length)));
      else if (choice === "new")
        Alert.prompt("New Folder", "This thread moves into it.", (name) =>
          write(
            createThreadFolderPatch({
              id: newThreadFolderId(Date.now()),
              name: name ?? "",
              now: new Date().toISOString(),
              threadIds: [threadId],
            }),
          ),
        );
      return true;
    },
    [threadId, write],
  );
  return { items, handle };
}
