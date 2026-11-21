// The desktop shows a thread's right-click menu natively, where the page translation
// (rubatoI18n.ts) cannot reach, so Rubato's own labels must already be Korean when the menu
// is built. Here uiText reads the real dictionary, as it does while the interface is Korean.
import korean from "@t3tools/shared/rubatoI18n.ko.json";
import type { ContextMenuItem, EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../rubatoI18n", async (original) => {
  const actual = await original<typeof import("../../rubatoI18n")>();
  const translator = actual.createUiTranslator(korean as unknown as import("../../rubatoI18n").UiDictionary);
  return {
    ...actual,
    uiText: (value: string) => translator.lookup(actual.normalizeUiText(value)) ?? value,
  };
});

const { withRubatoFolderMenu } = await import("./rubatoThreadFolders");
const { buildThreadActionMenuItems } = await import("../threadActionMenu.logic");

const mac = "env-mac" as EnvironmentId;

describe("Rubato's labels in a thread's right-click menu, Korean interface", () => {
  it("names the folder actions in Korean and keeps folder names as written", () => {
    const research = { id: "a", name: "Research", createdAt: "2026-11-14T00:00:00.000Z", threadCount: 0, environmentId: mac };
    const items = withRubatoFolderMenu(
      {
        folders: [research],
        byId: new Map([["a", research]]),
        loaded: true,
        folderOf: () => research,
        foldersOn: () => [research],
        settingsOf: () => ({}) as ServerSettings,
      },
      { environmentId: mac, id: "t1" },
      [{ id: "pin", label: "스레드 고정" }] as ContextMenuItem<"pin">[],
    );
    const menu = items.find((item) => item.id === "rubato-folder:menu");
    expect(menu?.label).toBe("폴더로 옮기기");
    expect(menu?.children?.map((child) => child.label)).toEqual(["Research", "새 폴더…", "Research에서 빼기"]);
  });

  it("names Fork thread in Korean", () => {
    const items = buildThreadActionMenuItems({
      canOperate: true,
      branch: null,
      projectFilter: null,
      isPinned: false,
      isSettled: false,
      autoSettleEnabled: true,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: { settlement: true, autoSettleOptOut: true, snooze: true, pinning: true, titleRegeneration: true, fork: true },
      snoozePresets: [],
    });
    expect(items.find((item) => item.id === "fork")?.label).toBe("스레드 fork");
  });
});
