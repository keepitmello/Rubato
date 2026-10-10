/**
 * The composer of a conversation opened inside the right panel (a side chat, an agent's
 * session). It wears the thread composer's own parts, the rounded glass surface
 * (chat/ComposerSurface.tsx) and the round send and stop buttons (chat/ComposerPrimaryActions.tsx),
 * so the panel reads as the same app; it only keeps a plain text field, since what is sent here
 * has no attachments, mentions or commands.
 */
import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ComposerPrimaryActions } from "./chat/ComposerPrimaryActions";
import { ComposerSurface } from "./chat/ComposerSurface";

/** The thread composer's prompt grows to this height (max-h-52), then scrolls. */
const MAX_HEIGHT_PX = 208;
const ignore = () => undefined;

export function RubatoPanelComposer({
  value,
  onChange,
  onSend,
  onStop,
  placeholder,
  ariaLabel,
  hint,
  error,
  running = false,
  sending = false,
  canSend = true,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Offered while `running`; without it a running conversation shows no Stop. */
  onStop?: (() => void) | undefined;
  placeholder: string;
  ariaLabel: string;
  /** A quiet line on the left of the buttons, where the thread composer keeps its controls. */
  hint?: ReactNode;
  error?: string | null;
  running?: boolean;
  sending?: boolean;
  /** False when the draft cannot be sent now, though it can be written. */
  canSend?: boolean;
  disabled?: boolean;
}) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const sendable = !disabled && canSend && value.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (sendable && !sending) onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (sendable && !sending) onSend();
  };

  return (
    <div className="shrink-0 px-2 pt-1 pb-2 sm:px-3 sm:pb-3">
      {error ? <p className="px-3 pb-1.5 text-xs text-destructive-foreground">{error}</p> : null}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <form onSubmit={submit} className="rounded-3xl" data-rubato-panel-composer="true">
              <div className="px-3 pt-3 pb-1.5 sm:px-4">
                <textarea
                  ref={fieldRef}
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={placeholder}
                  aria-label={ariaLabel}
                  disabled={disabled}
                  rows={1}
                  className={cn(
                    "block max-h-52 min-h-12 w-full resize-none overflow-y-auto bg-transparent leading-relaxed text-foreground outline-none",
                    "font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
                    "placeholder:text-placeholder/75 disabled:cursor-not-allowed disabled:opacity-64",
                  )}
                />
              </div>
              <div className="flex min-w-0 items-center gap-2 px-3 pb-3 sm:px-4">
                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">{hint}</div>
                <div className="flex shrink-0 items-center gap-2">
                  <ComposerPrimaryActions
                    compact
                    pendingAction={null}
                    isRunning={running && onStop !== undefined}
                    showPlanFollowUpPrompt={false}
                    promptHasText={value.trim().length > 0}
                    isSendBusy={sending}
                    sendDisabledReason={null}
                    isConnecting={false}
                    isEnvironmentUnavailable={disabled}
                    isPreparingWorktree={false}
                    hasSendableContent={sendable}
                    onPreviousPendingQuestion={ignore}
                    onInterrupt={onStop ?? ignore}
                    onImplementPlanInNewThread={ignore}
                  />
                </div>
              </div>
            </form>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
