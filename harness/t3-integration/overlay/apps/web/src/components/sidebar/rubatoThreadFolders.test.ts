import type { ContextMenuItem, EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isRubatoFolderMenuId, withRubatoFolderMenu, type RubatoFolder, type RubatoThreadFolders } from "./rubatoThreadFolders";

const mac = "env-mac" as EnvironmentId;
const remote = "env-remote" as EnvironmentId;
const folder = (id: string, name: string, environmentId = mac): RubatoFolder => ({
  id,
  name,
  createdAt: "2026-11-14T00:00:00.000Z",
  threadCount: 0,
  environmentId,
});

function foldersOf(list: ReadonlyArray<RubatoFolder>, filed: Record<string, string>): RubatoThreadFolders {
  const byId = new Map(list.map((entry) => [entry.id, entry] as const));
  return {
    folders: list,
    byId,
    loaded: true,
    folderOf: (thread) => byId.get(filed[thread.id] ?? "") ?? null,
    foldersOn: (environmentId) => list.filter((entry) => entry.environmentId === environmentId),
    settingsOf: (environmentId) =>
      environmentId === mac || environmentId === remote ? ({} as ServerSettings) : null,
  };
}

const base: ContextMenuItem<"rename" | "pin" | "archive">[] = [
  { id: "rename", label: "Rename thread" },
  { id: "pin", label: "Pin thread" },
  { id: "archive", label: "Archive" },
];

describe("Move to folder in a thread's menu", () => {
  it("comes right after Pin, lists that Mac's folders and checks the current one", () => {
    const folders = foldersOf([folder("a", "Research"), folder("b", "Mac"), folder("c", "Other", remote)], {
      t1: "a",
    });
    const items = withRubatoFolderMenu(folders, { environmentId: mac, id: "t1" }, base);
    expect(items.map((item) => item.id)).toEqual(["rename", "pin", "rubato-folder:menu", "archive"]);
    expect(items[2]!.children?.map((child) => [child.id, child.label, child.checked ?? false])).toEqual([
      ["rubato-folder:move:a", "Research", true],
      ["rubato-folder:move:b", "Mac", false],
      ["rubato-folder:new", "New folder…", false],
      ["rubato-folder:out", "Remove from Research", false],
    ]);
  });

  it("offers no way out of a folder for a thread that is in none", () => {
    const items = withRubatoFolderMenu(foldersOf([folder("a", "Research")], {}), { environmentId: mac, id: "t9" }, base);
    expect(items[2]!.children?.map((child) => child.id)).toEqual([
      "rubato-folder:move:a",
      "rubato-folder:new",
    ]);
  });

  it("stays out of the menu while the thread's Mac has sent no settings", () => {
    const items = withRubatoFolderMenu(foldersOf([], {}), { environmentId: "unknown" as EnvironmentId, id: "t1" }, base);
    expect(items).toEqual(base);
  });

  it("tells its choices apart from the menu's own", () => {
    expect(isRubatoFolderMenuId("rubato-folder:move:a")).toBe(true);
    expect(isRubatoFolderMenuId("pin")).toBe(false);
  });
});
