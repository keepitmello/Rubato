import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceRecorder,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import { readPreparedConnection } from "./session";

/** The route the Rubato voice service adds to the T3 server on this Mac. */
const VOICE_ROUTE = "/rubato/voice/session";

/** Chromium records Opus in WebM; Safari records AAC in MP4. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

function recordingType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of RECORDING_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

/** The provider reads the format from the filename, so it must match the bytes. */
function audioFilename(contentType: string): string {
  return contentType.includes("mp4") ? "voice.m4a" : "voice.webm";
}

/**
 * MediaRecorder in the shape the shared voice controller expects: prepare the
 * microphone, record for a bounded duration, stop, and hand back a URL the
 * transcriber can read.
 */
export class RubatoWebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolve: (() => void) | null = null;
  private stopped: Promise<void> = Promise.resolve();
  private reported = false;

  constructor(private readonly onStatus: (status: VoiceRecorderStatus) => void) {}

  async prepareToRecordAsync(): Promise<void> {
    const type = recordingType();
    const media = navigator.mediaDevices;
    if (type === null || media?.getUserMedia === undefined) {
      throw new Error("This window cannot record audio.");
    }
    this.stream = await media.getUserMedia({ audio: true });
    this.chunks = [];
    this.reported = false;
    this.recorder = new MediaRecorder(this.stream, { mimeType: type });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onstop = () => this.finishCapture();
    this.stopped = new Promise((resolve) => {
      this.stopResolve = resolve;
    });
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    if (!this.recorder) throw new Error("The recorder was not prepared.");
    this.recorder.start(1000);
    // A forgotten recording still transcribes instead of running forever.
    this.limitTimer = setTimeout(() => void this.stop(), forDuration * 1000);
  }

  async stop(): Promise<void> {
    if (this.recorder?.state === "recording") this.recorder.stop();
    await this.stopped;
  }

  /** Drops the microphone without transcribing: cancellation and unmount. */
  release(): void {
    this.clearLimit();
    this.reported = true;
    if (this.recorder) this.recorder.onstop = null;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.stopResolve?.();
  }

  private clearLimit(): void {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }

  private finishCapture(): void {
    this.clearLimit();
    const type = this.recorder?.mimeType ?? "audio/webm";
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.uri = URL.createObjectURL(new Blob(this.chunks, { type }));
    this.chunks = [];
    this.stopResolve?.();
    if (this.reported) return;
    this.reported = true;
    this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
  }
}

type VoiceConnection = {
  readonly httpBaseUrl: string;
  readonly authorization: string | null;
};

function resolveVoiceConnection(environmentId: EnvironmentId | null): VoiceConnection {
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) {
    throw new VoiceTranscriptionError("unavailable", "This Mac is not connected.");
  }
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag === "Dpop") {
    // A relay connection signs every request with a DPoP proof. The voice route
    // is not part of that signed surface, so refuse rather than post the
    // recording somewhere it cannot be accepted.
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice input is not available on this connection yet.",
    );
  }
  return {
    httpBaseUrl: prepared.httpBaseUrl.replace(/\/+$/, ""),
    authorization: authorization === null ? null : `Bearer ${authorization.token}`,
  };
}

function headersFor(connection: VoiceConnection): Record<string, string> {
  return connection.authorization === null
    ? {}
    : { authorization: connection.authorization };
}

/** Server codes mapped to something a person can act on. Never the raw body. */
async function failureMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    readonly error?: { readonly code?: unknown };
  } | null;
  const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
  if (response.status === 503 || code === "voice-not-configured") {
    return "Voice input is not set up on this Mac yet.";
  }
  if (code === "expired-session" || code === "session-closed") {
    return "The recording took too long. Start again.";
  }
  if (response.status === 401 || response.status === 403) {
    return "This window is not allowed to use voice input.";
  }
  if (code === "missing-api-key" || code === "missing-model") {
    return "The transcription service is not configured on this Mac.";
  }
  return "The Mac could not transcribe this recording.";
}

/**
 * The Mac's voice service as a transcriber for one composer draft. A draft
 * session is opened when recording starts and closed once the transcript lands,
 * so the audio never leaves the Mac except to the transcription provider.
 */
export function createRubatoVoiceTranscriber(
  readEnvironmentId: () => EnvironmentId | null,
): VoiceTranscriber {
  let session: { readonly connection: VoiceConnection; readonly sessionId: string } | null = null;
  let spokenLanguage = "ko";

  const endSession = (): void => {
    const current = session;
    session = null;
    if (!current) return;
    void fetch(`${current.connection.httpBaseUrl}${VOICE_ROUTE}/${current.sessionId}`, {
      method: "DELETE",
      credentials: "include",
      headers: headersFor(current.connection),
    }).catch(() => {});
  };

  const transcribe = async (
    uri: string,
    options: VoiceTranscriptionOptions,
  ): Promise<string> => {
    const current = session;
    if (!current) {
      throw new VoiceTranscriptionError("transcription-failed", "The recording was already closed.");
    }
    throwIfVoiceTranscriptionAborted(options.signal);
    const audio = await fetch(uri).then((response) => response.blob());
    throwIfVoiceTranscriptionAborted(options.signal);
    const contentType = audio.type || "audio/webm";
    const response = await fetch(
      `${current.connection.httpBaseUrl}${VOICE_ROUTE}/${current.sessionId}/transcribe`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          ...headersFor(current.connection),
          "content-type": contentType,
          "x-audio-filename": audioFilename(contentType),
        },
        body: audio,
        signal: options.signal,
      },
    ).catch((cause: unknown) => {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "This Mac could not be reached.",
        { cause },
      );
    });
    if (!response.ok) {
      throw new VoiceTranscriptionError("transcription-failed", await failureMessage(response));
    }
    const payload = (await response.json().catch(() => null)) as {
      readonly text?: unknown;
    } | null;
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (text.length === 0) {
      throw new VoiceTranscriptionError("transcription-failed", "No speech was detected.");
    }
    spokenLanguage = /[가-힣]/.test(text) ? "ko" : "en";
    endSession();
    return text;
  };

  return {
    async prepare({ signal }): Promise<PreparedVoiceTranscription> {
      const connection = resolveVoiceConnection(readEnvironmentId());
      endSession();
      const response = await fetch(`${connection.httpBaseUrl}${VOICE_ROUTE}`, {
        method: "POST",
        credentials: "include",
        headers: { ...headersFor(connection), "content-type": "application/json" },
        body: JSON.stringify({ mode: "draft" }),
        signal,
      }).catch((cause: unknown) => {
        throw new VoiceTranscriptionError(
          "preparation-failed",
          "This Mac could not be reached.",
          { cause },
        );
      });
      if (!response.ok) {
        throw new VoiceTranscriptionError("preparation-failed", await failureMessage(response));
      }
      const payload = (await response.json().catch(() => null)) as {
        readonly voiceSessionId?: unknown;
      } | null;
      const sessionId =
        typeof payload?.voiceSessionId === "string" ? payload.voiceSessionId : null;
      if (sessionId === null) {
        throw new VoiceTranscriptionError(
          "preparation-failed",
          "This Mac did not open a recording.",
        );
      }
      session = { connection, sessionId };
      return {
        // The controller reads the locale after the transcript exists, and the
        // spoken language is only known then: an English dictation needs a word
        // boundary, a Korean one does not.
        get locale(): string {
          return spokenLanguage;
        },
        transcribe,
      };
    },
  };
}
