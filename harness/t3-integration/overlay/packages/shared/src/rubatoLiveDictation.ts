// @effect-diagnostics globalTimers:off globalDate:off - Dictation runs in the web and phone voice controllers, outside an Effect runtime.
// Live dictation: words appear in the composer while the person is still talking.
//
// The Mac mints a one-time key (POST /rubato/voice/live, harness/t3-integration/src/voice/
// live.mjs) and this module takes the microphone straight to OpenAI's live transcription over a
// WebSocket opened with it: the audio goes up as `input_audio_buffer.append`, words come back as
// `conversation.item.input_audio_transcription.delta`, and a commit at the end brings each item's
// `…completed` text. The real key never leaves the Mac.
//
// The microphone is captured here, from the moment dictation is asked for, not handed to the
// connection: what the person says while the key is minted and the socket opens (about 2 s,
// measured 2026-11-21) is kept and goes up first, so the start of what they said is heard. Over
// WebRTC that audio was lost, and the model wrote the cut-off start as other words ("받아쓰기
// 테스트야" came out as "되기 TypeScript야" with the first second cut).
//
// It plugs into T3's shared voice controller (client-runtime voice-input) as its recorder and
// its transcriber, so the controller's phases, the waveform, the keep-awake and the commit into
// the draft stay T3's: preparing = minting and connecting, recording = the microphone streaming,
// transcribing = waiting for the final text after stop. The words heard so far are published
// separately (`subscribe` / `snapshot`) for the composer to draw while recording.
//
// The desktop captures through Web Audio, the phone through @livekit/react-native-webrtc's local
// recording; both hand over PCM at the rate they have and this module brings it to 24 kHz.

export interface LiveDictationKey {
  readonly clientSecret: string;
}

/** The microphone while it is captured. */
export interface LiveMicrophone {
  /** Stops capturing and lets the microphone go. */
  stop(): void;
}
/**
 * Captured audio, mono, as 16-bit sample values (−32768…32767, fractional is fine) at the rate the
 * platform captures.
 */
export type LiveAudioSink = (samples: ArrayLike<number>, sampleRate: number) => void;

/** The part of a WebSocket both the browser's and React Native's have. */
export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Where the socket goes. The key carries the session (model, language, words). */
export const LIVE_SOCKET_URL = "wss://api.openai.com/v1/realtime";
/** The rate OpenAI's realtime input takes (`audio/pcm`). */
export const LIVE_SAMPLE_RATE = 24_000;

/**
 * Opens the socket with the one-time key. Browsers cannot set headers on a WebSocket, so the key
 * goes as a subprotocol, which OpenAI accepts from both (checked against the live API 2026-11-21).
 */
export function openLiveSocket(clientSecret: string): LiveSocket {
  return new WebSocket(LIVE_SOCKET_URL, ["realtime", `openai-insecure-api-key.${clientSecret}`]) as never;
}

export interface LiveDictationPlatform {
  /** Asks the Mac for a key. Rejects with the error the composer should show. */
  readonly mint: (signal: AbortSignal) => Promise<LiveDictationKey>;
  /** Starts capturing at once and hands every piece of audio to `sink` as it comes. */
  readonly openMicrophone: (sink: LiveAudioSink) => Promise<LiveMicrophone>;
  /** Defaults to `openLiveSocket`. */
  readonly openSocket?: (clientSecret: string) => LiveSocket;
  /** The failure the composer shows when OpenAI cannot be reached or refuses the key. */
  readonly connectionFailed: (message: string) => Error;
  readonly now?: () => number;
}

/**
 * How long a key minted ahead (`warm`) is still used. The Mac's key opens a connection for 60 s;
 * the rest is margin for the connection itself.
 */
export const LIVE_KEY_REUSE_MS = 40_000;
/**
 * How a heard word moves, as ChatGPT's iOS dictation draws it (measured frame by frame from the
 * user's screen recording, 2026-11-20): it fades in, light blue to blue, over FADE_IN; stays blue
 * for HOLD after it arrived; then fades to the grey of the rest over FADE_OUT. Each word on its own
 * clock, so the older words go grey first and the last second or so stays blue.
 */
export const LIVE_FADE_IN_MS = 120;
export const LIVE_HOLD_MS = 700;
export const LIVE_FADE_OUT_MS = 400;
/** After this long a word is plain grey and needs no more frames. */
export const LIVE_SETTLE_MS = LIVE_HOLD_MS + LIVE_FADE_OUT_MS;

