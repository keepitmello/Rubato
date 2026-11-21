import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  createDictationEdits,
  createLiveDictation,
  LIVE_FINISH_TIMEOUT_MS,
  LIVE_HOLD_MS,
  LIVE_NO_SOUND,
  liveDictationPieces,
  liveDictationStore,
  liveDictationTint,
  createLiveResampler,
  pcmToBase64,
  type LiveAudioSink,
  type LiveDictationPlatform,
} from "./rubatoLiveDictation.ts";

class FakeSocket {
  readyState = 0;
  sent: Array<{ readonly type: string; readonly audio?: string }> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  event(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  /** The audio sent so far, decoded back to samples. */
  audio(): number[] {
    return this.sent
      .filter((event) => event.type === "input_audio_buffer.append")
      .flatMap((event) => [...new Int16Array(Uint8Array.from(Buffer.from(event.audio!, "base64")).buffer)]);
  }
}

function harness(options: { readonly mintFails?: boolean; readonly opensBy?: "test" } = {}) {
  let clock = 1_000;
  const socket = new FakeSocket();
  const microphone = { open: false, stopped: false, sink: null as LiveAudioSink | null };
  const secrets: string[] = [];
  let mints = 0;
  const platform: LiveDictationPlatform = {
    mint: async () => {
      mints += 1;
      if (options.mintFails) throw new Error("Add an OpenAI API key for voice input.");
      return { clientSecret: "ek_1" };
    },
    openMicrophone: async (sink) => {
      microphone.open = true;
      microphone.sink = sink;
      return {
        stop() {
          microphone.stopped = true;
        },
      };
    },
    openSocket: (clientSecret) => {
      secrets.push(clientSecret);
      if (options.opensBy !== "test") queueMicrotask(() => socket.open());
      return socket;
    },
    connectionFailed: (message) => new Error(message),
    now: () => clock,
  };
  const statuses: unknown[] = [];
  const live = createLiveDictation(platform, (status) => statuses.push(status));
  return {
    live, socket, microphone, secrets, statuses,
    mints: () => mints,
    /** The microphone hears `samples` at 24 kHz. */
    hear(samples: number[], sampleRate = 24_000) {
      microphone.sink?.(samples, sampleRate);
    },
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
    expect(h.secrets).toEqual(["ek_1"]);
  });

  it("what is said while connecting goes up first, before what is said after", async () => {
    const h = harness({ opensBy: "test" });
    const prepared = h.live.transcriber.prepare({ signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.microphone.open).toBe(true);
    // The first words, said while the key is minted and the socket opens.
    h.hear(Array.from({ length: 3_000 }, (_, index) => index));
    expect(h.socket.sent).toEqual([]);
    h.socket.open();
    await prepared;
    expect(h.socket.sent).toHaveLength(1);
    h.hear(Array.from({ length: 1_200 }, () => -7));
    expect(h.socket.audio()).toEqual([
      ...Array.from({ length: 3_000 }, (_, index) => index),
      ...Array.from({ length: 1_200 }, () => -7),
    ]);
  });

  it("audio goes up in pieces of 50 ms, and the rest before the commit", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    for (let piece = 0; piece < 4; piece += 1) h.hear(Array.from({ length: 480 }, () => 100), 48_000);
    expect(h.socket.sent).toEqual([]);
    h.hear(Array.from({ length: 480 }, () => 100), 48_000);
    expect(h.socket.audio()).toHaveLength(1_200);
    h.hear(Array.from({ length: 480 }, () => 100), 48_000);
    await h.live.recorder.stop();
    h.hear(Array.from({ length: 480 }, () => 100), 48_000);
    void prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.audio()).toHaveLength(1_440);
    expect(h.socket.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
  });

