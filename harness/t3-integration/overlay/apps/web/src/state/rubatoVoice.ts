import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import { createLiveDictation } from "@t3tools/shared/rubatoLiveDictation";

import { rubatoHttpAccess, type RubatoHttpAccess } from "./rubatoHttp";
import { readPreparedConnection } from "./session";

// The shared voice controller (written for the phone app) uses Promise.withResolvers.
// Electron's Chromium has it; the web project's ES2023 lib does not declare it yet.
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

/** The route on this Mac that mints the one-time key for live dictation (src/voice/live.mjs). */
const LIVE_ROUTE = "/rubato/voice/live";

async function resolveVoiceConnection(environmentId: EnvironmentId | null): Promise<RubatoHttpAccess> {
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) {
    throw new VoiceTranscriptionError("unavailable", "This Mac is not connected.");
  }
  const access = await rubatoHttpAccess(prepared);
  if (!access) {
    // A relay connection signs every request with a DPoP proof. The voice route
    // is not part of that signed surface, so refuse rather than post the
    // recording somewhere it cannot be accepted.
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice input is not available on this connection yet.",
    );
  }
  return access;
}

/**
 * Why the last step failed, for the composer. T3's shared controller shows only a
 * generic line for every failure, so the hook puts this back in its place.
 */
export interface RubatoVoiceFailure {
  readonly message: string;
  /** Settings › Chat › Voice input can fix it (key, model, not set up). */
  readonly fixInSettings: boolean;
}

const SETTINGS_FAILURES = new WeakSet<object>();

/** Server codes mapped to something a person can act on. Never the raw body. */
async function failureFrom(
  response: Response,
  kind: "preparation-failed" | "transcription-failed",
): Promise<VoiceTranscriptionError> {
  const payload = (await response.json().catch(() => null)) as {
    readonly error?: { readonly code?: unknown };
  } | null;
  const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
  const inSettings = (message: string) => {
    const error = new VoiceTranscriptionError(kind, message);
    SETTINGS_FAILURES.add(error);
    return error;
  };
  if (code === "missing-api-key") return inSettings("Add an OpenAI API key for voice input.");
  if (code === "api-key-rejected") return inSettings("OpenAI did not accept the voice input API key.");
  if (code === "model-not-found") return inSettings("OpenAI does not know the voice input model.");
  if (response.status === 503 || code === "voice-not-configured" || code === "missing-model") {
    return inSettings("Voice input is not set up yet.");
  }
  if (response.status === 401 || response.status === 403) {
    return new VoiceTranscriptionError(kind, "This window is not allowed to use voice input.");
  }
  return new VoiceTranscriptionError(kind, "The Mac could not start dictation.");
}

/** Reports a failure the person should read, then lets it go on to the controller. */
function reporting<T>(
  onFailure: ((failure: RubatoVoiceFailure) => void) | undefined,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof VoiceTranscriptionError && signal?.aborted !== true) {
      onFailure?.({ message: error.message, fixInSettings: SETTINGS_FAILURES.has(error) });
    }
    throw error;
  });
}

/**
 * Live dictation for one composer: the Mac mints a one-time key, the microphone streams to
 * OpenAI with it over WebRTC, and the words come back while the person talks
 * (@t3tools/shared/rubatoLiveDictation). Returns the recorder and transcriber T3's controller
 * takes, and the `deleteRecording` that closes the connection once the dictation is over.
 */
export function createRubatoLiveDictation(
  readEnvironmentId: () => EnvironmentId | null,
  onFailure: (failure: RubatoVoiceFailure) => void,
  onRecorderStatus: (status: VoiceRecorderStatus) => void,
) {
  const live = createLiveDictation(
    {
      mint: async (signal) => {
        const connection = await resolveVoiceConnection(readEnvironmentId());
        const response = await fetch(`${connection.baseUrl}${LIVE_ROUTE}`, {
          method: "POST",
          credentials: connection.credentials,
          // Only headers T3's CORS allows.
          headers: connection.headers,
          signal,
        }).catch((cause: unknown) => {
          throw new VoiceTranscriptionError("preparation-failed", "This Mac could not be reached.", {
            cause,
          });
        });
        if (!response.ok) throw await failureFrom(response, "preparation-failed");
        const payload = (await response.json().catch(() => null)) as {
          readonly clientSecret?: unknown;
          readonly callsUrl?: unknown;
        } | null;
        if (typeof payload?.clientSecret !== "string" || typeof payload.callsUrl !== "string") {
          throw new VoiceTranscriptionError("preparation-failed", "This Mac did not open a dictation.");
        }
        return { clientSecret: payload.clientSecret, callsUrl: payload.callsUrl };
      },
      openMicrophone: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
      createPeer: () => new RTCPeerConnection() as never,
      fetch: (url, init) => fetch(url, init),
      connectionFailed: (message) => new VoiceTranscriptionError("preparation-failed", message),
    },
    onRecorderStatus,
  );
  const transcriber: VoiceTranscriber = {
    prepare: ({ signal }) =>
      reporting(onFailure, signal, async (): Promise<PreparedVoiceTranscription> => {
        const prepared = await live.transcriber.prepare({ signal });
        return {
          get locale(): string {
            return prepared.locale;
          },
          transcribe: (uri: string, options: VoiceTranscriptionOptions) =>
            reporting(onFailure, options.signal, () => prepared.transcribe(uri, options)),
        };
      }),
  };
  return { recorder: live.recorder, transcriber, deleteRecording: live.deleteRecording, warm: live.warm };
}