/** How visible (0…1) and how blue rather than grey (0…1) a word is `age` ms after it arrived. */
export function liveDictationTint(age: number): { readonly visible: number; readonly blue: number } {
  const visible = Math.min(1, 0.25 + (0.75 * Math.max(0, age)) / LIVE_FADE_IN_MS);
  const blue = age <= LIVE_HOLD_MS ? 1 : Math.max(0, 1 - (age - LIVE_HOLD_MS) / LIVE_FADE_OUT_MS);
  return { visible, blue };
}
/** How long stop waits for the final text before keeping the words already shown. */
export const LIVE_FINISH_TIMEOUT_MS = 4_000;
const CONNECT_TIMEOUT_MS = 12_000;
/** Audio goes up in pieces of at least this many samples (50 ms), not every 10 ms the phone hands over. */
const SEND_SAMPLES = LIVE_SAMPLE_RATE / 20;
/** Audio kept while connecting, at most (a connection that slow fails at CONNECT_TIMEOUT_MS anyway). */
const MAX_BACKLOG_SAMPLES = LIVE_SAMPLE_RATE * 15;

/**
 * Brings audio from the rate the platform captures to 24 kHz, piece after piece without seams:
 * lower rates are interpolated, higher rates are averaged over each output sample's span. Rates
 * are whole hertz.
 */
export function createLiveResampler(outRate = LIVE_SAMPLE_RATE) {
  let rate = 0;
  let previous = 0;
  let position = 0;
  let sum = 0;
  let count = 0;
  return (samples: ArrayLike<number>, sampleRate: number): Int16Array => {
    if (sampleRate !== rate) {
      rate = sampleRate;
      previous = 0;
      position = 0;
      sum = 0;
      count = 0;
    }
    const out: number[] = [];
    // Positions count in 1/(sampleRate·outRate) of a second, whole numbers, so nothing drifts.
    if (sampleRate === outRate) {
      for (let index = 0; index < samples.length; index += 1) out.push(samples[index]!);
    } else if (sampleRate < outRate) {
      // Each output sample sits `position / outRate` of the way from the previous input sample to this one.
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index]!;
        while (position < outRate) {
          out.push(previous + ((sample - previous) * position) / outRate);
          position += sampleRate;
        }
        position -= outRate;
        previous = sample;
      }
    } else {
      // Each input sample adds `outRate` to `position`; an output sample is due at every `sampleRate`.
      for (let index = 0; index < samples.length; index += 1) {
        sum += samples[index]!;
        count += 1;
        position += outRate;
        if (position >= sampleRate) {
          out.push(sum / count);
          position -= sampleRate;
          sum = 0;
          count = 0;
        }
      }
    }
    const pcm = new Int16Array(out.length);
    for (let index = 0; index < out.length; index += 1) {
      pcm[index] = Math.max(-32768, Math.min(32767, Math.round(out[index]!)));
    }
    return pcm;
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** 16-bit little-endian PCM as base64, the way `input_audio_buffer.append` takes it. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  for (let index = 0; index < pcm.length; index += 1) {
    const value = pcm[index]! & 0xffff;
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = value >> 8;
  }
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    parts.push(
      BASE64[(triple >> 18) & 63]! +
        BASE64[(triple >> 12) & 63]! +
        (b === undefined ? "=" : BASE64[(triple >> 6) & 63]!) +
        (c === undefined ? "=" : BASE64[triple & 63]!),
    );
  }
  return parts.join("");
}

/** 0…1, the loudest sample of a piece, as WebRTC's audioLevel reads a microphone. */
function peakLevel(pcm: Int16Array): number {
  let peak = 0;
  for (let index = 0; index < pcm.length; index += 1) peak = Math.max(peak, Math.abs(pcm[index]!));
  return Math.min(1, peak / 32767);
}

type Piece = { readonly text: string; readonly at: number };
type Item = { pieces: Piece[]; final: string | null };

export type LiveDictationSnapshot = {
  /** Items in the order they were heard: the words so far and, once settled, the final text. */
  readonly items: ReadonlyArray<{ readonly pieces: ReadonlyArray<Piece>; readonly final: string | null }>;
  readonly active: boolean;
};

const EMPTY: LiveDictationSnapshot = { items: [], active: false };

/**
 * The heard text as it arrived: each word piece with when it came, and an item's final text, once
 * it came, with no time (it reads grey). Joined, the pieces are the text the composer shows.
 */
