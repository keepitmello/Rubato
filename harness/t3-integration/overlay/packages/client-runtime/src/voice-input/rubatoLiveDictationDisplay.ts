// Rubato: what a composer shows while live dictation runs (@t3tools/shared/rubatoLiveDictation):
// the draft with the words heard so far placed where this controller will put the final text at
// stop, the caret after them, and for each word how visible and how blue it is now (the rest reads
// grey). The phone hands it to its editor (T3ComposerEditorView `dictationJson`); the desktop draws
// it in the editor's place (RubatoLiveDictationText). Both place the words with
// resolveTranscriptCommit, so nothing moves when the final text lands.
import { LIVE_SETTLE_MS, liveDictationTint } from "@t3tools/shared/rubatoLiveDictation";

import { resolveTranscriptCommit } from "./controller.ts";

type ComposerEditorSelection = { readonly start: number; readonly end: number };

/** A stretch of `value` that is not plain grey: `visible` and `blue` are 0…1 (liveDictationTint). */
export type LiveDictationRun = {
  readonly start: number;
  readonly end: number;
  readonly visible: number;
  readonly blue: number;
};

export type LiveDictationDisplay = {
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  /** Where the heard words stand in `value`. */
  readonly heard: { readonly start: number; readonly end: number };
  readonly runs: ReadonlyArray<LiveDictationRun>;
  /** Some word is still moving: draw again soon. */
  readonly animating: boolean;
};

/** `pieces` come from liveDictationPieces: the heard words as they arrived. */
export function liveDictationDisplay(
  draft: string,
  selection: ComposerEditorSelection,
  pieces: ReadonlyArray<{ readonly text: string; readonly at: number | null }>,
  now: number,
): LiveDictationDisplay {
  const text = pieces.map((piece) => piece.text).join("");
  const snapshot = { ownerKey: "live", text: draft, selection, revision: 0 };
  // The same placement the final text gets at stop, spacing included.
  const placed = resolveTranscriptCommit(snapshot, snapshot, text, /[가-힣]/.test(text) ? "ko" : "en");
  if (placed.kind !== "commit") {
    const at = Math.min(selection.end, draft.length);
    return { value: draft, selection, heard: { start: at, end: at }, runs: [], animating: false };
  }
  const inserted = text.trim();
  const tail = draft.length - Math.min(draft.length, selection.end);
  const end = placed.text.lastIndexOf(inserted, placed.text.length - tail) + inserted.length;
  const start = end - inserted.length;
  const lead = text.length - text.trimStart().length;
  const runs: Array<LiveDictationRun> = [];
  let animating = false;
  let offset = 0;
  for (const piece of pieces) {
    const from = Math.max(start, start + offset - lead);
    const to = Math.min(end, start + offset + piece.text.length - lead);
    offset += piece.text.length;
    if (piece.at === null || to <= from) continue;
    const age = now - piece.at;
    if (age < LIVE_SETTLE_MS) animating = true;
    const tint = liveDictationTint(age);
    if (tint.blue > 0 || tint.visible < 1) runs.push({ start: from, end: to, ...tint });
  }
  return { value: placed.text, selection: { start: end, end }, heard: { start, end }, runs, animating };
}
