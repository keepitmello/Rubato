import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  createLiveDictation,
  LIVE_FINISH_TIMEOUT_MS,
  LIVE_HOLD_MS,
  liveDictationPieces,
  liveDictationStore,
  liveDictationTint,
  type LiveDictationPlatform,
} from "./rubatoLiveDictation.ts";

class FakeChannel {
  readyState = "connecting";
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.onopen?.({});
  }
  event(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function harness(options: { readonly mintFails?: boolean } = {}) {
  let clock = 1_000;
  const channel = new FakeChannel();
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const peer = {
    closed: false,
    remote: null as unknown,
    addTrack: () => undefined,
    createDataChannel: () => channel,
    createOffer: async () => ({ sdp: "offer-sdp", type: "offer" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async (description: unknown) => {
      peer.remote = description;
      queueMicrotask(() => channel.open());
    },
    getStats: async () => new Map([["m", { type: "media-source", kind: "audio", audioLevel: 0.5 }]]),
    close() {
      peer.closed = true;
    },
  };
  const posted: Array<{ url: string; init: RequestInit }> = [];
  let mints = 0;
  const platform: LiveDictationPlatform = {
    mint: async () => {
      mints += 1;
      if (options.mintFails) throw new Error("Add an OpenAI API key for voice input.");
      return { clientSecret: "ek_1", callsUrl: "https://api.openai.com/v1/realtime/calls" };
    },
    openMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
    createPeer: () => peer as never,
    fetch: async (url, init) => {
      posted.push({ url, init });
      return new Response("answer-sdp", { status: 201 });
    },
    connectionFailed: (message) => new Error(message),
    now: () => clock,
  };
  const statuses: unknown[] = [];
  const live = createLiveDictation(platform, (status) => statuses.push(status));
  return {
    live, channel, track, peer, posted, statuses,
    mints: () => mints,
    advance(ms: number) {
      clock += ms;
    },
    pieces: () => liveDictationPieces(liveDictationStore.snapshot()),
  };
}

const delta = (item: string, text: string) => ({
  type: "conversation.item.input_audio_transcription.delta", item_id: item, delta: text,
});
const completed = (item: string, transcript: string) => ({
  type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript,
});

async function startRecording(h: ReturnType<typeof harness>) {
  const prepared = await h.live.transcriber.prepare({ signal: new AbortController().signal });
  await h.live.recorder.prepareToRecordAsync();
  h.live.recorder.record({ forDuration: 300 });
  return prepared;
}

describe("live dictation", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("connects with the Mac's one-time key, never another credential", async () => {
    const h = harness();
    await startRecording(h);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(h.posted[0]!.init.headers).toEqual({ authorization: "Bearer ek_1", "content-type": "application/sdp" });
    expect(h.posted[0]!.init.body).toBe("offer-sdp");
    expect(h.peer.remote).toEqual({ type: "answer", sdp: "answer-sdp" });
  });

  it("keeps each word with when it arrived, and an item's final text once it comes", async () => {
    const h = harness();
    await startRecording(h);
    h.channel.event(delta("a", " 아,"));
    h.advance(400);
    h.channel.event(delta("a", " 음성"));
    expect(h.pieces()).toEqual([{ text: " 아,", at: 1_000 }, { text: " 음성", at: 1_400 }]);
    h.channel.event(completed("a", "아, 음성."));
    h.channel.event(delta("b", " 전사"));
    expect(h.pieces()).toEqual([{ text: "아, 음성.", at: null }, { text: " 전사", at: 1_400 }]);
  });

  it("a word fades in, stays blue, then fades to grey on its own clock", () => {
    expect(liveDictationTint(0)).toEqual({ visible: 0.25, blue: 1 });
    expect(liveDictationTint(LIVE_HOLD_MS)).toEqual({ visible: 1, blue: 1 });
    expect(liveDictationTint(LIVE_HOLD_MS + 200).blue).toBeCloseTo(0.5);
    expect(liveDictationTint(5_000)).toEqual({ visible: 1, blue: 0 });
  });

  it("stop asks for the final text and commits it, then lets the microphone go", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    h.channel.event(delta("a", " 로바토"));
    await h.live.recorder.stop();
    expect(h.track.enabled).toBe(false);
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channel.sent).toEqual([{ type: "input_audio_buffer.commit" }]);
    h.channel.event(completed("a", "루바토 입력창 고칠게"));
    await expect(text).resolves.toBe("루바토 입력창 고칠게");
    expect(prepared.locale).toBe("ko");
    h.live.deleteRecording(h.live.recorder.uri!);
    expect(h.track.stopped).toBe(true);
    expect(h.peer.closed).toBe(true);
    expect(liveDictationStore.snapshot().items).toEqual([]);
  });

  it("keeps the words already shown when the final text does not come in time", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    h.channel.event(delta("a", " hello"));
    h.channel.event(delta("a", " world"));
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    h.advance(LIVE_FINISH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(LIVE_FINISH_TIMEOUT_MS);
    await expect(text).resolves.toBe("hello world");
    expect(prepared.locale).toBe("en");
  });

  it("an empty buffer ends the wait at once instead of after the timeout", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    h.channel.event({ type: "error", error: { message: "buffer too small" } });
    await expect(text).rejects.toThrow("OpenAI stopped the dictation.");
  });

  it("a key the Mac cannot mint fails the preparation with its reason and frees the microphone", async () => {
    const h = harness({ mintFails: true });
    await expect(h.live.transcriber.prepare({ signal: new AbortController().signal })).rejects.toThrow(
      "Add an OpenAI API key for voice input.",
    );
    expect(liveDictationStore.snapshot().items).toEqual([]);
    expect(liveDictationStore.snapshot().active).toBe(false);
  });

  it("words from a dictation already closed never reach the next one", async () => {
    const first = harness();
    await startRecording(first);
    first.live.deleteRecording(first.live.recorder.uri!);
    const second = harness();
    await startRecording(second);
    first.channel.event(delta("old", " 지난 말"));
    second.channel.event(delta("new", " 새 말"));
    expect(liveDictationStore.snapshot().items.map((item) => item.pieces.map((p) => p.text).join(""))).toEqual([" 새 말"]);
  });

  it("a key minted ahead is the one the dictation uses, and only once", async () => {
    const h = harness();
    h.live.warm();
    h.live.warm();
    expect(h.mints()).toBe(1);
    await startRecording(h);
    expect(h.mints()).toBe(1);
    h.live.deleteRecording(h.live.recorder.uri!);
    await startRecording(h);
    expect(h.mints()).toBe(2);
  });

  it("an old key minted ahead is left for a new one", async () => {
    const h = harness();
    h.live.warm();
    h.advance(41_000);
    await startRecording(h);
    expect(h.mints()).toBe(2);
  });

  it("reports the microphone level in decibels for the phone's waveform", async () => {
    const h = harness();
    await startRecording(h);
    await vi.advanceTimersByTimeAsync(80);
    expect(h.live.recorder.level()).toBe(0.5);
    expect(h.live.recorder.getStatus().metering).toBeCloseTo(-6.02, 1);
  });
});
