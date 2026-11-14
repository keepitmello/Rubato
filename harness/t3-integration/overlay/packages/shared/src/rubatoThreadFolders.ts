// Thread folders: folders the user makes and fills by hand, across projects
// (thread-folders-edits.mjs). They live in the server settings of the Mac that
// runs the threads, so the desktop and the phone read and change the same
// folders, and the settings stream carries each change to both.
//
//   rubatoThreadFolders   folder id -> { name, createdAt }
//   rubatoThreadFolderOf  thread id -> folder id
//
// A patch carries only the entries it changes and null removes one, so two
// devices filing different threads at once do not overwrite each other.

export interface RubatoThreadFolderEntry {
  readonly name: string;
  readonly createdAt: string;
}

export interface RubatoThreadFolderSettings {
  readonly rubatoThreadFolders?: Readonly<Record<string, RubatoThreadFolderEntry>> | undefined;
  readonly rubatoThreadFolderOf?: Readonly<Record<string, string>> | undefined;
}

export interface RubatoThreadFolderPatch {
  rubatoThreadFolders?: Record<string, RubatoThreadFolderEntry | null>;
  rubatoThreadFolderOf?: Record<string, string | null>;
}

export interface RubatoThreadFolder {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** Threads filed here; a thread the server no longer lists still counts until it is moved. */
  readonly threadCount: number;
}

export const RUBATO_FOLDER_NAME_MAX = 60;

/** The name as stored: trimmed, one line, at most RUBATO_FOLDER_NAME_MAX characters; null when empty. */
export function normalizeFolderName(name: string): string | null {
  const flat = name.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return Array.from(flat).slice(0, RUBATO_FOLDER_NAME_MAX).join("");
}

/** Folders in the order they were made, each with how many threads it holds. */
export function listThreadFolders(
  settings: RubatoThreadFolderSettings | null | undefined,
): ReadonlyArray<RubatoThreadFolder> {
  const folders = settings?.rubatoThreadFolders ?? {};
  const counts = new Map<string, number>();
  for (const folderId of Object.values(settings?.rubatoThreadFolderOf ?? {})) {
    counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
  }
  return Object.entries(folders)
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      createdAt: entry.createdAt,
      threadCount: counts.get(id) ?? 0,
    }))
    // `.sort()` on the fresh array, not `.toSorted()`: the phone runs this on Hermes, which has
    // no ES2023 array methods.
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

/** The folder a thread is filed in, or null; a folder that was deleted files nothing. */
export function threadFolderId(
  settings: RubatoThreadFolderSettings | null | undefined,
  threadId: string,
): string | null {
  const folderId = settings?.rubatoThreadFolderOf?.[threadId];
  if (folderId === undefined) return null;
  return settings?.rubatoThreadFolders?.[folderId] !== undefined ? folderId : null;
}

/** A new folder's id: unique enough for one person's folders on one Mac. */
export function newThreadFolderId(nowMs: number, random: () => number = Math.random): string {
  return `f${nowMs.toString(36)}${Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")}`;
}

/** Make a folder, and file the threads given into it. Null when the name is empty. */
export function createThreadFolderPatch(input: {
  readonly id: string;
  readonly name: string;
  readonly now: string;
  readonly threadIds?: ReadonlyArray<string>;
}): RubatoThreadFolderPatch | null {
  const name = normalizeFolderName(input.name);
  if (name === null) return null;
  const threadIds = input.threadIds ?? [];
  return {
    rubatoThreadFolders: { [input.id]: { name, createdAt: input.now } },
    ...(threadIds.length > 0
      ? { rubatoThreadFolderOf: Object.fromEntries(threadIds.map((threadId) => [threadId, input.id])) }
      : {}),
  };
}

/** Rename a folder in place. Null when the folder is gone, or the name is empty or unchanged. */
export function renameThreadFolderPatch(
  settings: RubatoThreadFolderSettings | null | undefined,
  folderId: string,
  name: string,
): RubatoThreadFolderPatch | null {
  const entry = settings?.rubatoThreadFolders?.[folderId];
  const next = normalizeFolderName(name);
  if (entry === undefined || next === null || next === entry.name) return null;
  return { rubatoThreadFolders: { [folderId]: { ...entry, name: next } } };
}

/** Delete a folder. Its threads stay where they are and leave the folder. */
export function deleteThreadFolderPatch(
  settings: RubatoThreadFolderSettings | null | undefined,
  folderId: string,
): RubatoThreadFolderPatch {
  const filed = Object.entries(settings?.rubatoThreadFolderOf ?? {}).filter(
    ([, filedIn]) => filedIn === folderId,
  );
  return {
    rubatoThreadFolders: { [folderId]: null },
    ...(filed.length > 0
      ? { rubatoThreadFolderOf: Object.fromEntries(filed.map(([threadId]) => [threadId, null])) }
      : {}),
  };
}

/** File threads into a folder, or take them out of theirs with null. */
export function moveThreadsToFolderPatch(
  threadIds: ReadonlyArray<string>,
  folderId: string | null,
): RubatoThreadFolderPatch {
  return {
    rubatoThreadFolderOf: Object.fromEntries(threadIds.map((threadId) => [threadId, folderId])),
  };
}

/** The threads of one folder, in the order they came. */
export function threadsInFolder<T extends { readonly id: string }>(
  threads: ReadonlyArray<T>,
  settings: RubatoThreadFolderSettings | null | undefined,
  folderId: string,
): ReadonlyArray<T> {
  return threads.filter((thread) => threadFolderId(settings, thread.id) === folderId);
}

