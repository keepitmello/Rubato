import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "../threadActionMenu.logic";
import { forkMenuItems, threadRunsOnRubato } from "./rubatoThreadFork";

const env = "env-1" as EnvironmentId;
const thread = (instanceId: string) => ({
  environmentId: env,
  modelSelection: { instanceId, model: "anthropic/claude-opus-5-5" } as ModelSelection,
});
const rubatoOnly = (_: EnvironmentId, instanceId: string) => instanceId === "rubato";

describe("Fork thread", () => {
  it("is offered for a thread that runs on Rubato", () => {
    expect(threadRunsOnRubato(thread("rubato"), rubatoOnly)).toBe(true);
    expect(forkMenuItems(thread("rubato"), rubatoOnly)).toEqual([{ id: "fork", label: "Fork thread" }]);
  });

  it("is not offered for another provider's thread", () => {
    expect(threadRunsOnRubato(thread("codex"), rubatoOnly)).toBe(false);
    expect(forkMenuItems(thread("codex"), rubatoOnly)).toEqual([]);
  });

  it("sits in the thread action menu after the title items when the thread can fork", () => {
    const state = (fork: boolean): ThreadActionMenuState => ({
      branch: null,
      projectFilter: null,
      isPinned: false,
      isSettled: false,
      autoSettleEnabled: true,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: { settlement: false, autoSettleOptOut: false, snooze: false, pinning: false, titleRegeneration: true, fork },
      snoozePresets: [],
    });
    const ids = (fork: boolean) => buildThreadActionMenuItems(state(fork)).map((item) => item.id);
    expect(ids(true).slice(0, 4)).toEqual(["rename", "regenerate-title", "fork", "mark-unread"]);
    expect(ids(false)).not.toContain("fork");
  });
});