export function liveDictationPieces(
  snapshot: LiveDictationSnapshot,
): ReadonlyArray<{ readonly text: string; readonly at: number | null }> {
  const pieces: Array<{ readonly text: string; readonly at: number | null }> = [];
  for (const item of snapshot.items) {
    if (item.final !== null) {
      const text = pieces.length > 0 && !/^\s/.test(item.final) ? ` ${item.final}` : item.final;
      pieces.push({ text, at: null });
    } else pieces.push(...item.pieces);
  }
  return pieces;
}

/** The text a stop commits: each item's final text, or its words when no final came. */
export function liveDictationText(snapshot: LiveDictationSnapshot): string {
  return snapshot.items
    .map((item) => (item.final ?? item.pieces.map((piece) => piece.text).join("")).trim())
    .filter((text) => text.length > 0)
    .join(" ");
}

type Listener = () => void;
let current: LiveDictationSnapshot = EMPTY;
const listeners = new Set<Listener>();
function publish(next: LiveDictationSnapshot): void {
  current = next;
  for (const listener of listeners) listener();
}

/** The words of the dictation running now. One runs at a time (T3's controller holds a lock). */
export const liveDictationStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): LiveDictationSnapshot {
    return current;
  },
};

/** One connection: the microphone streaming to OpenAI, words collected as they come. */
class LiveConnection {
  private readonly items = new Map<string, Item>();
  private readonly resample = createLiveResampler();
  private microphone: LiveMicrophone | null = null;
  private socket: LiveSocket | null = null;
  /** Audio not sent yet: everything heard while connecting, then less than a piece. */
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private listening = true;
  private lastLevel = 0;
  private closed = false;
  private committed = false;
  private settledAfterCommit = false;
  private failure: string | null = null;
  private wake: (() => void) | null = null;

  private readonly platform: LiveDictationPlatform;
  /** Told about every change; it publishes only while this is the dictation running now. */
  private readonly onChange: (connection: LiveConnection) => void;

  constructor(platform: LiveDictationPlatform, onChange: (connection: LiveConnection) => void) {
    this.platform = platform;
    this.onChange = onChange;
  }

  now(): number {
    return this.platform.now?.() ?? Date.now();
  }

