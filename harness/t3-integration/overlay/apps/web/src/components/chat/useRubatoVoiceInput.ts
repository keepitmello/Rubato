import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useCallback, useEffect, useRef, useState } from "react";

import { createRubatoLiveDictation, type RubatoVoiceFailure } from "../../state/rubatoVoice";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
/** How long the strip and the heard words take to fade out once the final text landed. */
export const LIVE_SETTLING_MS = 200;

/**
 * T3's controller replaces every preparation and transcription failure with one
 * generic line. The failure our transcriber saw says what to do instead, and
 * `settings` marks the ones Settings › Chat › Voice input fixes.
 */
export function withVoiceFailure(
  state: VoiceInputState,
  failure: RubatoVoiceFailure | null,
): VoiceInputState {
  if (state.phase !== "error" || failure === null) return state;
  return { ...state, error: failure.message, errorAction: failure.fixInSettings ? "settings" : state.errorAction };
}

/** The part of a composer draft dictation needs: its text and where the caret is. */
export type RubatoVoiceDraft = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

/**
 * Live dictation for one composer draft. The shared controller owns the phases; this
 * hook connects it to the Mac's one-time key, to the microphone streaming to OpenAI,
 * and to the draft the user is looking at. The words heard so far are in
 * `liveDictationStore` (RubatoLiveDictationText draws them).
 */
export function useRubatoVoiceInput(input: {
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly readDraft: () => RubatoVoiceDraft | null;
  readonly commitDraft: (text: string, cursor: number) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // The draft and caret as dictation found them: the heard words are shown where they will land.
  const [liveDraft, setLiveDraft] = useState<RubatoVoiceDraft | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const revision = useRef(0);
  const previousDraft = useRef<{ ownerKey: string | null; text: string }>({
    ownerKey: null,
    text: "",
  });
  const liveRef = useRef<ReturnType<typeof createRubatoLiveDictation> | null>(null);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const lastFailure = useRef<RubatoVoiceFailure | null>(null);

  if (!controllerRef.current) {
    const live = createRubatoLiveDictation(
      () => latest.current.environmentId,
      (failure) => {
        lastFailure.current = failure;
      },
      (status) => controllerRef.current?.handleRecorderStatus(status),
    );
    liveRef.current = live;
    controllerRef.current = new VoiceInputController({
      recorder: live.recorder,
      getTranscriber: () => live.transcriber,
      requestPermission: async () => {
        // The Mac's key is minted while the microphone permission is checked.
        live.warm();
        const media = navigator.mediaDevices;
        if (media?.getUserMedia === undefined) return { granted: false, canAskAgain: false };
        try {
          // Asking here surfaces the permission prompt before a recording is
          // expected to exist, and lets a denial read as a permission problem
          // instead of a failed recording.
          const probe = await media.getUserMedia({ audio: true });
          probe.getTracks().forEach((track) => track.stop());
          return { granted: true, canAskAgain: true };
        } catch (error) {
          const denied = error instanceof DOMException && error.name === "NotAllowedError";
          return { granted: false, canAskAgain: !denied };
        }
      },
      configureRecording: async () => {},
      releaseRecording: async () => {},
      deleteRecording: (uri) => live.deleteRecording(uri),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latest.current;
        const draft = current.readDraft();
        if (!draft || current.ownerKey === null) return null;
        if (
          previousDraft.current.ownerKey !== current.ownerKey ||
          previousDraft.current.text !== draft.text
        ) {
          previousDraft.current = { ownerKey: current.ownerKey, text: draft.text };
          revision.current += 1;
        }
        return {
          ownerKey: current.ownerKey,
          text: draft.text,
          selection: { start: draft.start, end: draft.end },
          revision: revision.current,
        };
      },
      commitDraft: (text, selection) => latest.current.commitDraft(text, selection.start),
      onStateChange: (next) => {
        // A new attempt starts clean; an error keeps the reason this attempt failed.
        if (next.phase === "preparing") lastFailure.current = null;
        setState(withVoiceFailure(next, lastFailure.current));
      },
    });
  }

  const ownerKey = input.ownerKey;
  const previousOwner = useRef(ownerKey);
  useEffect(() => {
    if (previousOwner.current === ownerKey) return;
    previousOwner.current = ownerKey;
    // A recording belongs to the draft it started in; switching threads drops it.
    controllerRef.current?.ownerChanged();
  }, [ownerKey]);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      liveRef.current?.recorder.release();
    },
    [],
  );

  // A moment after the final text lands the strip and the heard words fade out and the draft
  // turns black, as ChatGPT's do; the composer keeps them on screen that long (`stage`).
  const busy = state.phase === "preparing" || state.phase === "recording" || state.phase === "transcribing";
  const [settling, setSettling] = useState(false);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      setSettling(false);
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (state.phase === "error") return;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), LIVE_SETTLING_MS);
    return () => clearTimeout(timer);
  }, [busy, state.phase]);

  useEffect(() => {
    if (state.phase !== "recording") {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [state.phase]);

  return {
    state,
    elapsedSeconds,
    /** 0…1, the microphone right now; the waveform samples it. */
    readLevel: useCallback(() => liveRef.current?.recorder.level() ?? 0, []),
    liveDraft,
    /** `live` while dictation runs, `settling` for the moment its strip and words fade out after. */
    stage: busy ? ("live" as const) : settling ? ("settling" as const) : ("off" as const),
    /** The composer shows the heard words in place of the editor while this is true. */
    showsLive: busy || settling,
    start: useCallback(() => {
      setLiveDraft(latest.current.readDraft());
      void controllerRef.current?.start();
    }, []),
    stop: useCallback(() => void controllerRef.current?.stop(), []),
    cancel: useCallback(() => controllerRef.current?.cancel(), []),
  };
}
