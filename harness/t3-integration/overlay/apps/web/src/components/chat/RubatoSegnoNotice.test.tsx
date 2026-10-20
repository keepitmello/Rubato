import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  said: "**안녕!** 오늘 아침 일정은 `10:00` 회의 하나야.\n\n- 우산 챙겨" as string | null,
  saidFails: false,
  focused: true,
  visible: "visible",
  add: vi.fn(
    (_toast: {
      type: string;
      title: string;
      description: string;
      actionProps: { children: string; onClick: () => void };
    }) => "toast-1",
  ),
  close: vi.fn(),
  sound: vi.fn(),
  saidCall: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock("../../state/rubatoCompanion", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/rubatoCompanion")>();
  return {
    ...original,
    rubatoCompanion: {
      ...original.rubatoCompanion,
      said: (...args: unknown[]) => {
        state.saidCall(...args);
        return state.saidFails
          ? Promise.reject(new Error("offline"))
          : Promise.resolve({ text: state.said });
      },
    },
  };
});
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ notificationMode: "notifications-and-sound" }),
}));
vi.mock("../../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../threadNotifications")>()),
  playNotificationSound: state.sound,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.add, close: state.close } }));

import { SEGNO_NOTICE_CHARS, segnoNotice } from "../../state/rubatoCompanion";
import { notifySegnoCompletion, type SegnoCompletion } from "./RubatoSegnoNotice";

const open = vi.fn();
const onNotification = vi.fn();
const completion = (patch: Partial<SegnoCompletion> = {}): SegnoCompletion => ({
  environmentId: "env-1" as SegnoCompletion["environmentId"],
  threadId: "segno-thread",
  runId: "rubato-said:item-1",
  mode: "off",
  inAppNotificationsEnabled: true,
  viewing: false,
  open,
  onNotification,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    said: "**안녕!** 오늘 아침 일정은 `10:00` 회의 하나야.\n\n- 우산 챙겨",
    saidFails: false,
    focused: true,
    visible: "visible",
  });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});
afterEach(() => vi.unstubAllGlobals());

describe("segnoNotice", () => {
  it("shows the start of what Segno said as plain text under its name", () => {
    expect(segnoNotice("**안녕!** 오늘 [일정](https://x)은 `10:00`.\n\n- 우산")).toEqual({
      title: "Segno",
      body: "안녕! 오늘 일정은 10:00. 우산",
    });
  });
  it("cuts a long message to the notification's length", () => {
    const body = segnoNotice("가".repeat(SEGNO_NOTICE_CHARS * 2))?.body ?? "";
    expect([...body]).toHaveLength(SEGNO_NOTICE_CHARS);
    expect(body.endsWith("…")).toBe(true);
  });
  it.each([null, undefined, "", "  \n ", "```\ncode only\n```"])("is nothing for %j", (said) => {
    expect(segnoNotice(said)).toBeNull();
  });
});

describe("a run that ends in Segno's thread", () => {
  it("raises a messenger toast in the app: Segno, what it said, Open", async () => {
    await notifySegnoCompletion(completion());
    expect(state.saidCall).toHaveBeenCalledWith("env-1", "segno-thread", "rubato-said:item-1");
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Segno");
    expect(toast?.description).toBe("안녕! 오늘 아침 일정은 10:00 회의 하나야. 우산 챙겨");
    expect(toast?.actionProps.children).toBe("Open");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(open).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["said nothing", "lookup failed", "no run"])("raises nothing when it %s", async (why) => {
    if (why === "said nothing") state.said = null;
    if (why === "lookup failed") state.saidFails = true;
    await notifySegnoCompletion(
      completion({ mode: "notifications-and-sound", ...(why === "no run" ? { runId: null } : {}) }),
    );
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
  });

  it("raises no toast while the person has Segno's thread open, as for any thread", async () => {
    await notifySegnoCompletion(completion({ viewing: true }));
    expect(state.add).not.toHaveBeenCalled();
  });

  it("raises a desktop notification with Segno's words when the app is in the background", async () => {
    state.focused = false;
    await notifySegnoCompletion(completion({ mode: "notifications-and-sound" }));
    expect(state.add).not.toHaveBeenCalled();
    expect(state.sound).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith("Segno", {
      body: "안녕! 오늘 아침 일정은 10:00 회의 하나야. 우산 챙겨",
      tag: "env-1:segno-thread",
      silent: true,
    });
    const shown = state.notification.mock.results[0]?.value as EventTarget;
    expect(onNotification).toHaveBeenCalledWith("env-1", shown);
    shown.dispatchEvent(new Event("click"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps the desktop quiet when notifications are off", async () => {
    state.focused = false;
    await notifySegnoCompletion(completion({ mode: "off" }));
    expect(state.notification).not.toHaveBeenCalled();
  });
});
