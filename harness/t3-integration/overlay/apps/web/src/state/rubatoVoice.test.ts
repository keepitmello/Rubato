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

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Array<{ type: string; audio?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}
class FakeNode {
  connect() {}
  disconnect() {}
}
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  sampleRate = 48_000;
  destination = new FakeNode();
  processor = Object.assign(new FakeNode(), {
    onaudioprocess: null as ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null,
  });
  closed = false;
  constructor() {
    FakeAudioContext.last = this;
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  createScriptProcessor() {
    return this.processor;
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
  /** The microphone hears `samples` (−1…1). */
  hear(samples: number[]) {
    this.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from(samples) } });
  }
}

let microphoneStopped = false;
beforeEach(() => {
  sent = [];
  microphoneStopped = false;
  const track = {
    stop() {
      microphoneStopped = true;
    },
  };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) },
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
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
  answer = () => Response.json({ clientSecret: "ek_1" });

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

it("hears the microphone from the moment it opens and sends that first, with the Mac's key", async () => {
  let release: (response: Response) => void = () => {};
  answer = () => new Promise<Response>((resolve) => (release = resolve)) as never;
  const live = createRubatoLiveDictation(() => environmentId, () => {}, () => {});
  const prepared = live.transcriber.prepare({ signal });
  await vi.waitFor(() => expect(FakeAudioContext.last?.processor.onaudioprocess).toBeTypeOf("function"));
  // Said while the Mac mints the key: 48 kHz, half scale.
  FakeAudioContext.last!.hear(new Array(4_800).fill(0.5));
  release(Response.json({ clientSecret: "ek_1" }));
  await prepared;

  const socket = FakeSocket.last!;
  expect(socket.url).toBe("wss://api.openai.com/v1/realtime");
  expect(socket.protocols).toEqual(["realtime", "openai-insecure-api-key.ek_1"]);
  expect(socket.sent).toHaveLength(1);
  const samples = new Int16Array(Uint8Array.from(Buffer.from(socket.sent[0]!.audio!, "base64")).buffer);
  expect(samples).toHaveLength(2_400);
  expect(samples.every((sample) => sample === 16_384)).toBe(true);

  live.deleteRecording(live.recorder.uri!);
  expect(microphoneStopped).toBe(true);
  expect(FakeAudioContext.last!.closed).toBe(true);
  expect(socket.readyState).toBe(3);
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
