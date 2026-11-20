// Rubato: the phone dictates live, the way the desktop composer does (overlay apps/web/src/state/
// rubatoVoice.ts). The paired Mac mints a one-time key (POST /rubato/voice/live); the microphone
// then streams straight to OpenAI's live transcription over WebRTC with it, and words come back
// while the person talks (@t3tools/shared/rubatoLiveDictation). The OpenAI key and its settings
// stay on the Mac. It replaces Apple's on-device transcriber for every composer (threads and
// companion rooms), since both run through VoiceInputProvider.
import { mediaDevices, RTCPeerConnection } from "@livekit/react-native-webrtc";
import {
  VoiceTranscriptionError,
  type VoiceInputState,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createLiveDictation } from "@t3tools/shared/rubatoLiveDictation";
import { fetch } from "expo/fetch";

import type { SavedRemoteConnection } from "../../lib/connection";
import { macVoiceFailureMessage } from "./macVoiceFailures";

const LIVE_ROUTE = "/rubato/voice/live";
/** Where a composer reports a dictation the person changed before sending (src/voice/vocabulary.mjs). */
const CORRECTIONS_ROUTE = "/rubato/voice/corrections";

/** The paired Macs, as the voice provider last handed them over; reports go to the same Mac. */
let connectionsReader: (() => ReadonlyArray<SavedRemoteConnection>) | null = null;
const dictatedListeners = new Set<(text: string) => void>();

/** Hears the final text of each dictation, before it goes into the draft. */
export function onDictated(listener: (text: string) => void): () => void {
  dictatedListeners.add(listener);
  return () => dictatedListeners.delete(listener);
}

/**
 * What the person dictated and what they sent instead, so the Mac keeps the words they fixed and the
 * user dream can teach dictation those words. A failure here only loses the hint.
 */
export function reportDictationEdits(edits: { readonly heard: ReadonlyArray<string>; readonly sent: string }): void {
  const mac = connectionsReader ? pickMac(connectionsReader()) : null;
  if (!mac) return;
  void fetch(`${mac.baseUrl}${CORRECTIONS_ROUTE}`, {
    method: "POST",
    headers: { ...mac.headers, "content-type": "application/json" },
    body: JSON.stringify(edits),
  }).catch(() => {});
}

/** T3's controller shows one generic line per failure; the provider puts this one back. */
let lastFailure: string | null = null;

// The controller's own lines for a failed prepare or transcribe; other errors (microphone
// permission, a recording that ended badly) keep their text.
const GENERIC_LINES = new Set([
  "Could not prepare voice transcription.",
  "Could not transcribe this recording.",
]);

/** The voice state with the Mac's reason in place of the controller's generic line. */
export function withMacVoiceFailure(state: VoiceInputState): VoiceInputState {
  return state.error !== null && GENERIC_LINES.has(state.error) && lastFailure !== null
    ? { ...state, error: lastFailure }
    : state;
}

type MacConnection = { readonly baseUrl: string; readonly headers: Record<string, string> };

/** The Mac to dictate through: the first paired one that has a bearer session. */
function pickMac(connections: ReadonlyArray<SavedRemoteConnection>): MacConnection | null {
  for (const connection of connections) {
    if (!connection.bearerToken) continue;
    return {
      baseUrl: connection.httpBaseUrl.replace(/\/+$/, ""),
      headers: { authorization: `Bearer ${connection.bearerToken}` },
    };
  }
  return null;
}

function failed(message: string): VoiceTranscriptionError {
  lastFailure = message;
  return new VoiceTranscriptionError("preparation-failed", message);
}

/**
 * The recorder and transcriber the phone's voice session takes, and the `deleteRecording` that
 * closes the connection once a dictation is over.
 */
export function createMacLiveDictation(
  readConnections: () => ReadonlyArray<SavedRemoteConnection>,
  onRecorderStatus: (status: VoiceRecorderStatus) => void,
) {
  connectionsReader = readConnections;
  const live = createLiveDictation(
    {
      mint: async (signal) => {
        const mac = pickMac(readConnections());
        if (!mac) throw failed("Pair this phone with your Mac first: Threads › Add environment.");
        const response = await fetch(`${mac.baseUrl}${LIVE_ROUTE}`, {
          method: "POST",
          headers: mac.headers,
          signal,
        }).catch(() => null);
        if (!response || !response.ok) {
          const payload = response
            ? ((await response.json().catch(() => null)) as { readonly error?: { readonly code?: unknown } } | null)
            : null;
          const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
          throw failed(macVoiceFailureMessage(response?.status ?? null, code));
        }
        const payload = (await response.json().catch(() => null)) as {
          readonly clientSecret?: unknown;
          readonly callsUrl?: unknown;
        } | null;
        if (typeof payload?.clientSecret !== "string" || typeof payload.callsUrl !== "string") {
          throw failed("Your Mac did not open a dictation. Try again.");
        }
        return { clientSecret: payload.clientSecret, callsUrl: payload.callsUrl };
      },
      // iOS WebRTC runs its own voice processing (echo and noise) on the microphone.
      openMicrophone: () => mediaDevices.getUserMedia({ audio: true }) as never,
      createPeer: () => new RTCPeerConnection() as never,
      fetch: (url, init) => fetch(url, init as never) as unknown as Promise<Response>,
      connectionFailed: (message) => failed(message),
    },
    onRecorderStatus,
    (text) => {
      for (const listener of dictatedListeners) listener(text);
    },
  );
  const transcriber: VoiceTranscriber = {
    prepare: async (options) => {
      lastFailure = null;
      return live.transcriber.prepare(options);
    },
  };
  return { recorder: live.recorder, transcriber, deleteRecording: live.deleteRecording, warm: live.warm };
}
