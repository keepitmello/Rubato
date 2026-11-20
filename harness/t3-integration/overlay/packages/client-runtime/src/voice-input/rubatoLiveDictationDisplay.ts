// Rubato: what a composer shows while live dictation runs (@t3tools/shared/rubatoLiveDictation):
// the draft with the words heard so far placed where this controller will put the final text at
// stop, the caret after them, and the range to paint blue (the rest reads grey). The phone hands
// it to its editor (T3ComposerEditorView `dictationJson`); the desktop draws it in the editor's
// place (RubatoLiveDictationText). Both place the words with resolveTranscriptCommit, so nothing
// moves when the final text lands.
import { resolveTranscriptCommit } from "./controller.ts";

type ComposerEditorSelection = { readonly start: number; readonly end: number };

export type LiveDictationDisplay = {
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly dictation: { readonly freshStart: number; readonly end: number };
};

/** `settled` and `fresh` come from liveDictationView: the heard words, the new ones last. */
export function liveDictationDisplay(
  draft: string,
  selection: ComposerEditorSelection,
  heard: { readonly settled: string; readonly fresh: string },
): LiveDictationDisplay {
  const text = `${heard.settled}${heard.fresh}`;
  const snapshot = { ownerKey: "live", text: draft, selection, revision: 0 };
  // The same placement the final text gets at stop, spacing included.
  const placed = resolveTranscriptCommit(snapshot, snapshot, text, /[가-힣]/.test(text) ? "ko" : "en");
  if (placed.kind !== "commit") {
    const end = Math.min(selection.end, draft.length);
    return { value: draft, selection, dictation: { freshStart: end, end } };
  }
  const inserted = text.trim();
  const tail = draft.length - Math.min(draft.length, selection.end);
  const insertedEnd = placed.text.lastIndexOf(inserted, placed.text.length - tail) + inserted.length;
  const fresh = Math.min(inserted.length, heard.fresh.trimEnd().length);
  return {
    value: placed.text,
    selection: { start: insertedEnd, end: insertedEnd },
    dictation: { freshStart: insertedEnd - fresh, end: insertedEnd },
  };
}
