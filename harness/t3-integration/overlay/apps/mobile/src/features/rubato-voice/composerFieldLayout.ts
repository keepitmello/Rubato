// Rubato: the arithmetic behind the phone composers' Rubato pieces, kept apart from React so it can
// be tested.
//
// T3's native editor (T3ComposerEditorView.emitContentSizeIfNeeded) reports its text's height
// without the vertical insets and never more than four lines, so a field sized from it must add the
// insets back, cannot grow past four lines, and reads a report of four full lines as "there may be
// more".
import type { LiveDictationRun } from "@t3tools/client-runtime/voice-input";

/** The most lines T3's native editor reports. */
export const NATIVE_MEASURED_LINES = 4;

export function composerFieldHeight(input: {
  /** onContentSizeChange's height: the text alone, at most NATIVE_MEASURED_LINES lines. */
  readonly contentHeight: number;
  readonly lineHeight: number;
  /** The editor's contentInsetVertical, above and below the text. */
  readonly inset: number;
  readonly minLines: number;
  readonly maxLines: number;
}): { readonly height: number; readonly overflows: boolean } {
  const { contentHeight, lineHeight, inset } = input;
  const lines = Math.min(input.maxLines, NATIVE_MEASURED_LINES);
  const minHeight = input.minLines * lineHeight + inset * 2;
  const maxHeight = lines * lineHeight + inset * 2;
  const height = Math.min(maxHeight, Math.max(minHeight, Math.ceil(contentHeight) + inset * 2));
  const overflows =
    contentHeight > lines * lineHeight + 0.5 ||
    (lines === NATIVE_MEASURED_LINES && contentHeight >= lines * lineHeight - 0.5);
  return { height, overflows };
}

export type LiveWordsSegment = {
  readonly text: string;
  /** null: the plain grey of the rest; otherwise this stretch's own tint (liveDictationTint). */
  readonly tint: { readonly visible: number; readonly blue: number } | null;
};

/** `value` cut at the runs' edges, each stretch with its tint, for drawing as nested Text. */
export function liveWordsSegments(value: string, runs: ReadonlyArray<LiveDictationRun>): LiveWordsSegment[] {
  const segments: LiveWordsSegment[] = [];
  let cursor = 0;
  for (const run of [...runs].sort((left, right) => left.start - right.start)) {
    const start = Math.max(cursor, Math.min(value.length, run.start));
    const end = Math.max(start, Math.min(value.length, run.end));
    if (start > cursor) segments.push({ text: value.slice(cursor, start), tint: null });
    if (end > start) segments.push({ text: value.slice(start, end), tint: { visible: run.visible, blue: run.blue } });
    cursor = end;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), tint: null });
  return segments;
}