  async open(key: Promise<LiveDictationKey>, signal: AbortSignal): Promise<void> {
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      // The microphone first and on its own: it hears from now on, while the key is minted and the
      // socket opens, and what it hears waits in `pending`.
      const microphone = this.platform.openMicrophone((samples, sampleRate) => this.hear(samples, sampleRate));
      // A key that fails must not leave the microphone open, nor go unhandled while it opens.
      key.catch(() => {});
      this.microphone = await microphone;
      if (this.closed) {
        this.microphone.stop();
        throw this.platform.connectionFailed("Dictation was cancelled.");
      }
      const minted = await key;
      if (this.closed) throw this.platform.connectionFailed("Dictation was cancelled.");
      const socket = (this.platform.openSocket ?? openLiveSocket)(minted.clientSecret);
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(this.platform.connectionFailed("OpenAI did not answer in time.")),
          CONNECT_TIMEOUT_MS,
        );
        socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(this.platform.connectionFailed("OpenAI could not be reached."));
        };
        socket.onclose = () => {
          clearTimeout(timer);
          if (!this.closed) reject(this.platform.connectionFailed("The connection to OpenAI closed."));
          this.notify();
        };
      });
      socket.onerror = null;
      socket.onmessage = (event) => this.receive(event.data);
      if (this.closed) throw this.platform.connectionFailed("Dictation was cancelled.");
      // What was said while connecting goes up first, in one piece.
      this.send(true);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** 0…1, the microphone's level, from the audio it captured last. */
  level(): number {
    return this.closed || !this.listening ? 0 : this.lastLevel;
  }

  /** Stops taking audio; what was taken still goes up. */
  mute(): void {
    this.listening = false;
  }

  private hear(samples: ArrayLike<number>, sampleRate: number): void {
    if (this.closed || !this.listening) return;
    const pcm = this.resample(samples, sampleRate);
    if (pcm.length === 0) return;
    this.lastLevel = peakLevel(pcm);
    this.pending.push(pcm);
    this.pendingSamples += pcm.length;
    // Connecting can take long; keep the latest audio, not all of it.
    while (this.pendingSamples > MAX_BACKLOG_SAMPLES && this.pending.length > 1) {
      this.pendingSamples -= this.pending.shift()!.length;
    }
    this.send(false);
  }

  /** Sends what waits, once there is a piece's worth (or everything, when `all`). */
  private send(all: boolean): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.closed || this.committed) return;
    if (this.pendingSamples === 0 || (!all && this.pendingSamples < SEND_SAMPLES)) return;
    const pcm = new Int16Array(this.pendingSamples);
    let offset = 0;
    for (const piece of this.pending) {
      pcm.set(piece, offset);
      offset += piece.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcmToBase64(pcm) }));
  }

  /** Stops listening and waits for the final text of everything heard. */
  async finish(signal: AbortSignal): Promise<string> {
    this.mute();
    this.microphone?.stop();
    this.microphone = null;
    if (!this.committed && this.socket?.readyState === 1) {
      this.send(true);
      this.committed = true;
      this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
    const deadline = this.now() + LIVE_FINISH_TIMEOUT_MS;
    while (!this.closed && !signal.aborted && !this.settled() && this.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - this.now()));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    const text = liveDictationText(this.snapshot());
    if (text.length === 0 && this.failure) throw this.platform.connectionFailed(this.failure);
    return text;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.pendingSamples = 0;
    try {
      this.socket?.close();
    } catch {}
    try {
      this.microphone?.stop();
    } catch {}
    this.microphone = null;
    this.wake?.();
  }

  snapshot(): LiveDictationSnapshot {
    return {
      active: !this.closed,
      items: [...this.items.values()].map((item) => ({ pieces: item.pieces, final: item.final })),
    };
  }

  private settled(): boolean {
    // Everything heard has its final text, and the commit has answered (an empty buffer answers
    // with an error, which also ends the wait).
    return this.settledAfterCommit && [...this.items.values()].every((item) => item.final !== null);
  }

  private item(id: string): Item {
    let item = this.items.get(id);
    if (!item) {
      item = { pieces: [], final: null };
      this.items.set(id, item);
    }
    return item;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let event: {
      readonly type?: unknown;
      readonly item_id?: unknown;
      readonly delta?: unknown;
      readonly transcript?: unknown;
      readonly error?: { readonly message?: unknown };
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const id = typeof event.item_id === "string" ? event.item_id : "item";
    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta":
        if (typeof event.delta === "string" && event.delta.length > 0) {
          this.item(id).pieces.push({ text: event.delta, at: this.now() });
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.item(id).final = typeof event.transcript === "string" ? event.transcript : "";
        if (this.committed) this.settledAfterCommit = true;
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.item(id).final = this.item(id).pieces.map((piece) => piece.text).join("");
        if (this.committed) this.settledAfterCommit = true;
        break;
      case "error":
        this.failure = typeof event.error?.message === "string" ? "OpenAI stopped the dictation." : this.failure;
        // A commit with nothing in the buffer answers with an error: nothing more is coming.
        if (this.committed) this.settledAfterCommit = true;
        break;
      default:
        return;
    }
    this.notify();
  }

  private notify(): void {
    this.onChange(this);
    this.wake?.();
  }
}

export type LiveRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

/**
 * The recorder and transcriber T3's controller takes, both driving one live connection.
 * `deleteRecording` belongs in the controller's dependencies: the controller calls it with
 * every recording it owned once a dictation is over, which is when the connection closes.
 */
