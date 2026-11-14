import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  RUBATO_FOLDER_NAME_MAX,
  createThreadFolderPatch,
  deleteThreadFolderPatch,
  listThreadFolders,
  moveThreadsToFolderPatch,
  newThreadFolderId,
  normalizeFolderName,
  renameThreadFolderPatch,
  threadFolderId,
  threadsInFolder,
} from "./rubatoThreadFolders.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const NOW = "2026-11-14T00:00:00.000Z";

function settingsWith(patches: ReadonlyArray<Parameters<typeof applyServerSettingsPatch>[1]>) {
  return patches.reduce(applyServerSettingsPatch, DEFAULT_SERVER_SETTINGS);
}

describe("thread folders in server settings", () => {
  it("start empty", () => {
    expect(DEFAULT_SERVER_SETTINGS.rubatoThreadFolders).toEqual({});
    expect(DEFAULT_SERVER_SETTINGS.rubatoThreadFolderOf).toEqual({});
    expect(listThreadFolders(DEFAULT_SERVER_SETTINGS)).toEqual([]);
  });

  it("make a folder with its first thread, then file another", () => {
    const settings = settingsWith([
      createThreadFolderPatch({ id: "a", name: "  Research ", now: NOW, threadIds: ["t1"] })!,
      moveThreadsToFolderPatch(["t2"], "a"),
    ]);
    expect(listThreadFolders(settings)).toEqual([
      { id: "a", name: "Research", createdAt: NOW, threadCount: 2 },
    ]);
    expect(threadFolderId(settings, "t1")).toBe("a");
    expect(threadFolderId(settings, "t3")).toBeNull();
  });

  it("a move from one device keeps another device's filing", () => {
    const settings = settingsWith([
      createThreadFolderPatch({ id: "a", name: "A", now: NOW, threadIds: ["t1"] })!,
      createThreadFolderPatch({ id: "b", name: "B", now: NOW })!,
      moveThreadsToFolderPatch(["t2"], "b"),
      moveThreadsToFolderPatch(["t1"], null),
    ]);
    expect(settings.rubatoThreadFolderOf).toEqual({ t2: "b" });
    expect(Object.keys(settings.rubatoThreadFolders).toSorted()).toEqual(["a", "b"]);
  });

  it("deleting a folder unfiles its threads and leaves the others", () => {
    const before = settingsWith([
      createThreadFolderPatch({ id: "a", name: "A", now: NOW, threadIds: ["t1", "t2"] })!,
      createThreadFolderPatch({ id: "b", name: "B", now: NOW, threadIds: ["t3"] })!,
    ]);
    const after = applyServerSettingsPatch(before, deleteThreadFolderPatch(before, "a"));
    expect(after.rubatoThreadFolders).toEqual({ b: { name: "B", createdAt: NOW } });
    expect(after.rubatoThreadFolderOf).toEqual({ t3: "b" });
  });

  it("a thread pointing at a missing folder is not in a folder", () => {
    const settings = { rubatoThreadFolders: {}, rubatoThreadFolderOf: { t1: "gone" } };
    expect(threadFolderId(settings, "t1")).toBeNull();
    expect(threadsInFolder([{ id: "t1" }], settings, "gone")).toEqual([]);
  });

  it("rename changes only the name and skips an empty or unchanged one", () => {
    const settings = settingsWith([createThreadFolderPatch({ id: "a", name: "A", now: NOW })!]);
    expect(renameThreadFolderPatch(settings, "a", "B")).toEqual({
      rubatoThreadFolders: { a: { name: "B", createdAt: NOW } },
    });
    expect(renameThreadFolderPatch(settings, "a", " A ")).toBeNull();
    expect(renameThreadFolderPatch(settings, "a", "   ")).toBeNull();
    expect(renameThreadFolderPatch(settings, "missing", "B")).toBeNull();
  });

  it("folders list in the order they were made", () => {
    const settings = settingsWith([
      createThreadFolderPatch({ id: "late", name: "Z", now: "2026-11-14T02:00:00.000Z" })!,
      createThreadFolderPatch({ id: "early", name: "Y", now: "2026-11-14T01:00:00.000Z" })!,
    ]);
    expect(listThreadFolders(settings).map((folder: { readonly id: string }) => folder.id)).toEqual(["early", "late"]);
  });
});

describe("folder names and ids", () => {
  it("names are one trimmed line within the limit", () => {
    expect(normalizeFolderName(" a \n b ")).toBe("a b");
    expect(normalizeFolderName("  ")).toBeNull();
    expect(normalizeFolderName("가".repeat(RUBATO_FOLDER_NAME_MAX + 5))).toHaveLength(
      RUBATO_FOLDER_NAME_MAX,
    );
    expect(createThreadFolderPatch({ id: "a", name: " ", now: NOW })).toBeNull();
  });

  it("ids differ for folders made in the same millisecond", () => {
    const now = 1_794_000_000_000;
    expect(newThreadFolderId(now, () => 0.1)).not.toBe(newThreadFolderId(now, () => 0.2));
  });
});
