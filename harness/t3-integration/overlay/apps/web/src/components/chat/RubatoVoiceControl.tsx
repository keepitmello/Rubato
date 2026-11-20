import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon, SettingsIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const WAVE_BAR_GAP = 3;
const WAVE_SAMPLE_MS = 80;

/**
 * The microphone as bars that enter on the right and drift left, over a dotted line where it was
 * quiet: ChatGPT's dictation strip. Frozen while the final text arrives; a plain dotted line
 * while connecting.
 */
function DictationWave(props: { readonly readLevel: () => number; readonly live: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levels = useRef<number[]>([]);
  const { readLevel, live } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
      if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      const count = Math.floor(width / WAVE_BAR_GAP);
      const history = levels.current;
      for (let index = 0; index < count; index += 1) {
        const level = history[history.length - count + index] ?? 0;
        // Speech sits around 0.05–0.3 on WebRTC's scale; the square root lifts quiet words.
        const bar = Math.min(height, Math.max(1.5, Math.sqrt(level) * height * 1.6));
        context.globalAlpha = level > 0.01 ? 0.9 : 0.35;
        context.fillRect(index * WAVE_BAR_GAP, (height - bar) / 2, 1.5, bar);
      }
    };
    draw();
    if (!live) return;
    const timer = window.setInterval(() => {
      levels.current = [...levels.current.slice(-400), readLevel()];
      draw();
    }, WAVE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [live, readLevel]);
  useEffect(() => () => {
    levels.current = [];
  }, []);
  return <canvas ref={canvasRef} aria-hidden className="h-6 w-28 shrink text-foreground sm:w-36" />;
}

/**
 * Dictation in the composer toolbar. One control changes face with the phase:
 * a microphone while resting; cancel, the live waveform and stop while the
 * microphone is open (a spinner in stop's place while connecting and while the
 * final text arrives); and the reason it stopped when something went wrong.
 */
export function RubatoVoiceControl(props: {
  readonly state: VoiceInputState;
  readonly readLevel: () => number;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const { state } = props;
  const navigate = useNavigate();

  if (state.phase === "idle" || state.phase === "error") {
    return (
      <div className="flex min-w-0 items-center gap-1">
        {state.error === null ? null : (
          <span className="max-w-52 truncate text-destructive-foreground text-xs" title={state.error}>
            {state.error}
          </span>
        )}
        {state.errorAction === "settings" ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void navigate({ to: "/settings/chat", hash: "rubato-voice" })}
          >
            <SettingsIcon />
            Voice settings
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onStart}
                aria-label="Dictate"
              />
            }
          >
            <MicIcon />
          </TooltipTrigger>
          <TooltipPopup>Dictate</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onCancel}
              aria-label="Cancel dictation"
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup>Cancel dictation</TooltipPopup>
      </Tooltip>
      <DictationWave readLevel={props.readLevel} live={state.phase === "recording"} />
      {state.phase === "recording" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onStop}
                aria-label="Finish dictation"
              />
            }
          >
            <SquareIcon />
          </TooltipTrigger>
          <TooltipPopup>Finish dictation</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="flex size-8 items-center justify-center sm:size-7">
          <Spinner className="size-4" />
        </span>
      )}
    </div>
  );
}
