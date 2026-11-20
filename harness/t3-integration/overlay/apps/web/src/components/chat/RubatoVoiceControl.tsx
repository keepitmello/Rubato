import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { MicIcon, SettingsIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import "./RubatoVoiceControl.css";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const WAVE_GAP = 4;
const WAVE_SAMPLE_MS = 80;
/** The microphone's level (loudest sample, 0…1) below which it counts as quiet and draws a dot. */
const WAVE_QUIET = 0.02;

/**
 * The microphone as ChatGPT draws it: bars for sound and dots for quiet, entering on the right and
 * gliding left every frame. It keeps gliding (with quiet) while the final text comes, so the strip
 * does not freeze on stop; `sampling` is whether the microphone is read at all.
 */
function DictationWave(props: { readonly readLevel: () => number; readonly sampling: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levels = useRef<number[]>([]);
  const sampling = useRef(props.sampling);
  sampling.current = props.sampling;
  const readLevel = useRef(props.readLevel);
  readLevel.current = props.readLevel;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let last = performance.now();
    let frame = 0;
    const draw = (time: number) => {
      while (time - last >= WAVE_SAMPLE_MS) {
        last += WAVE_SAMPLE_MS;
        levels.current.push(sampling.current ? readLevel.current() : 0);
        if (levels.current.length > 400) levels.current.splice(0, levels.current.length - 400);
      }
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
      if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (context) {
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        const color = getComputedStyle(canvas).color;
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineCap = "round";
        context.lineWidth = 2;
        const glide = ((time - last) / WAVE_SAMPLE_MS) * WAVE_GAP;
        const history = levels.current;
        const count = Math.ceil(width / WAVE_GAP) + 1;
        for (let index = 0; index < count; index += 1) {
          const level = history[history.length - 1 - index];
          const x = width - 2 - index * WAVE_GAP - glide;
          if (x < -WAVE_GAP) break;
          if (level === undefined || level < WAVE_QUIET) {
            context.globalAlpha = 0.4;
            context.beginPath();
            context.arc(x, height / 2, 1, 0, Math.PI * 2);
            context.fill();
            continue;
          }
          // Speech sits around 0.05–0.3 on this scale; the square root lifts quiet words.
          const bar = Math.min(height - 2, Math.max(4, Math.sqrt(level) * height * 1.5));
          context.globalAlpha = 0.85;
          context.beginPath();
          context.moveTo(x, (height - bar) / 2 + 1);
          context.lineTo(x, (height + bar) / 2 - 1);
          context.stroke();
        }
      }
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={canvasRef} aria-hidden className="rubato-voice-wave h-6 w-28 shrink text-foreground sm:w-40" />;
}

/**
 * Dictation in the composer toolbar. One control changes face with the phase:
 * a microphone while resting; cancel, the live waveform and stop while the
 * microphone is open (a spinner in stop's place while connecting and while the
 * final text arrives); and the reason it stopped when something went wrong.
 */
export function RubatoVoiceControl(props: {
  readonly state: VoiceInputState;
  /** useRubatoVoiceInput's stage: the strip stays a moment after the final text lands, fading out. */
  readonly stage: "live" | "settling" | "off";
  readonly readLevel: () => number;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const { state } = props;
  const navigate = useNavigate();
  // The microphone pops back in after a dictation, not on every first render.
  const returning = useRef(false);
  useEffect(() => {
    if (props.stage !== "off") returning.current = true;
    else {
      const timer = setTimeout(() => {
        returning.current = false;
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [props.stage]);

  if (props.stage === "off") {
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
            onClick={() => void navigate({ to: "/settings/voice", hash: "rubato-voice" })}
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
                className={cn("rubato-voice-mic", returning.current && "is-returning")}
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

  // The spinner stands for the final text on its way; while connecting, stop shows (disabled).
  const transcribing = state.phase === "transcribing" || props.stage === "settling";
  return (
    <div className={cn("rubato-voice-strip flex min-w-0 items-center gap-1", props.stage === "settling" && "is-leaving")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rubato-voice-x"
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
      <DictationWave readLevel={props.readLevel} sampling={state.phase === "recording"} />
      <span className={cn("rubato-voice-stop-slot flex size-8 items-center justify-center sm:size-7", transcribing && "is-busy")}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rubato-voice-stop"
                disabled={state.phase !== "recording"}
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onStop}
                aria-label="Finish dictation"
              />
            }
          >
            <SquareIcon className="fill-current" />
          </TooltipTrigger>
          <TooltipPopup>Finish dictation</TooltipPopup>
        </Tooltip>
        <Spinner className="rubato-voice-spinner size-4" />
      </span>
    </div>
  );
}
