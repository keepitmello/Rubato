// Rubato: the phone's dictation goes through the Mac's voice service, the route the desktop
// composer uses (/rubato/voice/session; overlay apps/web/src/state/rubatoVoice.ts). The OpenAI
// key and model stay in the Mac's settings; the phone sends the recording over its paired
// session and gets text back. It replaces Apple's on-device transcriber for every composer
// (threads and companion rooms), since both run through VoiceInputProvider.
//
//   start  → POST /rubato/voice/session {mode: "draft"}       a draft session on the Mac
//   stop   → POST /rubato/voice/session/<id>/transcribe       the m4a, text back
//   failed → POST /rubato/voice/session/<id>/cancel
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceInputState,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import { File } from "expo-file-system";
import { fetch } from "expo/fetch";

import type { SavedRemoteConnection } from "../../lib/connection";
import { macVoiceFailureMessage } from "./macVoiceFailures";

const VOICE_ROUTE = "/rubato/voice/session";

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

async function failed(
  kind: "preparation-failed" | "transcription-failed",
  response: Response | null,
): Promise<VoiceTranscriptionError> {
  const payload = response
    ? ((await response.json().catch(() => null)) as { readonly error?: { readonly code?: unknown } } | null)
    : null;
  const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
  const message = macVoiceFailureMessage(response?.status ?? null, code);
  lastFailure = message;
  return new VoiceTranscriptionError(kind, message);
}

export function createMacVoiceTranscriber(
  readConnections: () => ReadonlyArray<SavedRemoteConnection>,
): VoiceTranscriber {
  let session: { readonly mac: MacConnection; readonly id: string } | null = null;
  let spokenLanguage = "ko";

  const endSession = (): void => {
    const current = session;
    session = null;
    if (!current) return;
    void fetch(`${current.mac.baseUrl}${VOICE_ROUTE}/${current.id}/cancel`, {
      method: "POST",
      headers: current.mac.headers,
    }).catch(() => {});
  };

  const transcribe = async (uri: string, options: VoiceTranscriptionOptions): Promise<string> => {
    const current = session;
    if (!current) throw new VoiceTranscriptionError("transcription-failed", "The recording was already closed.");
    throwIfVoiceTranscriptionAborted(options.signal);
    const audio = await new File(uri).bytes();
    throwIfVoiceTranscriptionAborted(options.signal);
    const response = await fetch(`${current.mac.baseUrl}${VOICE_ROUTE}/${current.id}/transcribe`, {
      method: "POST",
      // The Mac names the file from the content type; Apple's recorder writes AAC in an m4a.
      headers: { ...current.mac.headers, "content-type": "audio/mp4" },
      body: audio,
      signal: options.signal,
    }).catch(() => null);
    if (!response || !response.ok) {
      endSession();
      throw await failed("transcription-failed", response);
    }
    const payload = (await response.json().catch(() => null)) as { readonly text?: unknown } | null;
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    endSession();
    // An empty transcript is the controller's own "No speech was detected."
    spokenLanguage = /[가-힣]/.test(text) ? "ko" : "en";
    return text;
  };

  return {
    prepare: async ({ signal }): Promise<PreparedVoiceTranscription> => {
      lastFailure = null;
      const mac = pickMac(readConnections());
      if (!mac) {
        lastFailure = "Pair this phone with your Mac first: Threads › Add environment.";
        throw new VoiceTranscriptionError("preparation-failed", lastFailure);
      }
      endSession();
      const response = await fetch(`${mac.baseUrl}${VOICE_ROUTE}`, {
        method: "POST",
        headers: { ...mac.headers, "content-type": "application/json" },
        body: JSON.stringify({ mode: "draft" }),
        signal,
      }).catch(() => null);
      if (!response || !response.ok) throw await failed("preparation-failed", response);
      const payload = (await response.json().catch(() => null)) as { readonly voiceSessionId?: unknown } | null;
      if (typeof payload?.voiceSessionId !== "string") {
        lastFailure = "Your Mac did not open a recording. Try again.";
        throw new VoiceTranscriptionError("preparation-failed", lastFailure);
      }
      session = { mac, id: payload.voiceSessionId };
      return {
        // Known only once the text exists: English needs a word boundary, Korean does not.
        get locale(): string {
          return spokenLanguage;
        },
        transcribe,
      };
    },
  };
}
