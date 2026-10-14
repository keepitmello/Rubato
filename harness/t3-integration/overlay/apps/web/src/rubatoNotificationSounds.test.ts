import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Which sound a thread notification plays (sound-edits.mjs): the one chosen in
// Settings for that kind, and T3's own for the kind when the chosen one does not load.

const settings = vi.hoisted(() => ({
  notificationCompletionSound: "builtin:completion",
  notificationInputSound: "builtin:input",
}));
vi.mock("./hooks/useSettings", () => ({ getClientSettings: () => settings }));

const { BUILT_IN_NOTIFICATION_SOUNDS, notificationSoundLabel } = await import("./rubatoNotificationSounds");
const { playNotificationSound, previewNotificationSound } = await import("./threadNotifications");
const completionUrl = (await import("./assets/notification-completion.mp3")).default;
const inputUrl = (await import("./assets/notification-input.mp3")).default;

const decoded: string[] = [];
const started: string[] = [];

class FakeAudioContext {
  state = "running";
  destination = {};
  async resume() {}
  async decodeAudioData(data: ArrayBuffer) {
    const name = new TextDecoder().decode(data);
    decoded.push(name);
    return { name };
  }
  createBufferSource() {
    const source = {
      buffer: null as { name: string } | null,
      connect() {},
      start() {
        started.push(source.buffer!.name);
      },
    };
    return source;
  }
}

describe("notification sounds", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const name = url === completionUrl ? "completion" : url === inputUrl ? "input" : null;
        return name ? new Response(name) : new Response("missing", { status: 404 });
      }),
    );
    started.length = 0;
    decoded.length = 0;
    settings.notificationCompletionSound = "builtin:completion";
    settings.notificationInputSound = "builtin:input";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plays the sound chosen for each kind", async () => {
    await previewNotificationSound("input", "builtin:input");
    started.length = 0;
    settings.notificationInputSound = "builtin:completion";
    await playNotificationSound("input", () => true);
    expect(started).toEqual(["completion"]);
    settings.notificationCompletionSound = "builtin:input";
    await playNotificationSound("completion", () => true);
    expect(started).toEqual(["completion", "input"]);
  });

  it("falls back to the kind's own sound when the chosen one does not load", async () => {
    // No Mac is connected in a unit test, so a Mac sound cannot load.
    await previewNotificationSound("completion", "mac:system/Glass.aiff");
    expect(started).toEqual(["completion"]);
    settings.notificationInputSound = "mac:user/Gone.wav";
    await playNotificationSound("input", () => true);
    expect(started).toEqual(["completion", "input"]);
  });

  it("stays quiet when notifications stop including sound before it loads", async () => {
    await previewNotificationSound("completion", "builtin:completion");
    started.length = 0;
    await playNotificationSound("completion", () => false);
    expect(started).toEqual([]);
  });

  it("names built-in and Mac sounds in the picker", () => {
    const mac = [{ id: "mac:system/Glass.aiff", name: "Glass", folder: "system" as const }];
    expect(notificationSoundLabel(BUILT_IN_NOTIFICATION_SOUNDS[0].id, mac)).toBe("Completion chime");
    expect(notificationSoundLabel("mac:system/Glass.aiff", mac)).toBe("Glass");
    expect(notificationSoundLabel("mac:user/Not Listed Yet.wav", mac)).toBe("Not Listed Yet");
  });
});
