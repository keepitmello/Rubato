// Rubato: the phone dictates live, the way the desktop composer does (overlay apps/web/src/state/
// rubatoVoice.ts). The paired Mac mints a one-time key (POST /rubato/voice/live); the microphone
// then streams straight to OpenAI's live transcription over a WebSocket opened with it, and words
// come back while the person talks (@t3tools/shared/rubatoLiveDictation). The OpenAI key and its
// settings stay on the Mac. It replaces Apple's on-device transcriber for every composer (threads,
// new tasks, companion rooms, scheduled tasks), since all run through VoiceInputProvider.
import { AudioDeviceModule, mediaDevices } from "@livekit/react-native-webrtc";
import { NativeEventEmitter, NativeModules } from "react-native";
import {
  VoiceTranscriptionError,
  type VoiceRecorderStatus,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createLiveDictation, type LiveAudioSink, type LiveMicrophone } from "@t3tools/shared/rubatoLiveDictation";
import { fetch } from "expo/fetch";

import type { SavedRemoteConnection } from "../../lib/connection";
import { savedMacHeaders } from "../companions/rubatoHttp";
import { macFetch } from "../rubato-push/sync";
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
  void macFetch(fetch, mac.access, `${mac.baseUrl}${CORRECTIONS_ROUTE}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edits),
  }).catch(() => {});
}

type MacConnection = {
  readonly baseUrl: string;
  readonly access: { readonly authorize: (method: "POST", url: string, rejected?: string) => Promise<Record<string, string>> };
};

/** The Mac to dictate through: the first paired one (its credentials come per request, savedMacHeaders). */
function pickMac(connections: ReadonlyArray<SavedRemoteConnection>): MacConnection | null {
  const connection = connections[0];
  return connection
    ? {
        baseUrl: connection.httpBaseUrl.replace(/\/+$/, ""),
        access: { authorize: (method, url, rejected) => savedMacHeaders(connection, method, url, rejected) },
      }
    : null;
}

/** T3's controller shows a transcription error's own message, so the Mac's reason reaches the composer. */
function failed(message: string): VoiceTranscriptionError {
  return new VoiceTranscriptionError({ code: "preparation-failed", message });
}

/** LiveKit's native module (@livekit/react-native, set up at launch by its Expo plugin). */
type LiveKitAudioSinks = {
  createAudioSinkListener(peerConnectionId: number, trackId: string): string;
  deleteAudioSinkListener(tag: string, peerConnectionId: number, trackId: string): unknown;
};
let liveKitEvents: NativeEventEmitter | null = null;

/**
 * The microphone through iOS WebRTC with no call: local recording starts the audio engine (and its
 * echo and noise processing), and LiveKit's audio sink hands every processed 10 ms of it to JS as
 * 16-bit PCM. Nothing waits for a connection, so what is said while dictation connects is kept.
 * Both are in the native build already (@livekit/react-native-webrtc 150, @livekit/react-native 3).
 */
async function openPhoneMicrophone(sink: LiveAudioSink): Promise<LiveMicrophone> {
  const sinks = NativeModules.LivekitReactNativeModule as LiveKitAudioSinks | undefined;
  if (!sinks) throw failed("Dictation needs the app's audio module. Update the app.");
  const stream = await mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  if (!track) {
    for (const each of stream.getTracks()) each.stop();
    throw failed("No microphone is available.");
  }
  // -1: a track of no peer connection, so the sink listens to the microphone after processing.
  const tag = sinks.createAudioSinkListener(-1, track.id);
  liveKitEvents ??= new NativeEventEmitter(NativeModules.LivekitReactNativeModule);
  const subscription = liveKitEvents.addListener("LK_AUDIO_DATA", (event: { readonly id?: string; readonly data?: string }) => {
    if (event.id !== tag || typeof event.data !== "string") return;
    const bytes = Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    // Each piece is 10 ms, so its length gives the rate.
    sink(samples, samples.length * 100);
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    subscription.remove();
    sinks.deleteAudioSinkListener(tag, -1, track.id);
    void AudioDeviceModule.stopLocalRecording().catch(() => {});
    for (const each of stream.getTracks()) each.stop();
  };
  try {
    await AudioDeviceModule.startLocalRecording();
  } catch (error) {
    stop();
    throw failed(error instanceof Error ? error.message : "The microphone could not start.");
  }
  return { stop };
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
        const response = await macFetch(fetch, mac.access, `${mac.baseUrl}${LIVE_ROUTE}`, { signal }).catch(
          () => null,
        );
        if (!response || !response.ok) {
          const payload = response
            ? ((await response.json().catch(() => null)) as { readonly error?: { readonly code?: unknown } } | null)
            : null;
          const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
          throw failed(macVoiceFailureMessage(response?.status ?? null, code));
        }
        const payload = (await response.json().catch(() => null)) as {
          readonly clientSecret?: unknown;
        } | null;
        if (typeof payload?.clientSecret !== "string") {
          throw failed("Your Mac did not open a dictation. Try again.");
        }
        return { clientSecret: payload.clientSecret };
      },
      openMicrophone: openPhoneMicrophone,
      connectionFailed: (message) => failed(message),
    },
    onRecorderStatus,
    (text) => {
      for (const listener of dictatedListeners) listener(text);
    },
  );
  const transcriber: VoiceTranscriber = live.transcriber;
  return { recorder: live.recorder, transcriber, deleteRecording: live.deleteRecording, warm: live.warm };
}
