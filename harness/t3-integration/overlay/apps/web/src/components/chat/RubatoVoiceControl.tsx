import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function statusLabel(state: VoiceInputState, elapsedSeconds: number): string {
  switch (state.phase) {
    case "preparing":
      return "Preparing";
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    case "transcribing":
      return "Transcribing";
    default:
      return "";
  }
}

/**
 * Dictation in the composer toolbar. One control changes face with the phase:
 * a microphone while resting, a live status with stop and cancel while the
 * microphone is open, and the reason it stopped when something went wrong.
 */
export function RubatoVoiceControl(props: {
  readonly state: VoiceInputState;
  readonly elapsedSeconds: number;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const { state } = props;

  if (state.phase === "idle" || state.phase === "error") {
    return (
      <div className="flex min-w-0 items-center gap-1">
        {state.error === null ? null : (
          <span className="max-w-52 truncate text-destructive-foreground text-xs">
            {state.error}
          </span>
        )}
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
      <span className="shrink-0 text-secondary-label text-xs tabular-nums">
        {statusLabel(state, props.elapsedSeconds)}
      </span>
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