  it("keeps each word with when it arrived, and an item's final text once it comes", async () => {
    const h = harness();
    await startRecording(h);
    h.socket.event(delta("a", " 아,"));
    h.advance(400);
    h.socket.event(delta("a", " 음성"));
    expect(h.pieces()).toEqual([{ text: " 아,", at: 1_000 }, { text: " 음성", at: 1_400 }]);
    h.socket.event(completed("a", "아, 음성."));
    h.socket.event(delta("b", " 전사"));
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
    h.socket.event(delta("a", " 로바토"));
    await h.live.recorder.stop();
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.microphone.stopped).toBe(true);
    expect(h.socket.sent).toEqual([{ type: "input_audio_buffer.commit" }]);
    h.socket.event(completed("a", "루바토 입력창 고칠게"));
    await expect(text).resolves.toBe("루바토 입력창 고칠게");
    expect(prepared.locale).toBe("ko");
    h.live.deleteRecording(h.live.recorder.uri!);
    expect(h.socket.readyState).toBe(3);
    expect(liveDictationStore.snapshot().items).toEqual([]);
  });

  it("keeps the words already shown when the final text does not come in time", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    h.socket.event(delta("a", " hello"));
    h.socket.event(delta("a", " world"));
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    h.advance(LIVE_FINISH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(LIVE_FINISH_TIMEOUT_MS);
    await expect(text).resolves.toBe("hello world");
    expect(prepared.locale).toBe("en");
  });

  it("an empty buffer ends the wait at once and says the microphone gave no sound", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    h.socket.event({
      type: "error",
      error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" },
    });
    await expect(text).rejects.toThrow(LIVE_NO_SOUND);
  });

  it("an error after sound was heard shows OpenAI's own reason", async () => {
    const h = harness();
    const prepared = await startRecording(h);
    h.hear(Array.from({ length: 2_400 }, () => 100));
    const text = prepared.transcribe(h.live.recorder.uri!, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    const rejected = expect(text).rejects.toThrow("OpenAI stopped the dictation: overloaded");
    h.socket.event({ type: "error", error: { code: "server_error", message: "overloaded" } });
    h.advance(LIVE_FINISH_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(LIVE_FINISH_TIMEOUT_MS);
    await rejected;
  });

  it("a key the Mac cannot mint fails the preparation with its reason and frees the microphone", async () => {
    const h = harness({ mintFails: true });
    await expect(h.live.transcriber.prepare({ signal: new AbortController().signal })).rejects.toThrow(
      "Add an OpenAI API key for voice input.",
    );
    expect(liveDictationStore.snapshot().items).toEqual([]);
    expect(liveDictationStore.snapshot().active).toBe(false);
    expect(h.microphone.stopped).toBe(true);
  });

  it("words from a dictation already closed never reach the next one", async () => {
    const first = harness();
    await startRecording(first);
    first.live.deleteRecording(first.live.recorder.uri!);
    const second = harness();
    await startRecording(second);
    first.socket.event(delta("old", " 지난 말"));
    second.socket.event(delta("new", " 새 말"));
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
    h.hear([0, 16_384, -8_000]);
    expect(h.live.recorder.level()).toBeCloseTo(0.5, 3);
    expect(h.live.recorder.getStatus().metering).toBeCloseTo(-6.02, 1);
  });
});

describe("live audio", () => {
  it("brings 48 kHz to 24 kHz by averaging, across pieces", () => {
    const resample = createLiveResampler();
    expect([...resample([10, 20, 30], 48_000)]).toEqual([15]);
    expect([...resample([40, 50, 60], 48_000)]).toEqual([35, 55]);
  });

  it("brings 16 kHz up to 24 kHz, three samples for every two", () => {
    const resample = createLiveResampler();
    expect(resample(new Array(1_600).fill(1_000), 16_000)).toHaveLength(2_400);
  });

  it("keeps 24 kHz as it is, rounded and clipped to 16 bits", () => {
    const resample = createLiveResampler();
    expect([...resample([1.4, 40_000, -40_000], 24_000)]).toEqual([1, 32_767, -32_768]);
  });

  it("encodes little-endian 16-bit PCM as base64", () => {
    for (const samples of [[1, -2, 300], [32_767, -32_768], [5]]) {
      const pcm = Int16Array.from(samples);
      expect(pcmToBase64(pcm)).toBe(Buffer.from(pcm.buffer).toString("base64"));
    }
  });
});

describe("dictation edits", () => {
  it("reports a dictated text the person changed, once the draft goes out", () => {
    const edits = createDictationEdits();
    edits.dictated("출근 한도 올려 줘");
    expect(edits.draft("출근 한도 올려 줘")).toBeNull();
    expect(edits.draft("출금 한도 올려 줘")).toBeNull();
    expect(edits.draft("")).toEqual({ heard: ["출근 한도 올려 줘"], sent: "출금 한도 올려 줘" });
    expect(edits.draft("")).toBeNull();
  });

  it("stays quiet when nothing dictated was changed, or nothing was dictated", () => {
    const edits = createDictationEdits();
    edits.dictated("그대로 보낼 말");
    edits.draft("앞에 더 쓴 말 그대로 보낼 말");
    expect(edits.draft("")).toBeNull();
    edits.draft("손으로만 쓴 말");
    expect(edits.draft("")).toBeNull();
  });
});