export function createLiveDictation(
  platform: LiveDictationPlatform,
  onRecorderStatus: (status: LiveRecorderStatus) => void,
  /** Told the final text of each dictation, before the controller puts it in the draft. */
  onDictated?: (text: string) => void,
) {
  let connection: LiveConnection | null = null;
  let serial = 0;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let recordingStartedAt: number | null = null;
  let spokenLanguage = "ko";
  let warmKey: { readonly key: Promise<LiveDictationKey>; readonly at: number } | null = null;
  const now = () => platform.now?.() ?? Date.now();
  // A key minted ahead, if one is young enough; otherwise a new one. Each key opens one connection.
  const takeKey = (signal: AbortSignal): Promise<LiveDictationKey> => {
    const warm = warmKey;
    warmKey = null;
    return warm && now() - warm.at < LIVE_KEY_REUSE_MS ? warm.key : platform.mint(signal);
  };

  const clearTimers = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
  };
  const level = () => (recordingStartedAt === null ? 0 : (connection?.level() ?? 0));
  const end = () => {
    clearTimers();
    recordingStartedAt = null;
    connection?.close();
    connection = null;
    publish(EMPTY);
  };

  const recorder = {
    uri: null as string | null,
    async prepareToRecordAsync(): Promise<void> {
      if (!connection) throw platform.connectionFailed("Dictation is not connected.");
    },
    record({ forDuration }: { readonly forDuration: number }): void {
      const live = connection;
      if (!live) throw platform.connectionFailed("Dictation is not connected.");
      recordingStartedAt = live.now();
      const uri = recorder.uri;
      // A forgotten dictation still ends with its text instead of running forever.
      limitTimer = setTimeout(
        () => onRecorderStatus({ isFinished: true, hasError: false, error: null, url: uri }),
        forDuration * 1000,
      );
    },
    async stop(): Promise<void> {
      clearTimers();
      connection?.mute();
    },
    /** The phone's waveform and clock read this, as they read expo-audio's recorder. */
    getStatus(): { readonly isRecording: boolean; readonly metering: number; readonly durationMillis: number } {
      const live = connection;
      const recording = live !== null && recordingStartedAt !== null;
      const heard = level();
      return {
        isRecording: recording,
        // expo-audio reports decibels; the capture reports 0…1.
        metering: heard > 0 ? 20 * Math.log10(heard) : -160,
        durationMillis: recording ? live.now() - recordingStartedAt! : 0,
      };
    },
    /** 0…1, for a waveform drawn from levels directly (the desktop). */
    level(): number {
      return level();
    },
    release(): void {
      end();
    },
  };

  const transcriber = {
    async prepare({ signal }: { readonly signal: AbortSignal }) {
      end();
      const live = new LiveConnection(platform, (changed) => {
        if (connection === changed) publish(changed.snapshot());
      });
      connection = live;
      // Named now, not when recording starts: the controller releases whatever uri the recorder
      // holds when it gives up, so a failure between here and recording still closes this.
      serial += 1;
      recorder.uri = `live:${serial}`;
      publish(live.snapshot());
      try {
        await live.open(takeKey(signal), signal);
      } catch (error) {
        if (connection === live) end();
        throw error;
      }
      return {
        // Known once the text exists: English needs a word boundary, Korean does not.
        get locale(): string {
          return spokenLanguage;
        },
        transcribe: async (_uri: string, options: { readonly signal: AbortSignal }): Promise<string> => {
          const text = await live.finish(options.signal);
          spokenLanguage = /[가-힣]/.test(text) ? "ko" : "en";
          onDictated?.(text);
          return text;
        },
      };
    },
  };

  return {
    recorder,
    transcriber,
    /**
     * Starts minting the Mac's key before dictation asks for it, so the wait for the key overlaps
     * the microphone permission check. Minting costs nothing at OpenAI; only the connection does.
     */
    warm(): void {
      if (warmKey && now() - warmKey.at < LIVE_KEY_REUSE_MS) return;
      const key = platform.mint(new AbortController().signal);
      key.catch(() => {});
      warmKey = { key, at: now() };
    },
    /** For the controller's `deleteRecording`: the dictation is over, close everything. */
    deleteRecording(uri: string): void {
      if (uri === recorder.uri) end();
    },
  };
}

/**
 * What one composer dictated, held until its draft goes out: then the dictated texts the person
 * changed and what was sent, for the Mac to keep the words they fixed (harness/t3-integration
 * src/voice/vocabulary.mjs). A draft that goes out with every dictated text as it was, or a draft
 * emptied after nothing was dictated, reports nothing. Sending is seen as the draft becoming empty.
 */
export function createDictationEdits() {
  let heard: string[] = [];
  let last = "";
  return {
    dictated(text: string): void {
      const trimmed = text.trim();
      if (trimmed !== "") heard.push(trimmed);
    },
    /** The draft as it is now; when it empties, what to report, if anything. */
    draft(text: string): { readonly heard: ReadonlyArray<string>; readonly sent: string } | null {
      if (text.trim() !== "") {
        last = text;
        return null;
      }
      const sent = last;
      const dictated = heard;
      heard = [];
      last = "";
      if (dictated.length === 0 || sent.trim() === "") return null;
      const changed = dictated.filter((entry) => !sent.includes(entry));
      return changed.length > 0 ? { heard: changed, sent } : null;
    },
    reset(): void {
      heard = [];
      last = "";
    },
  };
}
