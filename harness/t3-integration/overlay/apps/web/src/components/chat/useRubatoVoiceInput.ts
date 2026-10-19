import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createRubatoVoiceTranscriber,
  RubatoWebVoiceRecorder,
  type RubatoVoiceFailure,
} from "../../state/rubatoVoice";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

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
 * Dictation for one composer draft. The shared controller owns the phases; this
 * hook connects it to the Mac's voice service, to the microphone, and to the
 * draft the user is looking at.
 */
export function useRubatoVoiceInput(input: {
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly readDraft: () => RubatoVoiceDraft | null;
  readonly commitDraft: (text: string, cursor: number) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const latest = useRef(input);
  latest.current = input;
  const revision = useRef(0);
  const previousDraft = useRef<{ ownerKey: string | null; text: string }>({
    ownerKey: null,
    text: "",
  });
  const recorderRef = useRef<RubatoWebVoiceRecorder | null>(null);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const lastFailure = useRef<RubatoVoiceFailure | null>(null);

  if (!controllerRef.current) {
    const recorder = new RubatoWebVoiceRecorder((status) =>
      controllerRef.current?.handleRecorderStatus(status),
    );
    recorderRef.current = recorder;
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: () =>
        createRubatoVoiceTranscriber(
          () => latest.current.environmentId,
          (failure) => {
            lastFailure.current = failure;
          },
        ),
      requestPermission: async () => {
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
      releaseRecording: async () => {
        recorderRef.current?.release();
      },
      deleteRecording: (uri) => URL.revokeObjectURL(uri),
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

  useEffect(() => () => controllerRef.current?.dispose(), []);

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
    start: useCallback(() => void controllerRef.current?.start(), []),
    stop: useCallback(() => void controllerRef.current?.stop(), []),
    cancel: useCallback(() => controllerRef.current?.cancel(), []),
  };
}
