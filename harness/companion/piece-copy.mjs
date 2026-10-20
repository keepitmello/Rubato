// What each of Segno's prompt pieces is for, in one place: Settings › Companion shows it beside each
// piece, and Segno reads it from companion_settings `show` (settings.mjs), so the two never differ.
export const PIECE_COPY = Object.freeze({
  preamble: Object.freeze({ title: 'Preamble', description: 'The first words Segno reads: its name and its welcome.' }),
  soul: Object.freeze({ title: 'Soul', description: 'Who Segno is and how it speaks.' }),
  identity: Object.freeze({ title: 'Identity', description: 'Name, look and what stays the same.' }),
  user: Object.freeze({ title: 'About you', description: 'Your business, your repositories, how you like to be told things.' }),
  companion: Object.freeze({ title: 'How Segno works', description: 'Leads, approvals, reports, heartbeat.' }),
  tools: Object.freeze({ title: 'Tools', description: 'The tools Segno has. It follows Rubato and cannot be changed.' }),
  memory: Object.freeze({ title: 'Resident memory', description: "What Segno always carries. Its night dream keeps this in memory/MEMORY.md." }),
  coda: Object.freeze({ title: 'Closing lines', description: "The last words of Segno's prompt, after everything else." }),
});

/** A piece with its title and what it is for. */
export const withCopy = (piece) => ({ ...piece, ...(PIECE_COPY[piece.id] ?? { title: piece.id, description: '' }) });
