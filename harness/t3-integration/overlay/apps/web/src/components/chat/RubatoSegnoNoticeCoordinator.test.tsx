// The app's thread notifications hand a completion in Segno's thread to Segno's messenger notice
// (RubatoSegnoNotice.tsx, wired by companion-edits.mjs) and leave every other thread's as it was.
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  completed: new Set<string>(),
  active: { environmentId: "env-1", threadId: "elsewhere" },
  focused: true,
  add: vi.fn((_toast: { title: string; description: string }) => "toast-1"),
  segno: vi.fn(async (_input: unknown) => undefined),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const NOW = DateTime.makeUnsafe("2026-10-20T09:00:00.000Z");
const shell = (id: string, title: string, runId: string) => ({
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
  status: state.completed.has(id) ? "completed" : "running",
  lastErrorClass: null,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  latestRunRequestedAt: NOW,
  latestRunStartedAt: NOW,
  latestRunCompletedAt: state.completed.has(id)
    ? DateTime.makeUnsafe("2026-10-20T09:05:00.000Z")
    : undefined,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: "live",
    snapshot: Option.some({
      threads: [
        shell("segno-thread", "세뇨", "rubato-said:item-1"),
        shell("lead-thread", "Fix the login form", "run-1"),
      ],
    }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => state.active,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: true }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../../state/environments", () => ({ useEnvironmentIds: () => ["env-1"] }));
vi.mock("../../state/shell", () => ({ environmentShell: { stateValueAtom: vi.fn() } }));
vi.mock("../../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../threadNotifications")>()),
  playNotificationSound: vi.fn(),
  setNotificationBadge: vi.fn(),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.add, close: vi.fn() } }));
vi.mock("../../state/rubatoCompanion", () => ({
  isCompanionThread: (threadId: string) => threadId === "segno-thread",
}));
vi.mock("./RubatoSegnoNotice", () => ({ notifySegnoCompletion: state.segno }));

import { ThreadNotificationCoordinator } from "../ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;
async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = "off";
  state.completed = new Set();
  state.active = { environmentId: "env-1", threadId: "elsewhere" };
  state.focused = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Segno's thread in the app's notifications", () => {
  it("hands a completion in Segno's thread to Segno's notice, with its run", async () => {
    await render();
    state.completed.add("segno-thread");
    await render();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.segno).toHaveBeenCalledTimes(1);
    expect(state.segno.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      threadId: "segno-thread",
      runId: "rubato-said:item-1",
      viewing: false,
    });
  });

  it("tells Segno's notice when the person is looking at Segno's thread", async () => {
    state.active = { environmentId: "env-1", threadId: "segno-thread" };
    await render();
    state.completed.add("segno-thread");
    await render();
    expect(state.segno.mock.calls[0]?.[0]).toMatchObject({ viewing: true });
  });

  it("leaves another thread's completion toast as it was", async () => {
    await render();
    state.completed.add("lead-thread");
    await render();
    expect(state.segno).not.toHaveBeenCalled();
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Thread completed", description: "Fix the login form" }),
    );
  });

  it("gives another thread's desktop notification its title in the interface language", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    state.completed.add("lead-thread");
    await render();
    // English interface in this test: uiText leaves the title as it is.
    expect(state.notification).toHaveBeenCalledWith(
      "Thread completed",
      expect.objectContaining({ body: "Fix the login form" }),
    );
  });
});
