import { liveDictationDisplay } from "@t3tools/client-runtime/voice-input";
import {
  liveDictationStore,
  liveDictationView,
  LIVE_FRESH_MS,
} from "@t3tools/shared/rubatoLiveDictation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * What the composer shows in the editor's place while dictation runs, as ChatGPT does: the draft
 * and the words heard so far in grey, the words that just arrived in blue, the caret after them
 * and kept in view. The words stand where the final text will land (liveDictationDisplay). The
 * editor itself stays hidden and untouched until the final text is committed into it.
 */
export function RubatoLiveDictationText(props: {
  readonly draft: { readonly text: string; readonly start: number; readonly end: number };
  readonly connecting: boolean;
}) {
  const snapshot = useSyncExternalStore(liveDictationStore.subscribe, liveDictationStore.snapshot);
  const [now, setNow] = useState(() => Date.now());
  const { settled, fresh } = liveDictationView(snapshot, now);
  // Blue fades to grey a moment after the last word: tick only while something is still blue.
  useEffect(() => {
    if (fresh.length === 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), LIVE_FRESH_MS / 4);
    return () => window.clearTimeout(timer);
  }, [fresh, now, snapshot]);
  useEffect(() => setNow(Date.now()), [snapshot]);

  const caretRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    caretRef.current?.scrollIntoView({ block: "nearest" });
  }, [settled, fresh]);

  const display = liveDictationDisplay(props.draft.text, props.draft, { settled, fresh });
  const { value } = display;
  const { freshStart, end } = display.dictation;
  const heard = settled + fresh;
  return (
    <div
      aria-live="polite"
      data-rubato-live-dictation=""
      className="-m-1 block max-h-52 min-h-19.5 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word leading-relaxed text-muted-foreground"
    >
      {value.slice(0, freshStart)}
      {end > freshStart ? (
        <span className="text-blue-500 dark:text-blue-400">{value.slice(freshStart, end)}</span>
      ) : null}
      <span
        ref={caretRef}
        className="ms-px inline-block h-[1.1em] w-0.5 translate-y-[0.2em] animate-pulse bg-blue-500 dark:bg-blue-400"
      />
      {heard.length === 0 && value.length === 0 ? (
        <span className="text-placeholder/75">{props.connecting ? "Connecting…" : "Listening…"}</span>
      ) : null}
      {value.slice(end)}
    </div>
  );
}
