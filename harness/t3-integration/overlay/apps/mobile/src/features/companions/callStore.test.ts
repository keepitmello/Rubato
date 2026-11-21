import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The call store with LiveKit, CallKit and the Mac faked: what it does to the app around a call.
const native = vi.hoisted(() => ({
  calls: [] as { uuid: string; state: string }[],
  endCall: vi.fn(),
  requestEnd: vi.fn(),
  refuseCallKit: true,
}));

vi.mock("@livekit/react-native", () => ({ registerGlobals: () => {} }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Settings: { get: () => undefined } }));
vi.mock("livekit-client", () => {
  class Room {
    localParticipant = { identity: "me", setMicrophoneEnabled: async () => {} };
    remoteParticipants = new Map();
    on() { return this; }
    registerTextStreamHandler() {}
    async connect() {}
    async disconnect() {}
  }
  return { Room, RoomEvent: { ParticipantAttributesChanged: "a", ParticipantConnected: "c", Disconnected: "d" } };
});
vi.mock("../../../modules/rubato-call", () => ({
  RubatoCall: {
    activeCalls: () => native.calls,
    addListener: () => ({ remove() {} }),
    endCall: native.endCall,
    requestEnd: native.requestEnd,
    reportConnected: () => {},
    startOutgoingCall: async () => { if (native.refuseCallKit) throw new Error("another call is on"); },
    reportIncomingCall: async () => true,
  },
}));
vi.mock("./rubatoHttp", () => ({
  pairedEnvironmentIds: () => ["mac"],
  isRubatoRequestError: () => false,
  postRubato: async (_env: string, _route: string, action: string) =>
    action === "dial" ? { call: { id: "c1", uuid: "u1", companion: "roo", status: "active" }, url: "wss://mac", token: "t" } : {},
}));

async function store() {
  vi.resetModules();
  const handoff = await import("../../lib/foreground-handoff");
  const calls = await import("./callStore");
  return { ...calls, handoff };
}

beforeEach(() => {
  native.calls = [];
  native.endCall.mockClear();
  native.requestEnd.mockClear();
});

describe("a call on the phone", () => {
  it("holds off the app-update restart while it is on, which would drop its audio", async () => {
    const { callActions, readCallView, handoff } = await store();
    expect(handoff.isForegroundHandoffActive()).toBe(false);
    await callActions.dial("mac" as never, "roo", "Roo");
    expect(readCallView().current?.connectedAt).not.toBeNull();
    expect(handoff.isForegroundHandoffActive()).toBe(true);
    callActions.hangUp();
    await vi.waitFor(() => expect(readCallView().current).toBeNull());
    expect(handoff.isForegroundHandoffActive()).toBe(false);
  });

  it("puts its screen away and brings it back while the call goes on", async () => {
    const { callActions, readCallView } = await store();
    callActions.minimize();
    expect(readCallView().minimized).toBe(false);
    await callActions.dial("mac" as never, "roo", "Roo");
    callActions.minimize();
    expect(readCallView()).toMatchObject({ minimized: true, current: { call: { id: "c1" } } });
    callActions.restore();
    expect(readCallView().minimized).toBe(false);
    callActions.minimize();
    callActions.hangUp();
    await vi.waitFor(() => expect(readCallView().current).toBeNull());
    expect(readCallView().minimized).toBe(false);
  });

  it("ends a call the system still shows when the app's JavaScript starts under it", async () => {
    native.calls = [{ uuid: "left", state: "active" }, { uuid: "dialing", state: "connecting" }, { uuid: "ring", state: "ringing" }];
    const { startCallBridge } = await store();
    startCallBridge();
    expect(native.endCall.mock.calls).toEqual([["left", "failed"], ["dialing", "failed"]]);
  });
});
