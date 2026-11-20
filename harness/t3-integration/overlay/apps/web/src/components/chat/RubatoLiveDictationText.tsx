import { liveDictationDisplay } from "@t3tools/client-runtime/voice-input";
import { liveDictationPieces, liveDictationStore } from "@t3tools/shared/rubatoLiveDictation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import "./RubatoVoiceControl.css";

/**
 * What the composer shows in the editor's place while dictation runs, as ChatGPT does: the draft
 * and the words heard so far in grey, each new word fading in blue and fading to grey a moment
 * later on its own clock (liveDictationTint), the caret after them and kept in view. The words
 * stand where the final text will land (liveDictationDisplay). Once it lands (`settling`) the
 * committed draft turns from grey to the editor's ink, then the editor takes its place again.
 */
export function RubatoLiveDictationText(props: {
  readonly draft: { readonly text: string; readonly start: number; readonly end: number };
  readonly connecting: boolean;
  readonly settling: boolean;
  readonly committed: string;
}) {
  const snapshot = useSyncExternalStore(liveDictationStore.subscribe, liveDictationStore.snapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [snapshot]);
  const display = liveDictationDisplay(props.draft.text, props.draft, liveDictationPieces(snapshot), now);
  // One frame after another while some word still moves.
  useEffect(() => {
    if (!display.animating || props.settling) return;
    const frame = window.requestAnimationFrame(() => setNow(Date.now()));
    return () => window.cancelAnimationFrame(frame);
  }, [display.animating, now, props.settling]);
  // The committed draft starts grey and turns to ink on the next frame, so the colour transitions.
  const [ink, setInk] = useState(false);
  useEffect(() => {
    if (!props.settling) {
      setInk(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setInk(true));
    return () => window.cancelAnimationFrame(frame);
  }, [props.settling]);

  const caretRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    caretRef.current?.scrollIntoView({ block: "nearest" });
  }, [display.value]);

  const value = props.settling ? props.committed : display.value;
  const caret = props.settling ? value.length : display.selection.start;
  const parts: Array<ReactNode> = [];
  let cursor = 0;
  if (!props.settling) {
    for (const run of display.runs) {
      if (run.start >= caret) break;
      if (run.start > cursor) parts.push(value.slice(cursor, run.start));
      parts.push(
        <span
          key={run.start}
          style={{
            color: `color-mix(in oklab, var(--rubato-dictation-blue) ${Math.round(run.blue * 100)}%, currentColor)`,
            opacity: run.visible,
          }}
        >
          {value.slice(run.start, Math.min(run.end, caret))}
        </span>,
      );
      cursor = Math.min(run.end, caret);
    }
  }
  if (caret > cursor) parts.push(value.slice(cursor, caret));
  // The editor's own box (ComposerPromptEditorTiptap): the same font and size, so the words wrap
  // where they will wrap once the editor takes their place again.
  return (
    <div className="relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)">
    <div
      aria-live="polite"
      data-rubato-live-dictation=""
      className={cn(
        "rubato-live-dictation -m-1 block max-h-52 min-h-19.5 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word leading-relaxed transition-colors duration-150",
        ink ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {parts}
      <span ref={caretRef} className="rubato-live-dictation-caret" />
      {value.length === 0 ? (
        <span className="text-placeholder/75">{props.connecting ? "Connecting…" : "Listening…"}</span>
      ) : null}
      {value.slice(caret)}
    </div>
    </div>
  );
}
