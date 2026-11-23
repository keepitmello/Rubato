// The app's thread notifications hand a completion in Segno's thread to Segno's messenger notice
// (RubatoSegnoNotice.tsx, wired by companion-edits.mjs) and leave every other thread's as it was.
import type { AnyRouter } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  active: { environmentId: "env-1", threadId: "elsewhere" } as Record<string, string>,
  focused: true,
  add: vi.fn((_toast: { title: string; description: string }) => "toast-1"),
  segno: vi.fn(async (_input: unknown) => undefined),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentShell: { stateValueAtom: Atom.family((_id: string) => Atom.make<unknown>(null)) } };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const noRequests = Atom.make(new Map());
  return {
    environmentThreadShells: {
      hiddenThreadKeysAtom: Atom.make<ReadonlySet<string>>(new Set<string>()),
      anyEnvironmentHidingAtom: Atom.make(false),
      threadRefsAtom: Atom.make([]),
      pendingSubagentRequestsAtom: () => noRequests,
      delegatedUnderParentAtom: Atom.make<ReadonlySet<string>>(new Set<string>()),
    },
  };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentSummaries: { environmentIdsAtom: Atom.make<ReadonlyArray<string>>(["env-1"]) } };
});
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ notificationMode: state.mode, inAppNotificationsEnabled: true }),
  subscribeClientSettings: () => () => undefined,
}));
vi.mock("../../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../threadNotifications")>()),
  playNotificationSound: vi.fn(),
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: vi.fn(),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.add, close: vi.fn() } }));
vi.mock("../../state/rubatoCompanion", () => ({
  isCompanionThread: (threadId: string) => threadId === "segno-thread",
}));
vi.mock("./RubatoSegnoNotice", () => ({ notifySegnoCompletion: state.segno }));
vi.mock("../../state/rubatoPush", () => ({ rubatoPush: { desktopThreadMuted: async () => false } }));

import { environmentShell } from "../../state/shell";
import { startThreadNotifications } from "../ThreadNotificationCoordinator";

const NOW = DateTime.makeUnsafe("2026-10-20T09:00:00.000Z");
const shell = (id: string, title: string, runId: string, completed: boolean) => ({
  id,
  projectId: "project-1",
  title,
  providerInstanceId: "rubato-pi",
  modelSelection: { instanceId: "rubato-pi", model: "claude" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: runId,
  activeRunId: null,
  status: completed ? "completed" : "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  latestRunRequestedAt: NOW,
  latestRunStartedAt: NOW,
  latestRunCompletedAt: completed ? DateTime.makeUnsafe("2026-10-20T09:05:00.000Z") : undefined,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

let registry: AtomRegistry.AtomRegistry;
let stop: (() => void) | undefined;
/** Shows both threads, with the named ones completed. */
function publish(...completed: string[]) {
  registry.set(environmentShell.stateValueAtom("env-1" as never) as never, {
    status: "live",
    snapshot: Option.some({
      threads: [
        shell("segno-thread", "세뇨", "rubato-said:item-1", completed.includes("segno-thread")),
        shell("lead-thread", "Fix the login form", "run-1", completed.includes("lead-thread")),
      ],
    }),
  });
}
function start() {
  const router = {
    state: { matches: [{ params: state.active }] },
    navigate: vi.fn(),
    subscribe: () => () => undefined,
  } as unknown as AnyRouter;
  publish();
  stop = startThreadNotifications(registry, router);
}

beforeEach(() => {
  vi.clearAllMocks();
  registry = AtomRegistry.make();
  state.mode = "off";
  state.active = { environmentId: "env-1", threadId: "elsewhere" };
  state.focused = true;
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});
afterEach(() => {
  stop?.();
  stop = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("Segno's thread in the app's notifications", () => {
  it("hands a completion in Segno's thread to Segno's notice, with its run", () => {
    start();
    publish("segno-thread");
    expect(state.add).not.toHaveBeenCalled();
    expect(state.segno).toHaveBeenCalledTimes(1);
    expect(state.segno.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      threadId: "segno-thread",
      runId: "rubato-said:item-1",
      viewing: false,
    });
  });

  it("tells Segno's notice when the person is looking at Segno's thread", () => {
    state.active = { environmentId: "env-1", threadId: "segno-thread" };
    start();
    publish("segno-thread");
    expect(state.segno.mock.calls[0]?.[0]).toMatchObject({ viewing: true });
  });

  it("leaves another thread's completion toast as it was", async () => {
    start();
    publish("lead-thread");
    expect(state.segno).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Thread completed", description: "Fix the login form" }),
    ));
  });

  it("leaves another thread's desktop notification as it was", async () => {
    state.mode = "notifications";
    state.focused = false;
    start();
    publish("lead-thread");
    await vi.waitFor(() => expect(state.notification).toHaveBeenCalledWith(
      "Thread completed",
      expect.objectContaining({ body: "Fix the login form" }),
    ));
  });
});
