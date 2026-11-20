// Live dictation: words appear in the composer while the person is still talking.
//
// The Mac mints a one-time key (POST /rubato/voice/live, harness/t3-integration/src/voice/
// live.mjs) and this module takes the microphone straight to OpenAI's live transcription over
// WebRTC with it: the SDP offer goes to `callsUrl`, words come back on the `oai-events` data
// channel as `conversation.item.input_audio_transcription.delta`, and a commit at the end
// brings each item's `…completed` text. The real key never leaves the Mac.
//
// It plugs into T3's shared voice controller (client-runtime voice-input) as its recorder and
// its transcriber, so the controller's phases, the waveform, the keep-awake and the commit into
// the draft stay T3's: preparing = minting and connecting, recording = the microphone streaming,
// transcribing = waiting for the final text after stop. The words heard so far are published
// separately (`subscribe` / `snapshot`) for the composer to draw while recording.
//
// The desktop passes the browser's WebRTC, the phone passes @livekit/react-native-webrtc; the
// shapes below are the part of WebRTC both have.

export interface LiveDictationKey {
  readonly clientSecret: string;
  readonly callsUrl: string;
}

interface LiveTrack {
  enabled: boolean;
  stop(): void;
}
interface LiveStream {
  getAudioTracks(): ReadonlyArray<LiveTrack>;
  getTracks(): ReadonlyArray<LiveTrack>;
}
interface LiveChannel {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
}
interface LiveStatsReport {
  readonly type?: string;
  readonly kind?: string;
  readonly audioLevel?: number;
}
interface LivePeer {
  addTrack(track: never, stream: never): unknown;
  createDataChannel(label: string): LiveChannel;
  createOffer(): Promise<{ readonly sdp?: string | null; readonly type?: string | null }>;
  setLocalDescription(description: never): Promise<void>;
  setRemoteDescription(description: never): Promise<void>;
  getStats(): Promise<{ forEach(callback: (report: LiveStatsReport) => void): void }>;
  close(): void;
}

export interface LiveDictationPlatform {
  /** Asks the Mac for a key. Rejects with the error the composer should show. */
  readonly mint: (signal: AbortSignal) => Promise<LiveDictationKey>;
  readonly openMicrophone: () => Promise<LiveStream>;
  readonly createPeer: () => LivePeer;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
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
  private stream: LiveStream | null = null;
  private peer: LivePeer | null = null;
  private channel: LiveChannel | null = null;
  private closed = false;
  private committed = false;
  private settledAfterCommit = false;
  private failure: string | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly platform: LiveDictationPlatform,
    /** Told about every change; it publishes only while this is the dictation running now. */
    private readonly onChange: (connection: LiveConnection) => void,
  ) {}

  now(): number {
    return this.platform.now?.() ?? Date.now();
  }

  async open(key: Promise<LiveDictationKey>, signal: AbortSignal): Promise<void> {
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      // The key and the microphone at once: both take a moment and neither needs the other.
      const [minted, stream] = await Promise.all([key, this.platform.openMicrophone()]);
      this.stream = stream;
      if (this.closed) throw this.platform.connectionFailed("Dictation was cancelled.");
      const track = stream.getAudioTracks()[0];
      if (!track) throw this.platform.connectionFailed("No microphone is available.");
      const peer = this.platform.createPeer();
      this.peer = peer;
      peer.addTrack(track as never, stream as never);
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      const opened = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(this.platform.connectionFailed("OpenAI did not answer in time.")),
          CONNECT_TIMEOUT_MS,
        );
        channel.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        channel.onclose = () => {
          clearTimeout(timer);
          if (!this.closed) reject(this.platform.connectionFailed("The connection to OpenAI closed."));
          this.notify();
        };
      });
      channel.onmessage = (event) => this.receive(event.data);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer as never);
      const response = await this.platform
        .fetch(minted.callsUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${minted.clientSecret}`, "content-type": "application/sdp" },
          body: offer.sdp ?? "",
          signal,
        })
        .catch(() => null);
      if (!response?.ok) throw this.platform.connectionFailed("OpenAI could not be reached.");
      const answer = await response.text();
      await peer.setRemoteDescription({ type: "answer", sdp: answer } as never);
      await opened;
      if (this.closed) throw this.platform.connectionFailed("Dictation was cancelled.");
    } catch (error) {
      this.close();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** 0…1, the microphone's level as WebRTC measures what it sends. */
  async level(): Promise<number> {
    const peer = this.peer;
    if (!peer || this.closed) return 0;
    let level = 0;
    try {
      const stats = await peer.getStats();
      stats.forEach((report) => {
        if (report.type === "media-source" && report.kind === "audio" && typeof report.audioLevel === "number") {
          level = Math.max(level, report.audioLevel);
        }
      });
    } catch {
      return 0;
    }
    return level;
  }

  mute(): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = false;
  }

  /** Stops listening and waits for the final text of everything heard. */
  async finish(signal: AbortSignal): Promise<string> {
    this.mute();
    if (!this.committed && this.channel?.readyState === "open") {
      this.committed = true;
      this.channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
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
    try {
      this.channel?.close();
    } catch {}
    try {
      this.peer?.close();
    } catch {}
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {}
    }
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
) {
  let connection: LiveConnection | null = null;
  let serial = 0;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let recordingStartedAt: number | null = null;
  let spokenLanguage = "ko";
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let lastLevel = 0;
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
    if (levelTimer !== null) clearInterval(levelTimer);
    limitTimer = null;
    levelTimer = null;
  };
  const end = () => {
    clearTimers();
    recordingStartedAt = null;
    lastLevel = 0;
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
      levelTimer = setInterval(() => {
        void live.level().then((level) => {
          lastLevel = level;
        });
      }, 80);
    },
    async stop(): Promise<void> {
      clearTimers();
      connection?.mute();
    },
    /** The phone's waveform and clock read this, as they read expo-audio's recorder. */
    getStatus(): { readonly isRecording: boolean; readonly metering: number; readonly durationMillis: number } {
      const live = connection;
      const recording = live !== null && recordingStartedAt !== null;
      return {
        isRecording: recording,
        // expo-audio reports decibels; WebRTC reports 0…1.
        metering: lastLevel > 0 ? 20 * Math.log10(lastLevel) : -160,
        durationMillis: recording ? live.now() - recordingStartedAt! : 0,
      };
    },
    /** 0…1, for a waveform drawn from levels directly (the desktop). */
    level(): number {
      return lastLevel;
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
