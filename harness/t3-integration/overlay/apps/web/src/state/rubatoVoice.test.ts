import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { withVoiceFailure } from "../components/chat/useRubatoVoiceInput";
import { createRubatoLiveDictation, type RubatoVoiceFailure } from "./rubatoVoice";

vi.mock("./session", () => ({ readPreparedConnection: () => ({}) }));
vi.mock("./rubatoHttp", () => ({
  rubatoHttpAccess: async () => ({
    baseUrl: "http://mac.test",
    headers: { authorization: "Bearer desktop" },
    credentials: "omit",
  }),
}));

type Sent = { url: string; method: string; headers: Record<string, string> };
let sent: Sent[] = [];
let answer: (url: string) => Response;

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send() {}
  close() {}
}
class FakePeer {
  channel = new FakeChannel();
  addTrack() {}
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    queueMicrotask(() => {
      this.channel.readyState = "open";
      this.channel.onopen?.();
    });
  }
  async getStats() {
    return new Map();
  }
  close() {}
}

beforeEach(() => {
  sent = [];
  const track = { enabled: true, stop() {} };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) },
  });
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/realtime/calls") return new Response("answer", { status: 201 });
    sent.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])),
    });
    return answer(url);
  });
});
afterEach(() => vi.unstubAllGlobals());

const environmentId = EnvironmentId.make("env");
const signal = new AbortController().signal;

it("asks the Mac only with methods and headers T3's CORS allows, so the browser lets it through", async () => {
  // T3's own list, read at run time: the web project does not compile server files.
  const corsFile = new URL("../../../server/src/httpCors.ts", import.meta.url).pathname;
  const cors = (await import(/* @vite-ignore */ corsFile)) as {
    browserApiCorsAllowedMethods: readonly string[];
    browserApiCorsAllowedHeaders: readonly string[];
  };
  answer = () =>
    Response.json({ clientSecret: "ek_1", callsUrl: "https://api.openai.com/v1/realtime/calls" });

  const live = createRubatoLiveDictation(() => environmentId, () => {}, () => {});
  await live.transcriber.prepare({ signal });
  live.deleteRecording(live.recorder.uri!);

  expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
    "POST /rubato/voice/live",
  ]);
  for (const request of sent) {
    expect(cors.browserApiCorsAllowedMethods).toContain(request.method);
    for (const header of Object.keys(request.headers)) {
      expect(cors.browserApiCorsAllowedHeaders).toContain(header);
    }
  }
});

it("names the setting to fix when the Mac is not set up, in place of T3's generic line", async () => {
  answer = () => Response.json({ error: { code: "voice-not-configured" } }, { status: 503 });
  let failure: RubatoVoiceFailure | null = null;
  const live = createRubatoLiveDictation(
    () => environmentId,
    (reported: RubatoVoiceFailure) => {
      failure = reported;
    },
    () => {},
  );
  await expect(live.transcriber.prepare({ signal })).rejects.toThrow("Voice input is not set up yet.");
  expect(failure).toEqual({ message: "Voice input is not set up yet.", fixInSettings: true });

  const generic = { phase: "error", error: "Could not prepare voice transcription.", errorAction: "retry" } as const;
  expect(withVoiceFailure(generic, failure)).toEqual({
    phase: "error",
    error: "Voice input is not set up yet.",
    errorAction: "settings",
  });
  expect(withVoiceFailure({ phase: "idle", error: null, errorAction: null }, failure).error).toBeNull();
});
